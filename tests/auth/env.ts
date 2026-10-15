import { createHmac, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { ProductAuth, type TokenSet } from "../../src/auth/product-auth.js";
import { SecretBox, Signer } from "../../src/auth/crypto.js";
import { challengeS256, generateVerifier } from "../../src/auth/pkce.js";
import { StreamService, ZoomWebhookVerifier, type RtmsStarter } from "../../src/auth/streams.js";
import { DEFAULT_ZOOM_SCOPES, ZoomLinkService } from "../../src/auth/zoom-link.js";
import { ZoomUpstreamError, type ZoomClient, type ZoomProfile, type ZoomTokenResponse } from "../../src/auth/zoom-client.js";
import type { Clock } from "../../src/auth/errors.js";
import { freshDb } from "../db/helpers.js";

export class TestClock implements Clock {
  constructor(public t = new Date("2026-01-01T10:00:00Z")) {}
  now() { return new Date(this.t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}

/** In-memory Zoom that behaves like the real one where it matters: PKCE, single-use codes, refresh-token ROTATION. */
export class FakeZoom implements ZoomClient {
  private n = 0;
  codes = new Map<string, { challenge: string; user: ZoomProfile; scope: string; used: boolean }>();
  accessTokens = new Map<string, ZoomProfile>();
  validRefresh = new Map<string, ZoomProfile>();
  hosts = new Map<string, string>(); // meeting uuid -> host zoom id
  calls = { exchange: 0, refresh: 0, revoke: [] as string[], getMe: 0 };
  refreshDelayMs = 0;
  failRefresh: ZoomUpstreamError | null = null;
  failRevoke = false;
  scopeOverride: string | null = null;
  meOverride: ZoomProfile | null = null;

  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }) {
    return `https://zoom.test/oauth/authorize?state=${p.state}&code_challenge=${p.codeChallenge}&redirect_uri=${encodeURIComponent(p.redirectUri)}`;
  }
  /** The human consents in the browser: returns the `code` Zoom would redirect back with. */
  consent(authorizeUrl: string, user: ZoomProfile): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    const code = `ZC_${++this.n}`;
    this.codes.set(code, { challenge: u.searchParams.get("code_challenge")!, user, scope: this.scopeOverride ?? DEFAULT_ZOOM_SCOPES.join(" "), used: false });
    return { code, state: u.searchParams.get("state")! };
  }
  private issue(user: ZoomProfile, scope: string): ZoomTokenResponse {
    const access = `ZT_A_${++this.n}`, refresh = `ZT_R_${++this.n}`;
    this.accessTokens.set(access, user);
    this.validRefresh.set(refresh, user);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, scope };
  }
  async exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }) {
    this.calls.exchange++;
    const c = this.codes.get(p.code);
    if (!c || c.used) throw new ZoomUpstreamError(400, "invalid_grant");
    c.used = true;
    if (challengeS256(p.codeVerifier) !== c.challenge) throw new ZoomUpstreamError(400, "invalid_grant");
    return this.issue(c.user, c.scope);
  }
  async refresh(rt: string) {
    this.calls.refresh++;
    if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.failRefresh) throw this.failRefresh;
    const user = this.validRefresh.get(rt);
    if (!user) throw new ZoomUpstreamError(400, "invalid_grant"); // rotated or revoked
    this.validRefresh.delete(rt);
    return this.issue(user, DEFAULT_ZOOM_SCOPES.join(" "));
  }
  async revoke(token: string) {
    this.calls.revoke.push(token);
    if (this.failRevoke) throw new ZoomUpstreamError(503);
    this.accessTokens.delete(token);
    this.validRefresh.delete(token);
  }
  async getMe(accessToken: string) {
    this.calls.getMe++;
    if (this.meOverride) return this.meOverride;
    const u = this.accessTokens.get(accessToken);
    if (!u) throw new ZoomUpstreamError(401);
    return u;
  }
  async getMeetingRole(_t: string, meetingUuid: string, me: ZoomProfile) {
    return this.hosts.get(meetingUuid) === me.id ? ("host" as const) : ("none" as const);
  }
}

export const WEBHOOK_SECRET = "synthetic-webhook-secret";
export const signZoom = (body: string, ts: number, secret = WEBHOOK_SECRET) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

export const CLIENT = "alfred-macos";
export const REDIRECT = "com.alfred.app:/callback";

export async function mkEnv() {
  const db = await freshDb();
  const clock = new TestClock();
  const zoom = new FakeZoom();
  const k1 = randomBytes(32), k2 = randomBytes(32);
  const box = new SecretBox({ k1 }, "k1");
  const signer = new Signer({ s1: randomBytes(32) }, "s1");
  const auth = new ProductAuth(db, { clients: { [CLIENT]: { redirectUris: [REDIRECT, "http://127.0.0.1:53682/cb"] } } }, clock);
  const links = new ZoomLinkService(db, zoom, box, { redirectUri: "https://api.alfred.test/v1/zoom/link/callback" }, clock);
  const streams = new StreamService(db, signer, links, zoom, clock);
  const webhook = new ZoomWebhookVerifier(WEBHOOK_SECRET, clock);
  const started: Array<{ meetingUuid: string; zoomUserId: string; accessToken: string }> = [];
  const rtms: RtmsStarter = { start: async (a) => void started.push(a) };
  return { db, clock, zoom, box, signer, auth, links, streams, webhook, rtms, started, k2 };
}
export type Env = Awaited<ReturnType<typeof mkEnv>>;

/** Full product login via PKCE; returns tokens + user id. */
export async function login(env: Env, subject = `idp-${randomUUID()}`): Promise<{ tokens: TokenSet; ownerId: string; verifier: string }> {
  const ownerId = await env.auth.resolveUser("test-idp", subject);
  const verifier = generateVerifier();
  const code = await env.auth.issueCode({ ownerId, clientId: CLIENT, redirectUri: REDIRECT, codeChallenge: challengeS256(verifier), codeChallengeMethod: "S256" });
  const tokens = await env.auth.exchangeCode({ code, codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT });
  return { tokens, ownerId, verifier };
}

let z = 0;
export const zoomUser = (): ZoomProfile => ({ id: `zu_${++z}_${randomUUID().slice(0, 6)}`, account_id: "acct_synthetic" });

/** Product login + complete Zoom linking. */
export async function loginAndLink(env: Env, zu = zoomUser()) {
  const l = await login(env);
  const { principal } = { principal: await env.auth.authenticate(l.tokens.access_token) };
  const { authorize_url } = await env.links.startLink(l.ownerId, principal.sessionId);
  const { code, state } = env.zoom.consent(authorize_url, zu);
  await env.links.completeLink({ ownerId: l.ownerId, sessionId: principal.sessionId, state, code });
  return { ...l, sessionId: principal.sessionId, zu };
}

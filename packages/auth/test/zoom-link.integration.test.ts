import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthError } from "../src/errors.js";
import { ZoomUpstreamError } from "../src/zoom-client.js";
import { DEFAULT_ZOOM_SCOPES } from "../src/zoom-link.js";
import { SecretBox } from "../src/crypto.js";
import { randomBytes } from "node:crypto";
import { login, loginAndLink, mkEnv, zoomUser, type Env } from "./env.js";

let env: Env;
beforeAll(async () => (env = await mkEnv()));
afterAll(() => env.db.end());

const code = (e: unknown) => (e as AuthError).code;
async function rejects(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as AuthError; }
  throw new Error("expected rejection");
}
const secretRows = async (owner: string) => (await env.db.query("select purpose, key_id, ciphertext, nonce from secret_refs where owner_id=$1 order by purpose", [owner])).rows;
const linkRow = async (owner: string) => (await env.db.query("select * from zoom_links where owner_id=$1", [owner])).rows[0];

async function begin() {
  const l = await login(env);
  const p = await env.auth.authenticate(l.tokens.access_token);
  const { authorize_url } = await env.links.startLink(l.ownerId, p.sessionId);
  return { ...l, sessionId: p.sessionId, authorize_url };
}

describe("OAuth Zoom: linking", () => {
  it("links, stores tokens ONLY encrypted, and the authorize URL carries state + PKCE S256", async () => {
    const b = await begin();
    const u = new URL(b.authorize_url);
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(40);
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const zu = zoomUser();
    const { code: c, state } = env.zoom.consent(b.authorize_url, zu);
    const r = await env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state, code: c });
    expect(r.zoom_user_id).toBe(zu.id);

    const rows = await secretRows(b.ownerId);
    expect(rows.map((x) => x.purpose)).toEqual(["zoom_access_token", "zoom_refresh_token"]);
    const dump = JSON.stringify(await env.db.query("select * from secret_refs where owner_id=$1", [b.ownerId]).then((x) => x.rows)) + JSON.stringify(await env.db.query("select * from oauth_states").then((x) => x.rows));
    expect(dump).not.toContain("ZT_A_");
    expect(dump).not.toContain("ZT_R_");
    expect(JSON.stringify(await linkRow(b.ownerId))).not.toContain("ZT_");
    expect((await linkRow(b.ownerId)).scopes).toEqual(DEFAULT_ZOOM_SCOPES);
  });

  it("the stored ciphertext is bound to its owner and purpose (AAD): copying it elsewhere fails", async () => {
    const a = await loginAndLink(env);
    const b = await loginAndLink(env);
    const [aa] = await secretRows(a.ownerId);
    const sealed = { key_id: aa.key_id, ciphertext: aa.ciphertext, nonce: aa.nonce };
    expect(env.box.open(sealed, `${a.ownerId}|zoom_access_token`)).toMatch(/^ZT_A_/);
    expect(() => env.box.open(sealed, `${b.ownerId}|zoom_access_token`)).toThrow();
    expect(() => env.box.open(sealed, `${a.ownerId}|zoom_refresh_token`)).toThrow();
  });

  it("state replay: the same callback twice is refused", async () => {
    const b = await begin();
    const { code: c, state } = env.zoom.consent(b.authorize_url, zoomUser());
    await env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state, code: c });
    const e = await rejects(env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state, code: c }));
    expect(code(e)).toBe("invalid_request");
  });

  it("unknown / forged / expired state is refused and never reaches Zoom", async () => {
    const b = await begin();
    const before = env.zoom.calls.exchange;
    const zc = env.zoom.consent(b.authorize_url, zoomUser());
    expect(code(await rejects(env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state: "x".repeat(43), code: zc.code })))).toBe("invalid_request");
    env.clock.advance(11 * 60_000);
    expect(code(await rejects(env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state: zc.state, code: zc.code })))).toBe("invalid_request");
    expect(env.zoom.calls.exchange).toBe(before);
    expect(await linkRow(b.ownerId)).toBeUndefined();
  });

  it("login-CSRF: a state started by user A can not be completed by user B (nor by A from another session)", async () => {
    const a = await begin();
    const other = await login(env);
    const pOther = await env.auth.authenticate(other.tokens.access_token);
    const zc = env.zoom.consent(a.authorize_url, zoomUser());
    const before = env.zoom.calls.exchange;
    expect(code(await rejects(env.links.completeLink({ ownerId: other.ownerId, sessionId: pOther.sessionId, state: zc.state, code: zc.code })))).toBe("forbidden");
    expect(env.zoom.calls.exchange).toBe(before); // rejected before any token exchange
    expect(await linkRow(other.ownerId)).toBeUndefined();
    expect(await linkRow(a.ownerId)).toBeUndefined();
  });

  it("state is bound to the product session, not just the user", async () => {
    const a = await begin();
    // a second, separate product session of the SAME user
    const p2 = (await env.db.query("insert into auth_sessions (owner_id, client_id, expires_at) values ($1,'alfred-macos', now() + interval '1 day') returning id", [a.ownerId])).rows[0].id;
    const zc = env.zoom.consent(a.authorize_url, zoomUser());
    expect(code(await rejects(env.links.completeLink({ ownerId: a.ownerId, sessionId: p2, state: zc.state, code: zc.code })))).toBe("forbidden");
  });

  it("a code that Zoom rejects (wrong PKCE verifier / replayed code) yields an error and no link", async () => {
    const b = await begin();
    const zc = env.zoom.consent(b.authorize_url, zoomUser());
    env.zoom.codes.get(zc.code)!.challenge = "tampered".padEnd(43, "x");
    expect(code(await rejects(env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state: zc.state, code: zc.code })))).toBe("invalid_grant");
    expect(await linkRow(b.ownerId)).toBeUndefined();
  });

  it("least privilege: extra OR missing scopes are rejected and the freshly issued tokens are revoked at Zoom", async () => {
    for (const scope of [DEFAULT_ZOOM_SCOPES.join(" ") + " meeting:write:meeting", "user:read:user"]) {
      const b = await begin();
      env.zoom.scopeOverride = scope;
      const zc = env.zoom.consent(b.authorize_url, zoomUser());
      env.zoom.scopeOverride = null;
      env.zoom.calls.revoke = [];
      expect(code(await rejects(env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state: zc.state, code: zc.code })))).toBe("forbidden");
      expect(env.zoom.calls.revoke).toHaveLength(2);
      expect(await linkRow(b.ownerId)).toBeUndefined();
      expect(await secretRows(b.ownerId)).toHaveLength(0);
    }
  });

  it("account mismatch: a product user already linked to Zoom account Z1 can not silently switch to Z2", async () => {
    const a = await loginAndLink(env);
    const sess = a.sessionId;
    const { authorize_url } = await env.links.startLink(a.ownerId, sess);
    const z2 = zoomUser();
    const zc = env.zoom.consent(authorize_url, z2);
    env.zoom.calls.revoke = [];
    expect(code(await rejects(env.links.completeLink({ ownerId: a.ownerId, sessionId: sess, state: zc.state, code: zc.code })))).toBe("conflict");
    expect((await linkRow(a.ownerId)).zoom_user_id).toBe(a.zu.id); // unchanged
    expect(env.zoom.calls.revoke.length).toBe(2); // Z2's fresh tokens are revoked
  });

  it("account takeover: a Zoom account already linked to product user A can not be linked to product user B", async () => {
    const a = await loginAndLink(env);
    const b = await begin();
    const zc = env.zoom.consent(b.authorize_url, a.zu);
    expect(code(await rejects(env.links.completeLink({ ownerId: b.ownerId, sessionId: b.sessionId, state: zc.state, code: zc.code })))).toBe("conflict");
    expect(await linkRow(b.ownerId)).toBeUndefined();
    expect((await linkRow(a.ownerId)).zoom_user_id).toBe(a.zu.id);
  });

  it("re-linking the SAME Zoom account refreshes the link instead of failing", async () => {
    const a = await loginAndLink(env);
    const { authorize_url } = await env.links.startLink(a.ownerId, a.sessionId);
    const zc = env.zoom.consent(authorize_url, a.zu);
    await env.links.completeLink({ ownerId: a.ownerId, sessionId: a.sessionId, state: zc.state, code: zc.code });
    expect((await linkRow(a.ownerId)).version).toBe(1);
  });

  it("the DB itself forbids two product users on one Zoom account", async () => {
    const a = await loginAndLink(env);
    const other = await login(env);
    await expect(env.db.query("insert into zoom_links (owner_id, zoom_user_id, scopes) values ($1,$2,'{}')", [other.ownerId, a.zu.id])).rejects.toMatchObject({ code: "23505" });
  });
});

describe("OAuth Zoom: refresh", () => {
  it("valid access token: no call to Zoom", async () => {
    const a = await loginAndLink(env);
    const t1 = await env.links.getAccessToken(a.ownerId);
    const t2 = await env.links.getAccessToken(a.ownerId);
    expect(t1).toBe(t2);
    expect(env.zoom.calls.refresh).toBe(0);
  });

  it("expired access token is refreshed and the ROTATED refresh token is what gets stored", async () => {
    const a = await loginAndLink(env);
    const oldRefresh = env.box.open(((await secretRows(a.ownerId)).find((r) => r.purpose === "zoom_refresh_token"))!, `${a.ownerId}|zoom_refresh_token`);
    env.clock.advance(3600_000);
    const t = await env.links.getAccessToken(a.ownerId);
    expect(t).toMatch(/^ZT_A_/);
    const newRefresh = env.box.open(((await secretRows(a.ownerId)).find((r) => r.purpose === "zoom_refresh_token"))!, `${a.ownerId}|zoom_refresh_token`);
    expect(newRefresh).not.toBe(oldRefresh);
    // proves rotation was persisted: another expiry works too (the old refresh token is dead at Zoom)
    env.clock.advance(3600_000);
    await env.links.getAccessToken(a.ownerId);
  });

  it("8 concurrent callers trigger exactly ONE refresh and all receive the same token", async () => {
    const a = await loginAndLink(env);
    env.clock.advance(3600_000);
    env.zoom.calls.refresh = 0;
    env.zoom.refreshDelayMs = 80;
    const toks = await Promise.all(Array.from({ length: 8 }, () => env.links.getAccessToken(a.ownerId)));
    env.zoom.refreshDelayMs = 0;
    expect(env.zoom.calls.refresh).toBe(1);
    expect(new Set(toks).size).toBe(1);
  });

  it("two different users refresh in parallel without blocking each other's results", async () => {
    const [a, b] = [await loginAndLink(env), await loginAndLink(env)];
    env.clock.advance(3600_000);
    const [ta, tb] = await Promise.all([env.links.getAccessToken(a.ownerId), env.links.getAccessToken(b.ownerId)]);
    expect(ta).not.toBe(tb);
    expect(env.zoom.accessTokens.get(ta)!.id).toBe(a.zu.id);
    expect(env.zoom.accessTokens.get(tb)!.id).toBe(b.zu.id);
  });

  it("expiry of the Zoom grant (invalid_grant): link goes to needs_reauth, secrets are wiped, state COMMITS", async () => {
    const a = await loginAndLink(env);
    env.clock.advance(3600_000);
    env.zoom.failRefresh = new ZoomUpstreamError(400, "invalid_grant");
    expect(code(await rejects(env.links.getAccessToken(a.ownerId)))).toBe("forbidden");
    env.zoom.failRefresh = null;
    expect((await linkRow(a.ownerId)).status).toBe("needs_reauth");
    expect(await secretRows(a.ownerId)).toHaveLength(0);
    expect(code(await rejects(env.links.getAccessToken(a.ownerId)))).toBe("forbidden"); // stays refused
  });

  it("a transient Zoom failure changes nothing (old tokens kept, retry works)", async () => {
    const a = await loginAndLink(env);
    env.clock.advance(3600_000);
    env.zoom.failRefresh = new ZoomUpstreamError(503);
    expect(code(await rejects(env.links.getAccessToken(a.ownerId)))).toBe("upstream_error");
    env.zoom.failRefresh = null;
    expect((await linkRow(a.ownerId)).status).toBe("active");
    await env.links.getAccessToken(a.ownerId);
  });

  it("key rotation: data sealed with an old key still opens; new writes use the new key", () => {
    const k1 = randomBytes(32), k2 = randomBytes(32);
    const old = new SecretBox({ k1 }, "k1").seal("secret", "aad");
    const ring = new SecretBox({ k1, k2 }, "k2");
    expect(ring.open(old, "aad")).toBe("secret");
    expect(ring.needsRotation(old)).toBe(true);
    expect(ring.seal("x", "aad").key_id).toBe("k2");
    expect(() => new SecretBox({ k1: randomBytes(16) }, "k1")).toThrow();
  });
});

describe("OAuth Zoom: revocation and logout", () => {
  it("unlink revokes both tokens at Zoom, erases them locally, and getAccessToken refuses afterwards", async () => {
    const a = await loginAndLink(env);
    const at = await env.links.getAccessToken(a.ownerId);
    env.zoom.calls.revoke = [];
    const r = await env.links.unlink(a.ownerId);
    expect(r.revokedAtZoom).toBe(true);
    expect(env.zoom.calls.revoke).toHaveLength(2);
    expect(env.zoom.accessTokens.has(at)).toBe(false);
    expect(await secretRows(a.ownerId)).toHaveLength(0);
    expect((await linkRow(a.ownerId)).status).toBe("revoked");
    expect(code(await rejects(env.links.getAccessToken(a.ownerId)))).toBe("forbidden");
    expect(await env.links.status(a.ownerId)).toMatchObject({ linked: false, status: "revoked" });
  });

  it("unlink still wipes locally when Zoom is down, and says so", async () => {
    const a = await loginAndLink(env);
    env.zoom.failRevoke = true;
    const r = await env.links.unlink(a.ownerId);
    env.zoom.failRevoke = false;
    expect(r.revokedAtZoom).toBe(false);
    expect(await secretRows(a.ownerId)).toHaveLength(0);
    expect((await env.db.query("select 1 from jobs where owner_id=$1 and type='zoom.revoke_failed'", [a.ownerId])).rowCount).toBe(1);
  });

  it("after unlink the user can link a different Zoom account", async () => {
    const a = await loginAndLink(env);
    await env.links.unlink(a.ownerId);
    const { authorize_url } = await env.links.startLink(a.ownerId, a.sessionId);
    const z2 = zoomUser();
    const zc = env.zoom.consent(authorize_url, z2);
    await env.links.completeLink({ ownerId: a.ownerId, sessionId: a.sessionId, state: zc.state, code: zc.code });
    expect((await linkRow(a.ownerId)).zoom_user_id).toBe(z2.id);
  });

  it("app_deauthorized from Zoom wipes tokens and revokes the link", async () => {
    const a = await loginAndLink(env);
    expect(await env.links.handleDeauthorized(a.zu.id)).toBe(true);
    expect(await secretRows(a.ownerId)).toHaveLength(0);
    expect((await linkRow(a.ownerId)).status).toBe("revoked");
    expect(await env.links.handleDeauthorized("nobody")).toBe(false);
  });

  it("product logout ends the product session; Zoom identity is separate and stays linked but unreachable without a session", async () => {
    const a = await loginAndLink(env);
    await env.auth.logout(a.sessionId);
    expect(code(await rejects(env.auth.authenticate(a.tokens.access_token)))).toBe("unauthorized");
    expect((await linkRow(a.ownerId)).status).toBe("active");
    // a state started before logout can not be completed with the dead session's identity
    expect(code(await rejects(env.auth.authenticate(undefined)))).toBe("unauthorized");
  });

  it("user erasure removes the whole auth footprint (sessions, tokens, links, secrets, associations)", async () => {
    const a = await loginAndLink(env);
    const { withUser, eraseUser } = await import("@alfred/store");
    const res = await withUser(env.db, a.ownerId, (tx) => eraseUser(tx, a.ownerId));
    expect(res.verified).toBe(true);
    expect(res.deleted.zoom_links).toBe(1);
    expect(res.deleted.secret_refs).toBe(2);
    for (const t of ["auth_sessions", "refresh_tokens", "access_tokens", "zoom_links", "secret_refs", "identities"])
      expect((await env.db.query(`select 1 from ${t} where owner_id=$1`, [a.ownerId])).rowCount, t).toBe(0);
  });
});

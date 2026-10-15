/**
 * Zoom identity: links a product user to ONE Zoom user, holds the Zoom tokens server-side
 * (AES-GCM in secret_refs) and refreshes them single-flight. Zoom tokens never leave this
 * service: no method returns them to a client, and getAccessToken() is internal-only.
 */
import type { Db, Tx } from "../db/pool.js";
import { withAuth } from "../db/pool.js";
import { AuthError, systemClock, type Clock } from "./errors.js";
import { randomToken, sha256hex, SecretBox, type Sealed } from "./crypto.js";
import { challengeS256, generateVerifier } from "./pkce.js";
import { ZoomUpstreamError, type ZoomClient, type ZoomTokenResponse } from "./zoom-client.js";

export interface ZoomLinkConfig {
  redirectUri: string;
  /** Least privilege: the token must carry ALL required scopes and NOTHING outside `allowed`. */
  requiredScopes: string[];
  allowedScopes: string[];
  stateTtlMs: number;
  /** refresh when the access token expires within this window */
  refreshSkewMs: number;
}
/** ASSUMPTION: verify these names against the Zoom Marketplace app configuration. */
export const DEFAULT_ZOOM_SCOPES = ["user:read:user", "meeting:update:participant_rtms_app_status"];

type Purpose = "zoom_access_token" | "zoom_refresh_token";
const aad = (owner: string, p: Purpose) => `${owner}|${p}`;

export class ZoomLinkService {
  readonly cfg: ZoomLinkConfig;
  constructor(
    private readonly db: Db,
    private readonly zoom: ZoomClient,
    private readonly box: SecretBox,
    cfg: Partial<ZoomLinkConfig> & Pick<ZoomLinkConfig, "redirectUri">,
    private readonly clock: Clock = systemClock,
  ) {
    this.cfg = { requiredScopes: DEFAULT_ZOOM_SCOPES, allowedScopes: DEFAULT_ZOOM_SCOPES, stateTtlMs: 10 * 60_000, refreshSkewMs: 60_000, ...cfg };
    if (!this.cfg.redirectUri.startsWith("https://")) throw new Error("zoom redirect uri must be https");
  }
  private at(ms = 0) {
    return new Date(this.clock.now().getTime() + ms);
  }

  /** Step 1: authenticated product user asks to link Zoom. `state` is bound to user AND product session. */
  async startLink(ownerId: string, sessionId: string): Promise<{ authorize_url: string }> {
    const state = randomToken();
    const verifier = generateVerifier();
    const sealed = this.box.seal(verifier, `${ownerId}|pkce`);
    await withAuth(this.db, (tx) =>
      tx.query(
        `insert into oauth_states (state_hash, owner_id, session_id, key_id, verifier_ct, verifier_nonce, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [sha256hex(state), ownerId, sessionId, sealed.key_id, sealed.ciphertext, sealed.nonce, this.at(this.cfg.stateTtlMs)],
      ),
    );
    return { authorize_url: this.zoom.authorizeUrl({ state, codeChallenge: challengeS256(verifier), redirectUri: this.cfg.redirectUri }) };
  }

  /** Step 2: callback. Verifies state, exchanges the code, checks scopes and identity, stores tokens. */
  async completeLink(a: { ownerId: string; sessionId: string; state: string; code: string }): Promise<{ zoom_user_id: string }> {
    const now = this.at();
    // 1. state: exists, unexpired, bound to this very user+session, consumed atomically (replay -> 0 rows)
    const st = await withAuth(this.db, async (tx) => {
      const r = await tx.query(
        `update oauth_states set consumed_at=$2 where state_hash=$1 and consumed_at is null returning *`,
        [sha256hex(String(a.state)), now],
      );
      return r.rows[0] ?? null;
    });
    if (!st) throw new AuthError("invalid_request", "unknown, replayed or already used state");
    if (new Date(st.expires_at) <= now) throw new AuthError("invalid_request", "state expired");
    if (st.owner_id !== a.ownerId || st.session_id !== a.sessionId) throw new AuthError("forbidden", "state belongs to another user/session");
    const verifier = this.box.open({ key_id: st.key_id, nonce: st.verifier_nonce, ciphertext: st.verifier_ct }, `${a.ownerId}|pkce`);

    // 2. code -> tokens
    let tok: ZoomTokenResponse;
    try {
      tok = await this.zoom.exchangeCode({ code: a.code, redirectUri: this.cfg.redirectUri, codeVerifier: verifier });
    } catch (e) {
      throw new AuthError(e instanceof ZoomUpstreamError && e.isInvalidGrant ? "invalid_grant" : "upstream_error", String(e));
    }
    const revokeBoth = async () => {
      await this.zoom.revoke(tok.access_token).catch(() => undefined);
      await this.zoom.revoke(tok.refresh_token).catch(() => undefined);
    };

    // 3. least privilege
    const granted = tok.scope.split(/\s+/).filter(Boolean);
    const extra = granted.filter((s) => !this.cfg.allowedScopes.includes(s));
    const missing = this.cfg.requiredScopes.filter((s) => !granted.includes(s));
    if (extra.length || missing.length) {
      await revokeBoth();
      throw new AuthError("forbidden", `scopes rejected (extra: ${extra.join(",")}; missing: ${missing.join(",")})`);
    }

    // 4. identity: who does Zoom say this is?
    let me;
    try {
      me = await this.zoom.getMe(tok.access_token);
    } catch (e) {
      await revokeBoth();
      throw new AuthError("upstream_error", String(e));
    }

    // 5. 1:1 mapping, enforced in the DB (pk owner_id + unique zoom_user_id) and checked here for a clean error
    try {
      await withAuth(this.db, async (tx) => {
        const mine = await tx.query<{ zoom_user_id: string; status: string }>("select zoom_user_id, status from zoom_links where owner_id=$1 for update", [a.ownerId]);
        if (mine.rows[0] && mine.rows[0].zoom_user_id !== me.id && mine.rows[0].status !== "revoked")
          throw new AuthError("conflict", "product account is already linked to a different Zoom account");
        const theirs = await tx.query<{ owner_id: string }>("select owner_id from zoom_links where zoom_user_id=$1", [me.id]);
        if (theirs.rows[0] && theirs.rows[0].owner_id !== a.ownerId) throw new AuthError("conflict", "this Zoom account is linked to another product account");
        if (mine.rows[0]?.status === "revoked") await tx.query("delete from zoom_links where owner_id=$1", [a.ownerId]);
        await tx.query(
          `insert into zoom_links (owner_id, zoom_user_id, zoom_account_id, scopes, access_expires_at, status)
           values ($1,$2,$3,$4,$5,'active')
           on conflict (owner_id) do update set scopes=excluded.scopes, access_expires_at=excluded.access_expires_at,
             status='active', updated_at=now(), version=zoom_links.version+1`,
          [a.ownerId, me.id, me.account_id, granted, new Date(now.getTime() + tok.expires_in * 1000)],
        );
        await this.storeTokens(tx, a.ownerId, tok);
      });
    } catch (e) {
      await revokeBoth();
      throw e;
    }
    return { zoom_user_id: me.id };
  }

  /**
   * INTERNAL (server-side only). Returns a valid Zoom access token, refreshing at most once even
   * under concurrency: the zoom_links row lock serialises callers and the winner's rotated refresh
   * token is what the others read after the lock (Zoom invalidates the old refresh token on use).
   */
  async getAccessToken(ownerId: string): Promise<string> {
    const out = await withAuth<string | { failure: AuthError }>(this.db, async (tx) => {
      const l = await tx.query<{ status: string; access_expires_at: Date | null }>("select status, access_expires_at from zoom_links where owner_id=$1 for update", [ownerId]);
      const link = l.rows[0];
      if (!link) throw new AuthError("forbidden", "no Zoom account linked");
      if (link.status !== "active") throw new AuthError("forbidden", `zoom link is ${link.status}`);
      const exp = link.access_expires_at ? link.access_expires_at.getTime() : 0;
      const access = await this.readToken(tx, ownerId, "zoom_access_token");
      if (access && exp - this.clock.now().getTime() > this.cfg.refreshSkewMs) return access;

      const refresh = await this.readToken(tx, ownerId, "zoom_refresh_token");
      if (!refresh) {
        await tx.query("update zoom_links set status='needs_reauth', updated_at=now() where owner_id=$1", [ownerId]);
        return { failure: new AuthError("forbidden", "no refresh token") };
      }
      let tok: ZoomTokenResponse;
      try {
        tok = await this.zoom.refresh(refresh);
      } catch (e) {
        if (e instanceof ZoomUpstreamError && e.isInvalidGrant) {
          await tx.query("update zoom_links set status='needs_reauth', updated_at=now(), version=version+1 where owner_id=$1", [ownerId]);
          await tx.query("delete from secret_refs where owner_id=$1 and purpose in ('zoom_access_token','zoom_refresh_token')", [ownerId]);
          // returned (not thrown) so the needs_reauth state COMMITS
          return { failure: new AuthError("forbidden", "zoom refresh token rejected: re-link required") };
        }
        throw new AuthError("upstream_error", String(e));
      }
      // rotation: persist the NEW refresh token in the same transaction as the lock
      await this.storeTokens(tx, ownerId, tok);
      await tx.query("update zoom_links set access_expires_at=$2, updated_at=now(), version=version+1 where owner_id=$1", [ownerId, new Date(this.clock.now().getTime() + tok.expires_in * 1000)]);
      return tok.access_token;
    });
    if (typeof out !== "string") throw out.failure;
    return out;
  }

  /** Revoke at Zoom (best effort, retried via jobs) and forget everything locally. */
  async unlink(ownerId: string): Promise<{ revokedAtZoom: boolean }> {
    const secrets = await withAuth(this.db, async (tx) => ({
      access: await this.readToken(tx, ownerId, "zoom_access_token"),
      refresh: await this.readToken(tx, ownerId, "zoom_refresh_token"),
    }));
    let revokedAtZoom = true;
    for (const t of [secrets.refresh, secrets.access]) {
      if (!t) continue;
      try {
        await this.zoom.revoke(t);
      } catch {
        revokedAtZoom = false;
      }
    }
    await withAuth(this.db, async (tx) => {
      await tx.query("delete from secret_refs where owner_id=$1 and purpose in ('zoom_access_token','zoom_refresh_token')", [ownerId]);
      await tx.query("update zoom_links set status='revoked', access_expires_at=null, updated_at=now(), version=version+1 where owner_id=$1", [ownerId]);
      await tx.query("update stream_associations set revoked_at=coalesce(revoked_at,now()) where owner_id=$1", [ownerId]);
      if (!revokedAtZoom && secrets.refresh) {
        // The ciphertext is gone locally; a retry job can only act on what remains at Zoom's side if Zoom retries deauth. Record the failure.
        await tx.query("insert into jobs (owner_id, type, payload, idempotency_key) values ($1,'zoom.revoke_failed','{}'::jsonb,$2) on conflict do nothing", [ownerId, `revoke-${this.clock.now().toISOString()}`]);
      }
    });
    return { revokedAtZoom };
  }

  async status(ownerId: string): Promise<{ linked: boolean; status?: string; zoom_user_id?: string }> {
    const r = await withAuth(this.db, (tx) => tx.query("select status, zoom_user_id from zoom_links where owner_id=$1", [ownerId]));
    return r.rows[0] ? { linked: r.rows[0].status === "active", status: r.rows[0].status, zoom_user_id: r.rows[0].zoom_user_id } : { linked: false };
  }

  /** Zoom told us the user removed the app: drop tokens and links for that Zoom user. */
  async handleDeauthorized(zoomUserId: string): Promise<boolean> {
    return withAuth(this.db, async (tx) => {
      const r = await tx.query<{ owner_id: string }>("update zoom_links set status='revoked', access_expires_at=null, updated_at=now() where zoom_user_id=$1 returning owner_id", [zoomUserId]);
      for (const row of r.rows) {
        await tx.query("delete from secret_refs where owner_id=$1 and purpose in ('zoom_access_token','zoom_refresh_token')", [row.owner_id]);
        await tx.query("update stream_associations set revoked_at=coalesce(revoked_at,now()) where owner_id=$1", [row.owner_id]);
      }
      return r.rowCount === 1;
    });
  }

  // ---- encrypted token storage -------------------------------------------------------------
  private async storeTokens(tx: Tx, ownerId: string, tok: ZoomTokenResponse) {
    for (const [purpose, value] of [["zoom_access_token", tok.access_token], ["zoom_refresh_token", tok.refresh_token]] as const) {
      const s = this.box.seal(value, aad(ownerId, purpose));
      await tx.query(
        `insert into secret_refs (owner_id, purpose, key_id, ciphertext, nonce) values ($1,$2,$3,$4,$5)
         on conflict (owner_id, purpose) do update set key_id=excluded.key_id, ciphertext=excluded.ciphertext, nonce=excluded.nonce, rotated_at=now()`,
        [ownerId, purpose, s.key_id, s.ciphertext, s.nonce],
      );
    }
  }
  private async readToken(tx: Tx, ownerId: string, purpose: Purpose): Promise<string | null> {
    const r = await tx.query<{ key_id: string; ciphertext: Buffer; nonce: Buffer }>("select key_id, ciphertext, nonce from secret_refs where owner_id=$1 and purpose=$2", [ownerId, purpose]);
    const row = r.rows[0];
    if (!row) return null;
    const sealed: Sealed = { key_id: row.key_id, ciphertext: row.ciphertext, nonce: row.nonce };
    return this.box.open(sealed, aad(ownerId, purpose));
  }
}

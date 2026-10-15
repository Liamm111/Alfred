/**
 * Product authentication: OAuth2 authorization-code + PKCE(S256) for the native app, then a
 * short-lived opaque access token and a ROTATING refresh token with reuse detection.
 *
 * - Tokens are opaque 256-bit random values; only their SHA-256 is stored (a DB leak yields nothing usable).
 * - An authorization code is single use; presenting it twice (or with a wrong verifier) burns it,
 *   and a replay after success revokes the session that the first exchange created.
 * - Presenting an already-used refresh token is treated as theft: the whole session is revoked.
 * - This is the PRODUCT identity. It says nothing about Zoom (see zoom-link.ts).
 */
import type { Db, Tx } from "@alfred/store";
import { withAuth } from "@alfred/store";
import { AuthError, systemClock, type Clock } from "./errors.js";
import { randomToken, sha256hex } from "./crypto.js";
import { isValidChallenge, verifyPkce } from "./pkce.js";

export interface ClientConfig {
  redirectUris: string[];
}
export interface ProductAuthConfig {
  clients: Record<string, ClientConfig>;
  codeTtlMs: number;
  accessTtlMs: number;
  refreshTtlMs: number;
  /** absolute lifetime of a login session, whatever the refreshes */
  sessionTtlMs: number;
}
export const DEFAULT_PRODUCT_AUTH: Omit<ProductAuthConfig, "clients"> = {
  codeTtlMs: 60_000,
  accessTtlMs: 10 * 60_000,
  refreshTtlMs: 30 * 24 * 3600_000,
  sessionTtlMs: 90 * 24 * 3600_000,
};

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  session_id: string;
}
export interface Principal {
  ownerId: string;
  sessionId: string;
}

/** Redirect URIs must be https, loopback (RFC 8252), or a private-use scheme; never plain remote http. */
export function isAcceptableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  // RFC 8252: loopback IP literals over http, or a reverse-DNS private-use scheme (com.example.app:/cb).
  if (u.protocol === "http:") return u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(u.protocol);
}

export class ProductAuth {
  readonly cfg: ProductAuthConfig;
  constructor(
    private readonly db: Db,
    cfg: Pick<ProductAuthConfig, "clients"> & Partial<ProductAuthConfig>,
    private readonly clock: Clock = systemClock,
  ) {
    this.cfg = { ...DEFAULT_PRODUCT_AUTH, ...cfg };
    for (const [id, c] of Object.entries(this.cfg.clients))
      for (const r of c.redirectUris) if (!isAcceptableRedirectUri(r)) throw new Error(`client ${id}: unacceptable redirect uri ${r}`);
  }

  private at(ms = 0) {
    return new Date(this.clock.now().getTime() + ms);
  }

  /** Find or create the product user for an externally authenticated identity (first factor lives elsewhere). */
  async resolveUser(provider: string, subject: string): Promise<string> {
    return withAuth(this.db, async (tx) => {
      // serialise creation per identity so a race can not create two users (the auth role can not delete users)
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${provider}:${subject}`]);
      const ex = await tx.query<{ owner_id: string }>("select owner_id from identities where provider=$1 and subject=$2", [provider, subject]);
      if (ex.rows[0]) return ex.rows[0].owner_id;
      const u = await tx.query<{ id: string }>("insert into users default values returning id");
      await tx.query("insert into identities (provider, subject, owner_id) values ($1,$2,$3)", [provider, subject, u.rows[0]!.id]);
      return u.rows[0]!.id;
    });
  }

  /** Step 1 (after the user authenticated): bind a one-time code to the PKCE challenge. */
  async issueCode(a: { ownerId: string; clientId: string; redirectUri: string; codeChallenge: string; codeChallengeMethod: string }): Promise<string> {
    const client = this.cfg.clients[a.clientId];
    if (!client) throw new AuthError("invalid_client", "unknown client");
    if (!client.redirectUris.includes(a.redirectUri)) throw new AuthError("invalid_request", "redirect_uri not registered");
    if (a.codeChallengeMethod !== "S256") throw new AuthError("invalid_request", "only S256 is accepted");
    if (!isValidChallenge(a.codeChallenge)) throw new AuthError("invalid_request", "malformed code_challenge");
    const code = randomToken();
    await withAuth(this.db, (tx) =>
      tx.query(
        "insert into auth_codes (code_hash, owner_id, client_id, redirect_uri, code_challenge, expires_at) values ($1,$2,$3,$4,$5,$6)",
        [sha256hex(code), a.ownerId, a.clientId, a.redirectUri, a.codeChallenge, this.at(this.cfg.codeTtlMs)],
      ),
    );
    return code;
  }

  /** Step 2: code + verifier -> session + tokens. */
  async exchangeCode(a: { code: string; codeVerifier: string; clientId: string; redirectUri: string }): Promise<TokenSet> {
    const now = this.at();
    // The burn of a bad attempt must survive the error, so it runs in its own committed transaction.
    const outcome = await withAuth(this.db, async (tx) => {
      const r = await tx.query(
        "select * from auth_codes where code_hash=$1 for update",
        [sha256hex(String(a.code))],
      );
      const row = r.rows[0];
      if (!row) return { err: new AuthError("invalid_grant", "unknown code") };
      if (row.consumed_at) {
        if (row.session_id) await this.revokeSessionTx(tx, row.session_id, "code_replay");
        return { err: new AuthError("invalid_grant", "code replay"), committed: true };
      }
      await tx.query("update auth_codes set consumed_at=$2 where code_hash=$1", [row.code_hash, now]); // burn first
      if (row.client_id !== a.clientId) return { err: new AuthError("invalid_grant", "client mismatch"), committed: true };
      if (row.redirect_uri !== a.redirectUri) return { err: new AuthError("invalid_grant", "redirect mismatch"), committed: true };
      if (new Date(row.expires_at) <= now) return { err: new AuthError("invalid_grant", "code expired"), committed: true };
      if (!verifyPkce(a.codeVerifier, row.code_challenge)) return { err: new AuthError("invalid_grant", "pkce verification failed"), committed: true };
      const s = await tx.query<{ id: string }>(
        "insert into auth_sessions (owner_id, client_id, expires_at) values ($1,$2,$3) returning id",
        [row.owner_id, row.client_id, this.at(this.cfg.sessionTtlMs)],
      );
      await tx.query("update auth_codes set session_id=$2 where code_hash=$1", [row.code_hash, s.rows[0]!.id]);
      return { tokens: await this.mintTokens(tx, s.rows[0]!.id, row.owner_id, null, now) };
    });
    if ("err" in outcome && outcome.err) throw outcome.err;
    return (outcome as { tokens: TokenSet }).tokens;
  }

  /** Rotating refresh: the presented token dies, a new pair is issued. Reuse revokes the session. */
  async refresh(a: { refreshToken: string; clientId: string }): Promise<TokenSet> {
    const now = this.at();
    const outcome = await withAuth(this.db, async (tx) => {
      const r = await tx.query(
        `select t.*, s.client_id, s.revoked_at as s_revoked, s.expires_at as s_expires
           from refresh_tokens t join auth_sessions s on s.id = t.session_id
          where t.token_hash=$1 for update of t`,
        [sha256hex(String(a.refreshToken))],
      );
      const t = r.rows[0];
      if (!t) return { err: new AuthError("invalid_grant", "unknown refresh token") };
      if (t.client_id !== a.clientId) return { err: new AuthError("invalid_grant", "client mismatch") };
      if (t.s_revoked || t.revoked_at) return { err: new AuthError("invalid_grant", "revoked") };
      if (t.used_at) {
        await this.revokeSessionTx(tx, t.session_id, "refresh_reuse");
        return { err: new AuthError("reuse_detected", "refresh token reuse") };
      }
      if (new Date(t.expires_at) <= now || new Date(t.s_expires) <= now) return { err: new AuthError("invalid_grant", "expired") };
      await tx.query("update refresh_tokens set used_at=$2 where id=$1", [t.id, now]);
      await tx.query("delete from access_tokens where session_id=$1", [t.session_id]);
      return { tokens: await this.mintTokens(tx, t.session_id, t.owner_id, t.id, now) };
    });
    if ("err" in outcome && outcome.err) {
      throw outcome.err;
    }
    return (outcome as { tokens: TokenSet }).tokens;
  }

  /** Bearer authentication. Lookup by hash: no secret comparison to time. */
  async authenticate(accessToken: string | undefined): Promise<Principal> {
    if (!accessToken) throw new AuthError("unauthorized", "missing token");
    const now = this.at();
    const r = await withAuth(this.db, (tx) =>
      tx.query(
        `select a.owner_id, a.session_id from access_tokens a join auth_sessions s on s.id = a.session_id
          where a.token_hash=$1 and a.expires_at > $2 and s.revoked_at is null and s.expires_at > $2`,
        [sha256hex(accessToken), now],
      ),
    );
    const row = r.rows[0];
    if (!row) throw new AuthError("unauthorized", "invalid or expired token");
    return { ownerId: row.owner_id, sessionId: row.session_id };
  }

  async logout(sessionId: string): Promise<void> {
    await withAuth(this.db, (tx) => this.revokeSessionTx(tx, sessionId, "logout"));
  }
  async logoutAll(ownerId: string): Promise<void> {
    await withAuth(this.db, async (tx) => {
      const s = await tx.query<{ id: string }>("select id from auth_sessions where owner_id=$1 and revoked_at is null", [ownerId]);
      for (const r of s.rows) await this.revokeSessionTx(tx, r.id, "logout_all");
    });
  }

  private async revokeSessionTx(tx: Tx, sessionId: string, reason: string) {
    await tx.query("update auth_sessions set revoked_at=coalesce(revoked_at,$2), revoked_reason=coalesce(revoked_reason,$3) where id=$1", [sessionId, this.at(), reason]);
    await tx.query("delete from access_tokens where session_id=$1", [sessionId]);
    await tx.query("update refresh_tokens set revoked_at=coalesce(revoked_at,$2) where session_id=$1", [sessionId, this.at()]);
  }

  private async mintTokens(tx: Tx, sessionId: string, ownerId: string, parentId: string | null, now: Date): Promise<TokenSet> {
    const access = randomToken();
    const refresh = randomToken();
    await tx.query("insert into access_tokens (token_hash, session_id, owner_id, expires_at) values ($1,$2,$3,$4)", [sha256hex(access), sessionId, ownerId, new Date(now.getTime() + this.cfg.accessTtlMs)]);
    await tx.query("insert into refresh_tokens (session_id, owner_id, token_hash, parent_id, expires_at) values ($1,$2,$3,$4,$5)", [sessionId, ownerId, sha256hex(refresh), parentId, new Date(now.getTime() + this.cfg.refreshTtlMs)]);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: Math.floor(this.cfg.accessTtlMs / 1000), session_id: sessionId };
  }
}

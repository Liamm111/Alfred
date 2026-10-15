/**
 * Zoom API boundary. Everything the product needs from Zoom goes through this interface so it
 * can be faked in tests. HttpZoomClient targets the documented OAuth endpoints; it has been
 * exercised only against a local mock server (no live Zoom credentials in this repo).
 * ASSUMPTION to verify against the Zoom Marketplace app configuration before go-live:
 * the exact scope names and the meeting-ownership lookup.
 */
export interface ZoomTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** space separated, as returned by Zoom */
  scope: string;
}
export interface ZoomProfile {
  id: string;
  account_id: string;
}
export interface ZoomClient {
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }): Promise<ZoomTokenResponse>;
  refresh(refreshToken: string): Promise<ZoomTokenResponse>;
  revoke(token: string): Promise<void>;
  getMe(accessToken: string): Promise<ZoomProfile>;
  /** 'host' only when Zoom itself says the token owner is the host of that meeting. */
  getMeetingRole(accessToken: string, meetingUuid: string, me: ZoomProfile): Promise<"host" | "none">;
}

export class ZoomUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly oauthError?: string,
  ) {
    super(`zoom upstream ${status} ${oauthError ?? ""}`);
  }
  /** invalid_grant on refresh = the refresh token is dead: user must re-link */
  get isInvalidGrant() {
    return this.oauthError === "invalid_grant";
  }
}

export interface HttpZoomConfig {
  clientId: string;
  clientSecret: string;
  oauthBase?: string; // default https://zoom.us
  apiBase?: string; // default https://api.zoom.us/v2
  fetchImpl?: typeof fetch;
}

export class HttpZoomClient implements ZoomClient {
  private readonly oauth: string;
  private readonly api: string;
  private readonly f: typeof fetch;
  constructor(private readonly cfg: HttpZoomConfig) {
    this.oauth = cfg.oauthBase ?? "https://zoom.us";
    this.api = cfg.apiBase ?? "https://api.zoom.us/v2";
    this.f = cfg.fetchImpl ?? fetch;
  }
  private basic() {
    return "Basic " + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
  }
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    const u = new URL("/oauth/authorize", this.oauth);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: p.redirectUri,
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  }
  private async token(body: Record<string, string>): Promise<ZoomTokenResponse> {
    const r = await this.f(new URL("/oauth/token", this.oauth), {
      method: "POST",
      headers: { authorization: this.basic(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const j = (await r.json().catch(() => ({}))) as Partial<ZoomTokenResponse> & { error?: string };
    if (!r.ok) throw new ZoomUpstreamError(r.status, j.error);
    if (!j.access_token || !j.refresh_token || typeof j.expires_in !== "number") throw new ZoomUpstreamError(502, "malformed_token_response");
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in, scope: j.scope ?? "" };
  }
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }) {
    return this.token({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier });
  }
  refresh(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }
  async revoke(token: string): Promise<void> {
    const r = await this.f(new URL("/oauth/revoke", this.oauth), {
      method: "POST",
      headers: { authorization: this.basic(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!r.ok) throw new ZoomUpstreamError(r.status);
  }
  async getMe(accessToken: string): Promise<ZoomProfile> {
    const r = await this.f(`${this.api}/users/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new ZoomUpstreamError(r.status);
    const j = (await r.json()) as { id?: string; account_id?: string };
    if (!j.id) throw new ZoomUpstreamError(502, "malformed_profile");
    return { id: j.id, account_id: j.account_id ?? "" };
  }
  async getMeetingRole(accessToken: string, meetingUuid: string, me: ZoomProfile): Promise<"host" | "none"> {
    // Zoom requires double-encoding UUIDs that start with '/' or contain '//'.
    const enc = /^\/|\/\//.test(meetingUuid) ? encodeURIComponent(encodeURIComponent(meetingUuid)) : encodeURIComponent(meetingUuid);
    const r = await this.f(`${this.api}/meetings/${enc}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (r.status === 404 || r.status === 403) return "none";
    if (!r.ok) throw new ZoomUpstreamError(r.status);
    const j = (await r.json()) as { host_id?: string };
    return j.host_id !== undefined && j.host_id === me.id ? "host" : "none";
  }
}

/**
 * Proof that a stream belongs to a real participant - and nothing else counts.
 *
 * Trust chain: Zoom signs a webhook (HMAC) -> we store a verified fact "Zoom user U started
 * RTMS stream S in meeting M" -> only the product user whose linked zoom_user_id is U can
 * claim (M, S) -> the claim yields a short-lived SIGNED, single-use association token.
 * Window titles, participant display names and client-supplied "who am I" strings are never
 * inputs to any decision (the request schemas are strict and have no such fields).
 */
import { createHmac } from "node:crypto";
import type { Db } from "../db/pool.js";
import { withAuth } from "../db/pool.js";
import { AuthError, systemClock, type Clock } from "./errors.js";
import { randomToken, safeEqual, sha256hex, Signer } from "./crypto.js";
import type { ZoomLinkService } from "./zoom-link.js";
import type { ZoomClient } from "./zoom-client.js";

// ---- webhook ------------------------------------------------------------------------------
export interface ZoomStreamEvent {
  event_id: string;
  kind: "rtms_started" | "rtms_stopped" | "app_deauthorized";
  zoom_user_id: string;
  meeting_uuid?: string;
  stream_id?: string;
}

/**
 * ASSUMPTION: field names of the Zoom payload below follow Zoom's event envelope
 * ({event, event_ts, payload:{account_id, operator_id?, object:{...}}}) and must be checked
 * against the live Zoom docs / a real delivery before go-live. Unknown shapes are REJECTED.
 */
export function normalizeZoomEvent(body: any): ZoomStreamEvent | null {
  if (!body || typeof body !== "object" || typeof body.event !== "string") return null;
  const p = body.payload ?? {};
  const o = p.object ?? {};
  const base = `${body.event}:${body.event_ts ?? ""}`;
  if (body.event === "app_deauthorized" || body.event === "app.deauthorized") {
    const uid = p.user_id ?? o.user_id;
    return typeof uid === "string" ? { event_id: `${base}:${uid}`, kind: "app_deauthorized", zoom_user_id: uid } : null;
  }
  if (body.event === "meeting.rtms_started" || body.event === "meeting.rtms_stopped") {
    const uid = p.operator_id ?? o.host_id;
    if (typeof uid !== "string" || typeof o.meeting_uuid !== "string" || typeof o.rtms_stream_id !== "string") return null;
    return {
      event_id: `${base}:${o.meeting_uuid}:${o.rtms_stream_id}`,
      kind: body.event === "meeting.rtms_started" ? "rtms_started" : "rtms_stopped",
      zoom_user_id: uid,
      meeting_uuid: o.meeting_uuid,
      stream_id: o.rtms_stream_id,
    };
  }
  return null;
}

export class ZoomWebhookVerifier {
  constructor(
    private readonly secretToken: string,
    private readonly clock: Clock = systemClock,
    private readonly toleranceMs = 5 * 60_000,
  ) {}
  /** Zoom scheme: signature = "v0=" + HMAC_SHA256(secret, `v0:${timestamp}:${rawBody}`). */
  verify(headers: { signature?: string; timestamp?: string }, rawBody: string): boolean {
    if (!headers.signature || !headers.timestamp) return false;
    const ts = Number(headers.timestamp);
    if (!Number.isFinite(ts) || Math.abs(this.clock.now().getTime() - ts * 1000) > this.toleranceMs) return false;
    const expected = "v0=" + createHmac("sha256", this.secretToken).update(`v0:${headers.timestamp}:${rawBody}`).digest("hex");
    return safeEqual(headers.signature, expected);
  }
  /** Answer to Zoom's endpoint.url_validation challenge. */
  urlValidation(plainToken: string) {
    return { plainToken, encryptedToken: createHmac("sha256", this.secretToken).update(plainToken).digest("hex") };
  }
}

// ---- associations ----------------------------------------------------------------------------
export interface AssociationClaims {
  v: 1;
  aid: string;
  uid: string; // product owner
  mid: string;
  sid: string;
  n: string; // nonce
  exp: number; // epoch seconds
}

export class StreamService {
  constructor(
    private readonly db: Db,
    private readonly signer: Signer,
    private readonly links: ZoomLinkService,
    private readonly zoom: ZoomClient,
    private readonly clock: Clock = systemClock,
    private readonly opts = { tokenTtlMs: 5 * 60_000, eventMaxAgeMs: 10 * 60_000 },
  ) {}

  /** Persist a verified Zoom fact. Returns false when the event was already processed (replay). */
  async recordEvent(ev: ZoomStreamEvent): Promise<boolean> {
    return withAuth(this.db, async (tx) => {
      const r = await tx.query(
        "insert into zoom_events (event_id, kind, zoom_user_id, meeting_uuid, stream_id, received_at) values ($1,$2,$3,$4,$5,$6) on conflict (event_id) do nothing",
        [ev.event_id, ev.kind, ev.zoom_user_id, ev.meeting_uuid ?? null, ev.stream_id ?? null, this.clock.now()],
      );
      return r.rowCount === 1;
    });
  }

  /** The caller claims (meeting, stream). Granted only if Zoom said that THEIR linked Zoom user started it. */
  async claim(ownerId: string, meetingUuid: string, streamId: string): Promise<{ association_token: string; expires_at: string }> {
    const now = this.clock.now();
    const out = await withAuth(this.db, async (tx) => {
      const link = await tx.query<{ zoom_user_id: string; status: string }>("select zoom_user_id, status from zoom_links where owner_id=$1", [ownerId]);
      if (!link.rows[0] || link.rows[0].status !== "active") return { fail: new AuthError("forbidden", "no active Zoom link") };
      const ev = await tx.query(
        `select 1 from zoom_events where kind='rtms_started' and meeting_uuid=$1 and stream_id=$2 and zoom_user_id=$3 and received_at > $4
            and not exists (select 1 from zoom_events s where s.kind='rtms_stopped' and s.meeting_uuid=$1 and s.stream_id=$2)`,
        [meetingUuid, streamId, link.rows[0].zoom_user_id, new Date(now.getTime() - this.opts.eventMaxAgeMs)],
      );
      if (!ev.rowCount) return { fail: new AuthError("forbidden", "no verified Zoom event proves this stream is yours") };
      const nonce = randomToken(16);
      const exp = new Date(now.getTime() + this.opts.tokenTtlMs);
      const ins = await tx.query<{ id: string }>(
        `insert into stream_associations (owner_id, zoom_user_id, meeting_uuid, stream_id, nonce_hash, expires_at)
         values ($1,$2,$3,$4,$5,$6) on conflict (meeting_uuid, stream_id) do nothing returning id`,
        [ownerId, link.rows[0].zoom_user_id, meetingUuid, streamId, sha256hex(nonce), exp],
      );
      if (!ins.rows[0]) return { fail: new AuthError("conflict", "stream already associated") };
      const claims: AssociationClaims = { v: 1, aid: ins.rows[0].id, uid: ownerId, mid: meetingUuid, sid: streamId, n: nonce, exp: Math.floor(exp.getTime() / 1000) };
      return { token: this.signer.sign(claims as unknown as Record<string, unknown>), exp };
    });
    if ("fail" in out && out.fail) throw out.fail;
    const ok = out as { token: string; exp: Date };
    return { association_token: ok.token, expires_at: ok.exp.toISOString() };
  }

  /**
   * Redeem the token (single use). The authenticated caller must be the owner named in the
   * signed claims AND in the DB row; a stolen token is useless to anybody else.
   */
  async attach(ownerId: string, token: string): Promise<{ meeting_uuid: string; stream_id: string }> {
    const claims = this.signer.verify(String(token)) as AssociationClaims | null;
    if (!claims || claims.v !== 1 || typeof claims.exp !== "number") throw new AuthError("invalid_grant", "bad association token");
    const now = this.clock.now();
    if (claims.exp * 1000 <= now.getTime()) throw new AuthError("invalid_grant", "association token expired");
    if (claims.uid !== ownerId) throw new AuthError("forbidden", "association token belongs to another user");
    const out = await withAuth(this.db, async (tx) => {
      const r = await tx.query(
        `update stream_associations set consumed_at=$2
          where id=$1 and owner_id=$3 and nonce_hash=$4 and consumed_at is null and revoked_at is null and expires_at > $2
          returning meeting_uuid, stream_id`,
        [claims.aid, now, ownerId, sha256hex(claims.n)],
      );
      return r.rows[0] ?? null;
    });
    if (!out) throw new AuthError("invalid_grant", "association token already used, revoked or unknown");
    return { meeting_uuid: out.meeting_uuid, stream_id: out.stream_id };
  }

  async revoke(ownerId: string, meetingUuid: string, streamId: string): Promise<void> {
    await withAuth(this.db, (tx) =>
      tx.query("update stream_associations set revoked_at=coalesce(revoked_at,now()) where owner_id=$1 and meeting_uuid=$2 and stream_id=$3", [ownerId, meetingUuid, streamId]),
    );
  }

  /**
   * Gate in front of "start RTMS". Zoom itself must say that the CALLER's own token belongs to the
   * host of that meeting. The Zoom token is used here, server-side, and never returned.
   */
  async authorizeRtmsStart(ownerId: string, meetingUuid: string, starter: RtmsStarter): Promise<{ started: true }> {
    const accessToken = await this.links.getAccessToken(ownerId); // throws forbidden if not linked / revoked
    const me = await this.zoom.getMe(accessToken);
    const stored = await withAuth(this.db, (tx) => tx.query("select zoom_user_id from zoom_links where owner_id=$1", [ownerId]));
    if (stored.rows[0]?.zoom_user_id !== me.id) throw new AuthError("forbidden", "token owner differs from linked Zoom user");
    const role = await this.zoom.getMeetingRole(accessToken, meetingUuid, me);
    if (role !== "host") throw new AuthError("forbidden", "caller is not the host of this meeting");
    await starter.start({ meetingUuid, zoomUserId: me.id, accessToken });
    return { started: true };
  }
}

export interface RtmsStarter {
  /** Receives the Zoom token for server-side use only. Must never forward it to a client. */
  start(a: { meetingUuid: string; zoomUserId: string; accessToken: string }): Promise<void>;
}

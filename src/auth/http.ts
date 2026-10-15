/**
 * Thin HTTP surface over the services. Rules enforced here:
 *  - TLS only (direct TLS socket, or X-Forwarded-Proto: https from a trusted proxy); otherwise 426;
 *  - every body is parsed with a STRICT schema (unknown fields such as window_title are a 400);
 *  - responses never contain Zoom tokens or token hashes, are `no-store`, and carry only an error code on failure.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AuthError } from "./errors.js";
import type { ProductAuth } from "./product-auth.js";
import type { RtmsStarter, StreamService, ZoomWebhookVerifier, ZoomStreamEvent } from "./streams.js";
import { normalizeZoomEvent } from "./streams.js";
import type { ZoomLinkService } from "./zoom-link.js";

export interface ApiDeps {
  auth: ProductAuth;
  zoomLinks: ZoomLinkService;
  streams: StreamService;
  webhook: ZoomWebhookVerifier;
  rtms: RtmsStarter;
  /** Resolves the first-factor (IdP) login of the browser/app user to a product user id. Out of scope here. */
  firstFactor: (req: IncomingMessage) => Promise<string | null>;
  trustProxy: boolean;
  log?: (line: string) => void;
}

const S = {
  authorize: z.strictObject({ client_id: z.string(), redirect_uri: z.string(), code_challenge: z.string(), code_challenge_method: z.string() }),
  token: z.discriminatedUnion("grant_type", [
    z.strictObject({ grant_type: z.literal("authorization_code"), code: z.string(), code_verifier: z.string(), client_id: z.string(), redirect_uri: z.string() }),
    z.strictObject({ grant_type: z.literal("refresh_token"), refresh_token: z.string(), client_id: z.string() }),
  ]),
  associate: z.strictObject({ meeting_uuid: z.string().min(1).max(256), stream_id: z.string().min(1).max(256) }),
  attach: z.strictObject({ association_token: z.string().min(10).max(2048) }),
  rtms: z.strictObject({ meeting_uuid: z.string().min(1).max(256) }),
  callback: z.strictObject({ state: z.string().min(10).max(200), code: z.string().min(1).max(2048) }),
};

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new AuthError("invalid_request", "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApi(d: ApiDeps) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };
  const parse = <T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> => {
    const r = schema.safeParse(raw);
    if (!r.success) throw new AuthError("invalid_request", r.error.issues.map((i) => `${i.path.join(".")}:${i.code}`).join(","));
    return r.data;
  };
  const json = async (req: IncomingMessage, raw?: string) => {
    try {
      return JSON.parse(raw ?? (await readBody(req)));
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError("invalid_request", "invalid json");
    }
  };
  const bearer = async (req: IncomingMessage) => {
    const h = req.headers.authorization;
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h ?? "");
    return d.auth.authenticate(m?.[1]);
  };
  const secure = (req: IncomingMessage) =>
    (req.socket as { encrypted?: boolean }).encrypted === true || (d.trustProxy && req.headers["x-forwarded-proto"] === "https");

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!secure(req)) throw new AuthError("insecure_transport", "https required");
      const url = new URL(req.url ?? "/", "https://x");
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case "POST /v1/auth/authorize": {
          const ownerId = await d.firstFactor(req);
          if (!ownerId) throw new AuthError("unauthorized", "first factor missing");
          const b = parse(S.authorize, await json(req));
          const code = await d.auth.issueCode({ ownerId, clientId: b.client_id, redirectUri: b.redirect_uri, codeChallenge: b.code_challenge, codeChallengeMethod: b.code_challenge_method });
          return send(res, 200, { code });
        }
        case "POST /v1/auth/token": {
          const b = parse(S.token, await json(req));
          const t = b.grant_type === "authorization_code"
            ? await d.auth.exchangeCode({ code: b.code, codeVerifier: b.code_verifier, clientId: b.client_id, redirectUri: b.redirect_uri })
            : await d.auth.refresh({ refreshToken: b.refresh_token, clientId: b.client_id });
          return send(res, 200, t);
        }
        case "POST /v1/auth/logout": {
          const p = await bearer(req);
          await d.auth.logout(p.sessionId);
          return send(res, 200, { ok: true });
        }
        case "POST /v1/zoom/link/start": {
          const p = await bearer(req);
          return send(res, 200, await d.zoomLinks.startLink(p.ownerId, p.sessionId));
        }
        case "GET /v1/zoom/link/callback": {
          const p = await bearer(req);
          const q = parse(S.callback, Object.fromEntries(url.searchParams));
          const r = await d.zoomLinks.completeLink({ ownerId: p.ownerId, sessionId: p.sessionId, state: q.state, code: q.code });
          return send(res, 200, { linked: true, zoom_user_id: r.zoom_user_id });
        }
        case "GET /v1/zoom/link": {
          const p = await bearer(req);
          return send(res, 200, await d.zoomLinks.status(p.ownerId));
        }
        case "DELETE /v1/zoom/link": {
          const p = await bearer(req);
          return send(res, 200, await d.zoomLinks.unlink(p.ownerId));
        }
        case "POST /v1/zoom/webhook": {
          const raw = await readBody(req);
          if (!d.webhook.verify({ signature: String(req.headers["x-zm-signature"] ?? ""), timestamp: String(req.headers["x-zm-request-timestamp"] ?? "") }, raw))
            throw new AuthError("unauthorized", "bad webhook signature");
          const body = JSON.parse(raw);
          if (body?.event === "endpoint.url_validation") return send(res, 200, d.webhook.urlValidation(String(body.payload?.plainToken ?? "")));
          const ev: ZoomStreamEvent | null = normalizeZoomEvent(body);
          if (!ev) return send(res, 200, { ignored: true });
          const fresh = await d.streams.recordEvent(ev);
          if (fresh && ev.kind === "app_deauthorized") await d.zoomLinks.handleDeauthorized(ev.zoom_user_id);
          return send(res, 200, { received: true, replay: !fresh });
        }
        case "POST /v1/streams/associate": {
          const p = await bearer(req);
          const b = parse(S.associate, await json(req));
          return send(res, 200, await d.streams.claim(p.ownerId, b.meeting_uuid, b.stream_id));
        }
        case "POST /v1/streams/attach": {
          const p = await bearer(req);
          const b = parse(S.attach, await json(req));
          return send(res, 200, await d.streams.attach(p.ownerId, b.association_token));
        }
        case "POST /v1/rtms/start": {
          const p = await bearer(req);
          const b = parse(S.rtms, await json(req));
          return send(res, 200, await d.streams.authorizeRtmsStart(p.ownerId, b.meeting_uuid, d.rtms));
        }
        default:
          return send(res, 404, { error: { code: "not_found" } });
      }
    } catch (e) {
      if (e instanceof AuthError) {
        d.log?.(`${e.code} ${e.detail}`); // detail stays in server logs
        return send(res, e.status, { error: { code: e.code } });
      }
      d.log?.(`internal ${(e as Error).message}`);
      return send(res, 500, { error: { code: "internal" } });
    }
  };
}

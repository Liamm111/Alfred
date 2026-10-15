import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/http.js";
import { challengeS256, generateVerifier } from "../src/pkce.js";
import { CLIENT, REDIRECT, WEBHOOK_SECRET, mkEnv, signZoom, zoomUser, type Env } from "./env.js";
import { HttpZoomClient } from "../src/zoom-client.js";

let env: Env, server: Server, base: string;
const bodies: string[] = []; // every response body, scanned for leaks at the end

beforeAll(async () => {
  env = await mkEnv();
  const api = createApi({
    auth: env.auth, zoomLinks: env.links, streams: env.streams, webhook: env.webhook, rtms: env.rtms, trustProxy: true,
    firstFactor: async (req) => {
      const sub = req.headers["x-test-subject"];
      return typeof sub === "string" ? env.auth.resolveUser("test-idp", sub) : null;
    },
  });
  server = createServer(api);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await env.db.end();
});

const SECURE = { "x-forwarded-proto": "https" };
async function call(method: string, path: string, o: { body?: unknown; raw?: string; headers?: Record<string, string>; bearer?: string; secure?: boolean } = {}) {
  const headers: Record<string, string> = { ...(o.secure === false ? {} : SECURE), ...(o.headers ?? {}) };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  const body = method === "GET" || method === "HEAD" ? undefined : (o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)));
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers, body });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
}

async function httpLogin(subject: string) {
  const verifier = generateVerifier();
  const a = await call("POST", "/v1/auth/authorize", { headers: { "x-test-subject": subject }, body: { client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: challengeS256(verifier), code_challenge_method: "S256" } });
  expect(a.status).toBe(200);
  const t = await call("POST", "/v1/auth/token", { body: { grant_type: "authorization_code", code: a.json.code, code_verifier: verifier, client_id: CLIENT, redirect_uri: REDIRECT } });
  expect(t.status).toBe(200);
  return t.json as { access_token: string; refresh_token: string; session_id: string };
}

describe("transport and hygiene", () => {
  it("refuses anything that is not HTTPS (426) before looking at the request", async () => {
    const r = await call("POST", "/v1/auth/token", { secure: false, body: {} });
    expect(r.status).toBe(426);
    expect(r.json).toEqual({ error: { code: "insecure_transport" } });
    expect((await call("POST", "/v1/auth/token", { secure: false, headers: { "x-forwarded-proto": "http" }, body: {} })).status).toBe(426);
  });
  it("every response is no-store with HSTS and nosniff; errors carry a code only", async () => {
    const r = await call("POST", "/v1/auth/token", { body: { grant_type: "authorization_code" } });
    expect(r.status).toBe(400);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Object.keys(r.json)).toEqual(["error"]);
    expect(Object.keys(r.json.error)).toEqual(["code"]);
  });
  it("unknown route 404, malformed JSON 400, oversized body 400", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("POST", "/v1/auth/token", { raw: "{not json" })).status).toBe(400);
    expect((await call("POST", "/v1/auth/token", { raw: JSON.stringify({ pad: "x".repeat(70_000) }) })).status).toBe(400);
  });
  it("authorize needs the first factor; PKCE plain is refused over HTTP too", async () => {
    const body = { client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: challengeS256(generateVerifier()), code_challenge_method: "S256" };
    expect((await call("POST", "/v1/auth/authorize", { body })).status).toBe(401);
    expect((await call("POST", "/v1/auth/authorize", { headers: { "x-test-subject": "h1" }, body: { ...body, code_challenge_method: "plain" } })).status).toBe(400);
  });
  it("protected routes need a valid bearer", async () => {
    for (const [m, p] of [["POST", "/v1/auth/logout"], ["POST", "/v1/zoom/link/start"], ["GET", "/v1/zoom/link"], ["DELETE", "/v1/zoom/link"], ["POST", "/v1/streams/associate"], ["POST", "/v1/streams/attach"], ["POST", "/v1/rtms/start"]] as const) {
      expect((await call(m, p, { body: {} })).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, { body: {}, bearer: "A".repeat(43) })).status, `${m} ${p} bad bearer`).toBe(401);
    }
  });
});

describe("end to end over HTTP", () => {
  it("login -> link Zoom -> Zoom webhook -> associate -> attach -> start RTMS -> logout; no Zoom secret ever on the wire", async () => {
    const tok = await httpLogin("e2e-user");
    const A = tok.access_token;
    const start = await call("POST", "/v1/zoom/link/start", { bearer: A });
    expect(start.status).toBe(200);
    const zu = zoomUser();
    const { code, state } = env.zoom.consent(start.json.authorize_url, zu);
    const cb = await call("GET", `/v1/zoom/link/callback?state=${state}&code=${code}`, { bearer: A });
    expect(cb.json).toEqual({ linked: true, zoom_user_id: zu.id });
    expect(await call("GET", "/v1/zoom/link", { bearer: A }).then((r) => r.json)).toMatchObject({ linked: true });

    // signed webhook from Zoom
    const m = "e2e-meeting", s = "e2e-stream";
    const hook = JSON.stringify({ event: "meeting.rtms_started", event_ts: 111, payload: { operator_id: zu.id, object: { meeting_uuid: m, rtms_stream_id: s } } });
    const ts = Math.floor(env.clock.now().getTime() / 1000);
    expect((await call("POST", "/v1/zoom/webhook", { raw: hook, headers: { "x-zm-signature": "v0=" + "0".repeat(64), "x-zm-request-timestamp": String(ts) } })).status).toBe(401);
    const good = { "x-zm-signature": signZoom(hook, ts), "x-zm-request-timestamp": String(ts) };
    expect((await call("POST", "/v1/zoom/webhook", { raw: hook, headers: good })).json).toEqual({ received: true, replay: false });
    expect((await call("POST", "/v1/zoom/webhook", { raw: hook, headers: good })).json).toEqual({ received: true, replay: true });

    const assoc = await call("POST", "/v1/streams/associate", { bearer: A, body: { meeting_uuid: m, stream_id: s } });
    expect(assoc.status).toBe(200);
    const att = await call("POST", "/v1/streams/attach", { bearer: A, body: { association_token: assoc.json.association_token } });
    expect(att.json).toEqual({ meeting_uuid: m, stream_id: s });
    expect((await call("POST", "/v1/streams/attach", { bearer: A, body: { association_token: assoc.json.association_token } })).status).toBe(400);

    env.zoom.hosts.set(m, zu.id);
    const rtms = await call("POST", "/v1/rtms/start", { bearer: A, body: { meeting_uuid: m } });
    expect(rtms.json).toEqual({ started: true });
    expect(env.started.at(-1)!.accessToken).toMatch(/^ZT_A_/);

    expect((await call("POST", "/v1/auth/logout", { bearer: A })).status).toBe(200);
    expect((await call("GET", "/v1/zoom/link", { bearer: A })).status).toBe(401);
  });

  it("window/participant names are not accepted anywhere: strict bodies reject them with 400", async () => {
    const tok = await httpLogin("spoofer");
    for (const extra of [{ window_title: "Zoom Meeting - Weekly" }, { participant_name: "Alice" }, { owner_id: "x" }, { zoom_user_id: "zu_1" }])
      for (const [path, base] of [["/v1/streams/associate", { meeting_uuid: "m", stream_id: "s" }], ["/v1/rtms/start", { meeting_uuid: "m" }]] as const)
        expect((await call("POST", path, { bearer: tok.access_token, body: { ...base, ...extra } })).status, `${path} ${Object.keys(extra)}`).toBe(400);
  });

  it("another user's meeting: B gets 403 on associate and on rtms/start; nothing started", async () => {
    const [a, b] = [await httpLogin("owner-a"), await httpLogin("intruder-b")];
    for (const [t, name] of [[a, "a"], [b, "b"]] as const) {
      const st = await call("POST", "/v1/zoom/link/start", { bearer: t.access_token });
      const zu = zoomUser();
      const c = env.zoom.consent(st.json.authorize_url, zu);
      await call("GET", `/v1/zoom/link/callback?state=${c.state}&code=${c.code}`, { bearer: t.access_token });
      if (name === "a") {
        const hook = JSON.stringify({ event: "meeting.rtms_started", event_ts: 222, payload: { operator_id: zu.id, object: { meeting_uuid: "victim-mtg", rtms_stream_id: "victim-strm" } } });
        const ts = Math.floor(env.clock.now().getTime() / 1000);
        await call("POST", "/v1/zoom/webhook", { raw: hook, headers: { "x-zm-signature": signZoom(hook, ts), "x-zm-request-timestamp": String(ts) } });
        env.zoom.hosts.set("victim-mtg", zu.id);
      }
    }
    const before = env.started.length;
    expect((await call("POST", "/v1/streams/associate", { bearer: b.access_token, body: { meeting_uuid: "victim-mtg", stream_id: "victim-strm" } })).status).toBe(403);
    expect((await call("POST", "/v1/rtms/start", { bearer: b.access_token, body: { meeting_uuid: "victim-mtg" } })).status).toBe(403);
    expect(env.started.length).toBe(before);
  });

  it("access token expiry is enforced over HTTP; refresh works; the old access token stays dead", async () => {
    const tok = await httpLogin("expiry");
    env.clock.advance(11 * 60_000);
    expect((await call("GET", "/v1/zoom/link", { bearer: tok.access_token })).status).toBe(401);
    const r = await call("POST", "/v1/auth/token", { body: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLIENT } });
    expect(r.status).toBe(200);
    expect((await call("GET", "/v1/zoom/link", { bearer: r.json.access_token })).status).toBe(200);
    expect((await call("GET", "/v1/zoom/link", { bearer: tok.access_token })).status).toBe(401);
  });

  it("url_validation challenge is answered (needs a valid signature)", async () => {
    const body = JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken: "abc" } });
    const ts = Math.floor(env.clock.now().getTime() / 1000);
    const r = await call("POST", "/v1/zoom/webhook", { raw: body, headers: { "x-zm-signature": signZoom(body, ts), "x-zm-request-timestamp": String(ts) } });
    expect(r.json).toEqual(env.webhook.urlValidation("abc"));
    expect(WEBHOOK_SECRET).toBeTruthy();
  });

  it("deauthorization webhook unlinks the user", async () => {
    const tok = await httpLogin("deauth");
    const st = await call("POST", "/v1/zoom/link/start", { bearer: tok.access_token });
    const zu = zoomUser();
    const c = env.zoom.consent(st.json.authorize_url, zu);
    await call("GET", `/v1/zoom/link/callback?state=${c.state}&code=${c.code}`, { bearer: tok.access_token });
    const body = JSON.stringify({ event: "app_deauthorized", event_ts: 999, payload: { user_id: zu.id } });
    const ts = Math.floor(env.clock.now().getTime() / 1000);
    await call("POST", "/v1/zoom/webhook", { raw: body, headers: { "x-zm-signature": signZoom(body, ts), "x-zm-request-timestamp": String(ts) } });
    expect((await call("GET", "/v1/zoom/link", { bearer: tok.access_token })).json).toMatchObject({ linked: false, status: "revoked" });
  });

  it("no response of this whole file ever contained a Zoom token, a token hash, or a stack trace", () => {
    const all = bodies.join("\n");
    expect(all).not.toMatch(/ZT_[AR]_/);
    expect(all).not.toMatch(/"(token_hash|ciphertext|nonce|verifier|client_secret)"/);
    expect(all).not.toMatch(/\bat \w+.*\.ts:\d+/);
    expect(bodies.length).toBeGreaterThan(30);
  });
});

describe("HttpZoomClient request shapes (against a local mock Zoom)", () => {
  it("sends Basic auth + form body for code exchange and refresh, token for revoke, Bearer for profile; double-encodes odd meeting uuids", async () => {
    const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
    const mock = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: b });
        res.setHeader("content-type", "application/json");
        if (req.url === "/oauth/token") return res.end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s1 s2" }));
        if (req.url === "/oauth/revoke") return res.end("{}");
        if (req.url === "/v2/users/me") return res.end(JSON.stringify({ id: "u1", account_id: "acc" }));
        if (req.url!.startsWith("/v2/meetings/")) return res.end(JSON.stringify({ host_id: "u1" }));
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const port = (mock.address() as AddressInfo).port;
    const z = new HttpZoomClient({ clientId: "cid", clientSecret: "sec", oauthBase: `http://127.0.0.1:${port}`, apiBase: `http://127.0.0.1:${port}/v2` });
    expect(await z.exchangeCode({ code: "c", redirectUri: "https://cb", codeVerifier: "v".repeat(50) })).toMatchObject({ access_token: "a", scope: "s1 s2" });
    await z.refresh("r1");
    await z.revoke("t1");
    const me = await z.getMe("a");
    expect(await z.getMeetingRole("a", "/abc//def", me)).toBe("host");
    expect(await z.getMeetingRole("a", "plain", { id: "other", account_id: "" })).toBe("none");
    mock.close();

    const basic = "Basic " + Buffer.from("cid:sec").toString("base64");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/oauth/token", auth: basic });
    expect(new URLSearchParams(seen[0]!.body).get("code_verifier")).toBe("v".repeat(50));
    expect(new URLSearchParams(seen[0]!.body).get("grant_type")).toBe("authorization_code");
    expect(new URLSearchParams(seen[1]!.body).get("grant_type")).toBe("refresh_token");
    expect(seen[2]).toMatchObject({ url: "/oauth/revoke", auth: basic });
    expect(seen[3]).toMatchObject({ url: "/v2/users/me", auth: "Bearer a" });
    expect(seen[4]!.url).toBe("/v2/meetings/" + encodeURIComponent(encodeURIComponent("/abc//def")));
    const u = new URL(z.authorizeUrl({ state: "st", codeChallenge: "ch", redirectUri: "https://cb" }));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("st");
  });
});

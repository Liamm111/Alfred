import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Signer } from "../src/crypto.js";
import type { AuthError } from "../src/errors.js";
import { StreamService, normalizeZoomEvent, type ZoomStreamEvent } from "../src/streams.js";
import { WEBHOOK_SECRET, loginAndLink, mkEnv, signZoom, type Env } from "./env.js";
import { randomBytes, randomUUID } from "node:crypto";

let env: Env;
beforeAll(async () => (env = await mkEnv()));
afterAll(() => env.db.end());

const code = (e: unknown) => (e as AuthError).code;
async function rejects(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as AuthError; }
  throw new Error("expected rejection");
}
let n = 0;
const started = (zu: string, meeting: string, stream: string): ZoomStreamEvent => ({ event_id: `ev-${++n}`, kind: "rtms_started", zoom_user_id: zu, meeting_uuid: meeting, stream_id: stream });
const ids = () => ({ m: `mtg-${randomUUID()}`, s: `strm-${randomUUID()}` });

describe("Zoom webhook authenticity", () => {
  const body = JSON.stringify({ event: "meeting.rtms_started", event_ts: 1, payload: { operator_id: "u1", object: { meeting_uuid: "m", rtms_stream_id: "s" } } });
  const ts = () => Math.floor(env.clock.now().getTime() / 1000);

  it("accepts a correct signature", () => {
    expect(env.webhook.verify({ signature: signZoom(body, ts()), timestamp: String(ts()) }, body)).toBe(true);
  });
  it("rejects tampered body, wrong secret, missing headers, stale and future timestamps", () => {
    const t = ts();
    expect(env.webhook.verify({ signature: signZoom(body, t), timestamp: String(t) }, body + " ")).toBe(false);
    expect(env.webhook.verify({ signature: signZoom(body, t, "other"), timestamp: String(t) }, body)).toBe(false);
    expect(env.webhook.verify({}, body)).toBe(false);
    expect(env.webhook.verify({ signature: signZoom(body, t - 3600), timestamp: String(t - 3600) }, body)).toBe(false);
    expect(env.webhook.verify({ signature: signZoom(body, t + 3600), timestamp: String(t + 3600) }, body)).toBe(false);
    expect(env.webhook.verify({ signature: "v0=" + "0".repeat(64), timestamp: String(t) }, body)).toBe(false);
    expect(env.webhook.verify({ signature: "", timestamp: "abc" }, body)).toBe(false);
  });
  it("answers the url_validation challenge with HMAC(plainToken)", () => {
    const r = env.webhook.urlValidation("plain123");
    expect(r.plainToken).toBe("plain123");
    expect(r.encryptedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(WEBHOOK_SECRET.length).toBeGreaterThan(0);
  });
  it("events are idempotent: the same event_id is recorded once (replay of a signed webhook)", async () => {
    const e = started("zu-replay", "m1", "s1");
    expect(await env.streams.recordEvent(e)).toBe(true);
    expect(await env.streams.recordEvent(e)).toBe(false);
  });
  it("unknown or malformed event shapes are not normalised (and so can never grant anything)", () => {
    expect(normalizeZoomEvent({ event: "meeting.something_else" })).toBeNull();
    expect(normalizeZoomEvent({ event: "meeting.rtms_started", payload: { object: {} } })).toBeNull();
    expect(normalizeZoomEvent(null)).toBeNull();
    expect(normalizeZoomEvent({ event: "meeting.rtms_started", event_ts: 1, payload: { operator_id: "u", object: { meeting_uuid: "m", rtms_stream_id: "s" } } })).toMatchObject({ kind: "rtms_started", zoom_user_id: "u" });
  });
});

describe("ephemeral signed association meeting_uuid/stream_id", () => {
  it("owner claims its own stream, redeems the token once, and gets exactly meeting/stream back", async () => {
    const a = await loginAndLink(env);
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    const c = await env.streams.claim(a.ownerId, m, s);
    expect(c.association_token.split(".")).toHaveLength(2);
    expect(await env.streams.attach(a.ownerId, c.association_token)).toEqual({ meeting_uuid: m, stream_id: s });
    // single use
    expect(code(await rejects(env.streams.attach(a.ownerId, c.association_token)))).toBe("invalid_grant");
  });

  it("a stolen token is useless to another authenticated user", async () => {
    const [a, b] = [await loginAndLink(env), await loginAndLink(env)];
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    const c = await env.streams.claim(a.ownerId, m, s);
    expect(code(await rejects(env.streams.attach(b.ownerId, c.association_token)))).toBe("forbidden");
    // and A can still use it afterwards (the failed attempt did not burn it)
    expect(await env.streams.attach(a.ownerId, c.association_token)).toMatchObject({ stream_id: s });
  });

  it("expires after 5 minutes", async () => {
    const a = await loginAndLink(env);
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    const c = await env.streams.claim(a.ownerId, m, s);
    env.clock.advance(5 * 60_000 + 1000);
    expect(code(await rejects(env.streams.attach(a.ownerId, c.association_token)))).toBe("invalid_grant");
  });

  it("tampered, truncated, re-signed-with-another-key and structurally odd tokens are refused", async () => {
    const [a, b] = [await loginAndLink(env), await loginAndLink(env)];
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    const c = await env.streams.claim(a.ownerId, m, s);
    const [body, mac] = c.association_token.split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    const swapped = Buffer.from(JSON.stringify({ ...claims, uid: b.ownerId })).toString("base64url") + "." + mac;
    const forged = new Signer({ x: randomBytes(32) }, "x").sign({ ...claims, uid: b.ownerId, kid: "x" });
    const forgedSameKid = new Signer({ s1: randomBytes(32) }, "s1").sign({ ...claims, uid: b.ownerId });
    for (const bad of [swapped, forged, forgedSameKid, c.association_token.slice(0, -3), body!, "a.b.c", "", "....", c.association_token + "x"])
      expect(code(await rejects(env.streams.attach(b.ownerId, bad))), bad.slice(0, 20)).toMatch(/invalid_grant|forbidden/);
    // the genuine token is still redeemable
    expect(await env.streams.attach(a.ownerId, c.association_token)).toBeTruthy();
  });

  it("revocation (or unlinking Zoom) invalidates outstanding associations", async () => {
    const a = await loginAndLink(env);
    const [x, y] = [ids(), ids()];
    for (const i of [x, y]) await env.streams.recordEvent(started(a.zu.id, i.m, i.s));
    const c1 = await env.streams.claim(a.ownerId, x.m, x.s);
    const c2 = await env.streams.claim(a.ownerId, y.m, y.s);
    await env.streams.revoke(a.ownerId, x.m, x.s);
    expect(code(await rejects(env.streams.attach(a.ownerId, c1.association_token)))).toBe("invalid_grant");
    await env.links.unlink(a.ownerId);
    expect(code(await rejects(env.streams.attach(a.ownerId, c2.association_token)))).toBe("invalid_grant");
  });
});

describe("attempts to take over somebody else's meeting/stream", () => {
  it("user B can not claim A's (meeting, stream): Zoom's verified event names A's Zoom user", async () => {
    const [a, b] = [await loginAndLink(env), await loginAndLink(env)];
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    expect(code(await rejects(env.streams.claim(b.ownerId, m, s)))).toBe("forbidden");
    // nothing was created for B
    expect((await env.db.query("select 1 from stream_associations where owner_id=$1", [b.ownerId])).rowCount).toBe(0);
  });

  it("B swapping only the stream id or only the meeting id of A's stream is refused", async () => {
    const [a, b] = [await loginAndLink(env), await loginAndLink(env)];
    const mine = ids(), theirs = ids();
    await env.streams.recordEvent(started(a.zu.id, theirs.m, theirs.s));
    await env.streams.recordEvent(started(b.zu.id, mine.m, mine.s));
    expect(code(await rejects(env.streams.claim(b.ownerId, mine.m, theirs.s)))).toBe("forbidden");
    expect(code(await rejects(env.streams.claim(b.ownerId, theirs.m, mine.s)))).toBe("forbidden");
    // both users legitimately attached to the SAME meeting (two participants) each get their own stream
    const sameMeeting = ids();
    await env.streams.recordEvent(started(a.zu.id, sameMeeting.m, "stream-a"));
    await env.streams.recordEvent(started(b.zu.id, sameMeeting.m, "stream-b"));
    await env.streams.claim(a.ownerId, sameMeeting.m, "stream-a");
    await env.streams.claim(b.ownerId, sameMeeting.m, "stream-b");
    expect(code(await rejects(env.streams.claim(b.ownerId, sameMeeting.m, "stream-a")))).toBe("forbidden");
  });

  it("no proof from Zoom, no claim: unknown stream, stale event, stopped stream", async () => {
    const a = await loginAndLink(env);
    const unknown = ids();
    expect(code(await rejects(env.streams.claim(a.ownerId, unknown.m, unknown.s)))).toBe("forbidden");
    const old = ids();
    await env.streams.recordEvent(started(a.zu.id, old.m, old.s));
    env.clock.advance(11 * 60_000);
    expect(code(await rejects(env.streams.claim(a.ownerId, old.m, old.s)))).toBe("forbidden");
    const stopped = ids();
    await env.streams.recordEvent(started(a.zu.id, stopped.m, stopped.s));
    await env.streams.recordEvent({ ...started(a.zu.id, stopped.m, stopped.s), kind: "rtms_stopped" });
    expect(code(await rejects(env.streams.claim(a.ownerId, stopped.m, stopped.s)))).toBe("forbidden");
  });

  it("a stream can be associated only once (second claim conflicts)", async () => {
    const a = await loginAndLink(env);
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    await env.streams.claim(a.ownerId, m, s);
    expect(code(await rejects(env.streams.claim(a.ownerId, m, s)))).toBe("conflict");
  });

  it("10 simultaneous claims of the same stream: exactly one token is issued", async () => {
    const a = await loginAndLink(env);
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    const r = await Promise.allSettled(Array.from({ length: 10 }, () => env.streams.claim(a.ownerId, m, s)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("a user whose Zoom link was revoked can no longer claim, even for a genuine stream", async () => {
    const a = await loginAndLink(env);
    const { m, s } = ids();
    await env.streams.recordEvent(started(a.zu.id, m, s));
    await env.links.unlink(a.ownerId);
    expect(code(await rejects(env.streams.claim(a.ownerId, m, s)))).toBe("forbidden");
  });

  it("the service API has no parameter for window/participant names (nothing to spoof)", () => {
    expect(StreamService.prototype.claim.length).toBe(3); // (ownerId, meetingUuid, streamId)
  });
});

describe("never start RTMS for somebody else, never leak the Zoom token", () => {
  it("the host starts RTMS: the starter gets the server-side token; the result contains none", async () => {
    const a = await loginAndLink(env);
    const m = ids().m;
    env.zoom.hosts.set(m, a.zu.id);
    const res = await env.streams.authorizeRtmsStart(a.ownerId, m, env.rtms);
    expect(res).toEqual({ started: true });
    const call = env.started.at(-1)!;
    expect(call).toMatchObject({ meetingUuid: m, zoomUserId: a.zu.id });
    expect(call.accessToken).toMatch(/^ZT_A_/);
    expect(JSON.stringify(res)).not.toContain("ZT_");
  });

  it("someone who is not the host is refused and the starter is never called", async () => {
    const [host, other] = [await loginAndLink(env), await loginAndLink(env)];
    const m = ids().m;
    env.zoom.hosts.set(m, host.zu.id);
    const before = env.started.length;
    expect(code(await rejects(env.streams.authorizeRtmsStart(other.ownerId, m, env.rtms)))).toBe("forbidden");
    expect(code(await rejects(env.streams.authorizeRtmsStart(other.ownerId, "unknown-meeting", env.rtms)))).toBe("forbidden");
    expect(env.started.length).toBe(before);
  });

  it("an unlinked, revoked or re-auth-needed user is refused before any Zoom call", async () => {
    const { login } = await import("./env.js");
    const noLink = await login(env);
    const a = await loginAndLink(env);
    await env.links.unlink(a.ownerId);
    const before = env.zoom.calls.getMe;
    expect(code(await rejects(env.streams.authorizeRtmsStart(noLink.ownerId, "m", env.rtms)))).toBe("forbidden");
    expect(code(await rejects(env.streams.authorizeRtmsStart(a.ownerId, "m", env.rtms)))).toBe("forbidden");
    expect(env.zoom.calls.getMe).toBe(before);
  });

  it("if Zoom answers with a different identity than the linked one, nothing starts", async () => {
    const a = await loginAndLink(env);
    const m = ids().m;
    env.zoom.hosts.set(m, "someone-else");
    env.zoom.meOverride = { id: "someone-else", account_id: "x" };
    const before = env.started.length;
    expect(code(await rejects(env.streams.authorizeRtmsStart(a.ownerId, m, env.rtms)))).toBe("forbidden");
    env.zoom.meOverride = null;
    expect(env.started.length).toBe(before);
  });
});

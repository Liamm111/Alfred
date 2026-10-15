import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS as T, RegistryError, SessionRegistry, checkInvariants, presentState, type Clock } from "../../src/contracts/index.js";
import { Sim } from "./helpers.js";

const clock = (): Clock => ({ wall_ms: 1_700_000_000_000, mono_ms: 50_000 });

function open(reg: SessionRegistry, owner: string, now: Clock, meeting = "m") {
  const id = randomUUID();
  reg.create({ session_id: id, owner_id: owner }, now);
  reg.dispatch(owner, id, { type: "DETECT", meeting_uuid: meeting }, now);
  reg.dispatch(owner, id, { type: "REQUEST_PERMISSION" }, now);
  reg.dispatch(owner, id, { type: "PERMISSION_GRANTED", source_epoch: 1 }, now);
  return id;
}
const pkt = (sim: Sim, sessionId: string, ownerId: string, mod: "audio" | "video", now: Clock) => {
  sim.session_id = sessionId;
  sim.owner_id = ownerId;
  sim.now = now;
  return { type: "PACKET" as const, packet: sim.packet(mod, { source_epoch: 1, seq: 0 }) };
};

describe("two sessions", () => {
  it("a second active session for the same owner is refused", () => {
    const reg = new SessionRegistry();
    const owner = randomUUID();
    const now = clock();
    open(reg, owner, now);
    const second = randomUUID();
    reg.create({ session_id: second, owner_id: owner }, now);
    expect(() => reg.dispatch(owner, second, { type: "DETECT", meeting_uuid: "other" }, now)).toThrowError(
      expect.objectContaining({ code: "ALREADY_ACTIVE" }),
    );
  });

  it("sessions of different owners are independent: liveness never leaks", () => {
    const reg = new SessionRegistry();
    const [o1, o2] = [randomUUID(), randomUUID()];
    const now = clock();
    const a = open(reg, o1, now, "mA");
    const b = open(reg, o2, now, "mB");
    const sim = new Sim();
    // audio for A
    expect(reg.dispatch(o1, a, pkt(sim, a, o1, "audio", now), now).ok).toBe(true);
    expect(reg.get(a)!.state).toBe("LIVE_AUDIO");
    expect(reg.get(b)!.state).toBe("CONNECTING");
    // A's packet replayed into B must be refused (wrong session / owner)
    const stolen = pkt(sim, a, o1, "audio", now);
    const r = reg.dispatch(o2, b, stolen, now);
    expect(r.ok && r.effects).toContainEqual(expect.objectContaining({ reason: "wrong_session" }));
    expect(reg.get(b)!.state).toBe("CONNECTING");
    expect(reg.get(b)!.verified_packets).toBe(0);
    // stopping A does not touch B
    reg.dispatch(o1, a, { type: "STOP" }, now);
    expect(reg.get(a)!.state).toBe("FINALIZING");
    expect(reg.get(b)!.state).toBe("CONNECTING");
  });

  it("an owner can not drive another owner's session", () => {
    const reg = new SessionRegistry();
    const [o1, o2] = [randomUUID(), randomUUID()];
    const a = open(reg, o1, clock());
    expect(() => reg.dispatch(o2, a, { type: "STOP" }, clock())).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => reg.dispatch(o1, randomUUID(), { type: "STOP" }, clock())).toThrowError(RegistryError);
  });

  it("tickAll advances each session independently", () => {
    const reg = new SessionRegistry();
    const [o1, o2] = [randomUUID(), randomUUID()];
    const now = clock();
    const a = open(reg, o1, now);
    const b = open(reg, o2, now);
    const sim = new Sim();
    reg.dispatch(o1, a, pkt(sim, a, o1, "audio", now), now);
    const later = { wall_ms: now.wall_ms + T.connect_timeout_ms, mono_ms: now.mono_ms + T.connect_timeout_ms };
    reg.tickAll(later);
    expect(reg.get(a)!.state).toBe("DEGRADED"); // had media, went silent
    expect(reg.get(b)!.state).toBe("FAILED"); // never had media
  });
});

describe("atomic stop-all", () => {
  it("stops every active session in one operation and reports stop_sources for each", () => {
    const reg = new SessionRegistry();
    const now = clock();
    const owners = [randomUUID(), randomUUID(), randomUUID()];
    const ids = owners.map((o, i) => open(reg, o, now, `m${i}`));
    // one idle (not active) session must be ignored
    reg.create({ session_id: randomUUID(), owner_id: randomUUID() }, now);
    const { stopped, effects } = reg.stopAll(now);
    expect(stopped.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(reg.get(id)!.state).toBe("FINALIZING");
      expect(effects.get(id)!.map((e) => e.kind)).toContain("stop_sources");
    }
    // second stop-all is a harmless no-op (double Stop)
    expect(reg.stopAll(now).stopped).toEqual([]);
  });

  it("is all-or-nothing: a corrupt session aborts the whole stop-all and nothing changes", () => {
    const reg = new SessionRegistry();
    const now = clock();
    const [o1, o2] = [randomUUID(), randomUUID()];
    const a = open(reg, o1, now, "a");
    const b = open(reg, o2, now, "b");
    // Corrupt B (forged LIVE with no packet) - simulates memory/persistence corruption.
    (reg.get(b) as { state: string }).state = "LIVE_AV";
    expect(checkInvariants(reg.get(b)!).length).toBeGreaterThan(0);
    expect(() => reg.stopAll(now)).toThrowError(expect.objectContaining({ code: "INVARIANT" }));
    expect(reg.get(a)!.state).toBe("CONNECTING"); // untouched although it was valid
    // and the forged LIVE is not believable to the presentation layer either
    expect(presentState(reg.get(b)!, now.mono_ms).live).toBe(false);
  });

  it("can be restricted to one owner", () => {
    const reg = new SessionRegistry();
    const now = clock();
    const [o1, o2] = [randomUUID(), randomUUID()];
    const a = open(reg, o1, now, "a");
    const b = open(reg, o2, now, "b");
    reg.stopAll(now, o1);
    expect(reg.get(a)!.state).toBe("FINALIZING");
    expect(reg.get(b)!.state).toBe("CONNECTING");
  });
});

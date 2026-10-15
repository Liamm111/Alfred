import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  ALL_STATES,
  DEFAULT_THRESHOLDS as T,
  EVENT_TYPES_ALL,
  LIVE_STATES,
  assertLiveClaim,
  checkInvariants,
  isLive,
  isTerminal,
  presentState,
  step,
  stepOrThrow,
  newContext,
} from "../src/index.js";
import { Sim, reach, sampleEvent, toConnecting } from "./helpers.js";

describe("transition matrix (exhaustive)", () => {
  for (const state of ALL_STATES) {
    for (const type of EVENT_TYPES_ALL) {
      const legal = ALLOWED[type].includes(state);
      it(`${state} x ${type} -> ${legal ? "accepted" : "INVALID_TRANSITION"}`, () => {
        const s = reach(state);
        expect(s.state).toBe(state);
        const before = s.ctx;
        const r = step(s.ctx, sampleEvent(s, type), s.now);
        if (legal) {
          expect(r.ok, JSON.stringify(r)).toBe(true);
        } else {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
          expect(r.ctx).toBe(before); // untouched, same reference
          expect(r.effects).toEqual([]);
        }
        expect(checkInvariants(r.ctx)).toEqual([]);
      });
    }
  }

  it("terminal states are absorbing: only TICK/STOP are tolerated, both no-ops", () => {
    for (const st of ["COMPLETED", "PARTIAL", "FAILED"] as const) {
      const s = reach(st);
      const v = s.ctx.version;
      for (const type of EVENT_TYPES_ALL) {
        const r = step(s.ctx, sampleEvent(s, type), s.now);
        if (r.ok) {
          expect(["TICK", "STOP"]).toContain(type);
          expect(r.ctx.state).toBe(st);
          expect(r.ctx.version).toBe(v);
        }
      }
    }
  });

  it("unknown event types are rejected, not ignored", () => {
    const s = reach("CONNECTING");
    const r = step(s.ctx, { type: "TELEPORT" } as never, s.now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_EVENT");
  });

  it("stepOrThrow throws on invalid transitions", () => {
    const s = new Sim();
    expect(() => stepOrThrow(s.ctx, { type: "FINALIZED" }, s.now)).toThrow(/not allowed/);
  });
});

describe("happy path and outcomes", () => {
  it("IDLE→…→LIVE_AV→FINALIZING→COMPLETED", () => {
    const s = reach("LIVE_AV");
    s.advance(500).feed("audio");
    s.send({ type: "STOP" });
    expect(s.state).toBe("FINALIZING");
    s.send({ type: "FINALIZED" });
    expect(s.state).toBe("COMPLETED");
    expect(s.ctx.outcome).toBe("completed");
    expect(checkInvariants(s.ctx)).toEqual([]);
  });
  it("loss of coverage => PARTIAL, never COMPLETED", () => {
    expect(reach("PARTIAL").state).toBe("PARTIAL");
    expect(reach("PARTIAL").ctx.failure_reason).toBe("coverage_gaps");
  });
  it("no media ever => FAILED even if Stop is clean", () => {
    const s = toConnecting();
    s.send({ type: "CONNECTED" });
    s.send({ type: "STOP" });
    s.send({ type: "FINALIZED" });
    expect(s.state).toBe("FAILED");
    expect(s.ctx.failure_reason).toBe("no_media_received");
  });
  it("permission denied => FAILED(permission_denied)", () => {
    const s = reach("PERMISSION");
    s.send({ type: "PERMISSION_DENIED" });
    expect(s.state).toBe("FAILED");
    expect(s.ctx.failure_reason).toBe("permission_denied");
  });
  it("FATAL after media goes through FINALIZING and ends PARTIAL", () => {
    const s = reach("LIVE_AUDIO");
    s.send({ type: "FATAL", reason: "decoder_crash" });
    expect(s.state).toBe("FINALIZING");
    s.send({ type: "FINALIZED" });
    expect(s.state).toBe("PARTIAL");
  });
  it("finalize timeout forces a terminal state (never COMPLETED)", () => {
    const s = reach("FINALIZING");
    s.advance(T.finalize_timeout_ms).send({ type: "TICK" });
    expect(s.state).toBe("PARTIAL");
  });
});

describe("FAIL-SAFE: a started/connected callback never proves media", () => {
  it("CONNECTED leaves state CONNECTING, not live, version unaffected by claims", () => {
    const s = toConnecting();
    s.send({ type: "CONNECTED" });
    expect(s.state).toBe("CONNECTING");
    expect(presentState(s.ctx, s.now.mono_ms).live).toBe(false);
    expect(() => assertLiveClaim(s.ctx, s.now.mono_ms)).toThrow();
  });
  it("connected callback + silence: warns at connect_warn_ms, FAILS at connect_timeout_ms", () => {
    const s = toConnecting();
    s.send({ type: "CONNECTED" });
    s.advance(T.connect_warn_ms).send({ type: "TICK" });
    expect(s.state).toBe("CONNECTING");
    expect(s.ctx.active_alerts).toContain("connected_without_media");
    s.advance(T.connect_timeout_ms - T.connect_warn_ms).send({ type: "TICK" });
    expect(s.state).toBe("FAILED");
    expect(s.ctx.failure_reason).toBe("connect_timeout");
    expect(s.kinds()).toContain("stop_sources");
  });
  it("many CONNECTED callbacks in a row still never produce LIVE", () => {
    const s = toConnecting();
    for (let i = 0; i < 50; i++) s.advance(100).send({ type: "CONNECTED" });
    expect(isLive(s.state)).toBe(false);
  });
  it("transcript alone is not media proof", () => {
    const s = toConnecting();
    s.feed("transcript");
    expect(s.state).toBe("CONNECTING");
    expect(s.ctx.verified_packets).toBe(1);
  });
  it("a zero-byte packet is not media proof", () => {
    const s = toConnecting();
    const r = s.feed("audio", { payload_bytes: 0 });
    expect(s.state).toBe("CONNECTING");
    expect(r.effects).toContainEqual(expect.objectContaining({ kind: "packet_rejected", reason: "empty_payload" }));
  });
  it("an expired packet is not media proof", () => {
    const s = toConnecting();
    s.feed("audio", { received_mono_ms: s.now.mono_ms - T.modality.audio.max_packet_age_ms - 1 });
    expect(s.state).toBe("CONNECTING");
  });
  it("presentState downgrades a stored LIVE when no tick ran (stalled process)", () => {
    const s = reach("LIVE_AV");
    const later = s.now.mono_ms + 60_000;
    expect(s.state).toBe("LIVE_AV");
    const p = presentState(s.ctx, later);
    expect(p).toEqual({ state: "DEGRADED", live: false, downgraded: true });
    expect(() => assertLiveClaim(s.ctx, later)).toThrow();
    // partial staleness: only audio stale
    s.advance(T.modality.audio.fresh_ms + 1).feed("video");
    expect(presentState(s.ctx, s.now.mono_ms).state).toBe("LIVE_VIDEO");
  });
  it("presentState fails closed when the monotonic clock goes backwards", () => {
    const s = reach("LIVE_AUDIO");
    expect(presentState(s.ctx, s.now.mono_ms - 1).live).toBe(false);
  });
});

describe("modalities: audio only, video only, both", () => {
  it("audio only → LIVE_AUDIO and stays so", () => {
    const s = toConnecting();
    s.feed("audio");
    expect(s.state).toBe("LIVE_AUDIO");
    for (let i = 0; i < 5; i++) s.advance(1000).feed("audio").valueOf(), s.send({ type: "TICK" });
    expect(s.state).toBe("LIVE_AUDIO");
    expect(s.ctx.gaps_total).toBe(0);
  });
  it("video only → LIVE_VIDEO", () => {
    const s = toConnecting();
    s.feed("video");
    expect(s.state).toBe("LIVE_VIDEO");
  });
  it("audio then video → LIVE_AV; losing one degrades to the other with a gap, not to DEGRADED", () => {
    const s = toConnecting();
    s.feed("audio");
    s.feed("video");
    expect(s.state).toBe("LIVE_AV");
    s.advance(T.modality.audio.fresh_ms + 1).feed("video").valueOf();
    s.send({ type: "TICK" });
    expect(s.state).toBe("LIVE_VIDEO");
    expect(s.ctx.open_gaps.audio).not.toBeNull();
    expect(s.ctx.active_alerts).toContain("modality_lost");
    s.advance(100).feed("audio");
    expect(s.state).toBe("LIVE_AV");
    expect(s.ctx.open_gaps.audio).toBeNull();
    expect(s.ctx.active_alerts).not.toContain("modality_lost");
  });
});

describe("silence and recovery", () => {
  it("total silence → DEGRADED + gaps + alert; later packets bring LIVE back and close gaps", () => {
    const s = reach("LIVE_AV");
    s.advance(T.modality.video.fresh_ms + 1).send({ type: "TICK" });
    expect(s.state).toBe("DEGRADED");
    expect(s.ctx.open_gaps.audio?.reason).toBe("silence");
    expect(s.ctx.open_gaps.video?.reason).toBe("silence");
    expect(s.ctx.active_alerts).toContain("media_silence");
    s.advance(10).feed("audio");
    expect(s.state).toBe("LIVE_AUDIO");
    expect(s.ctx.open_gaps.audio).toBeNull();
    expect(s.ctx.open_gaps.video).not.toBeNull(); // video still missing
    expect(s.ctx.active_alerts).not.toContain("media_silence");
  });
  it("DEGRADED long enough requests recovery once", () => {
    const s = reach("DEGRADED");
    s.advance(T.degraded_recovery_after_ms).send({ type: "TICK" });
    s.advance(1000).send({ type: "TICK" });
    expect(s.kinds().filter((k) => k === "request_recovery")).toHaveLength(1);
  });
  it("RECOVERY_STARTED needs a strictly newer source_epoch and media proof on that epoch", () => {
    const s = reach("DEGRADED");
    const bad = s.try({ type: "RECOVERY_STARTED", source_epoch: s.ctx.source_epoch });
    expect(bad.ok).toBe(false);
    s.send({ type: "RECOVERY_STARTED", source_epoch: 2 });
    expect(s.state).toBe("RECOVERING");
    s.send({ type: "CONNECTED" });
    expect(s.state).toBe("RECOVERING"); // callback again proves nothing
    s.feed("audio", { source_epoch: 1, seq: 999 }); // old epoch
    expect(s.state).toBe("RECOVERING");
    s.advance(50).feed("audio");
    expect(s.state).toBe("LIVE_AUDIO");
  });
  it("recovery timeout → FINALIZING → PARTIAL", () => {
    const s = reach("RECOVERING");
    s.advance(T.recovery_timeout_ms).send({ type: "TICK" });
    expect(s.state).toBe("FINALIZING");
    s.send({ type: "FINALIZED" });
    expect(s.state).toBe("PARTIAL");
  });
  it("RECOVERY_FAILED → FINALIZING(fatal)", () => {
    const s = reach("RECOVERING");
    s.send({ type: "RECOVERY_FAILED" });
    expect(s.state).toBe("FINALIZING");
  });
  it("SOURCE_LOST while live → DEGRADED with source_lost gaps; before media → FAILED", () => {
    const s = reach("LIVE_AUDIO");
    s.send({ type: "SOURCE_LOST" });
    expect(s.state).toBe("DEGRADED");
    expect(s.ctx.open_gaps.audio?.reason).toBe("source_lost");
    const c = toConnecting();
    c.send({ type: "SOURCE_LOST" });
    expect(c.state).toBe("FAILED");
  });
  it("pause drops packets, opens paused gaps; resume needs new epoch and fresh proof", () => {
    const s = reach("PAUSED");
    const r = s.feed("audio");
    expect(r.effects).toContainEqual(expect.objectContaining({ reason: "paused" }));
    expect(s.ctx.open_gaps.audio?.reason).toBe("paused");
    expect(s.try({ type: "RESUME", source_epoch: 1 }).ok).toBe(false);
    s.send({ type: "RESUME", source_epoch: 2 });
    expect(s.state).toBe("RECOVERING");
    s.feed("audio");
    expect(s.state).toBe("LIVE_AUDIO");
    expect(s.ctx.open_gaps.audio).toBeNull();
  });
});

describe("packet validation", () => {
  const rejected = (s: Sim, reason: string) =>
    expect(s.effects).toContainEqual(expect.objectContaining({ kind: "packet_rejected", reason }));

  it("expired by receiver queueing delay", () => {
    const s = toConnecting();
    s.feed("audio", { received_mono_ms: s.now.mono_ms - T.modality.audio.max_packet_age_ms - 1 });
    rejected(s, "expired");
    expect(s.ctx.verified_packets).toBe(0);
  });
  it("expired by source lag (captured long ago)", () => {
    const s = toConnecting();
    s.feed("video", { source_ts_ms: s.now.wall_ms - T.modality.video.max_source_lag_ms - 1 });
    rejected(s, "expired");
  });
  it("source clock in the future / receive time in the future", () => {
    const s = toConnecting();
    s.feed("audio", { source_ts_ms: s.now.wall_ms + T.max_future_skew_ms + 1 });
    rejected(s, "clock_skew_future");
    expect(s.ctx.active_alerts).toContain("clock_skew");
    s.feed("audio", { received_mono_ms: s.now.mono_ms + 1 });
    expect(s.state).toBe("CONNECTING");
  });
  it("stale and unannounced epochs", () => {
    const s = reach("RECOVERING"); // epoch 2
    s.feed("audio", { source_epoch: 1 });
    rejected(s, "stale_epoch");
    s.feed("audio", { source_epoch: 3 });
    rejected(s, "unknown_epoch");
    expect(s.state).toBe("RECOVERING");
  });
  it("duplicate and out-of-order seq", () => {
    const s = reach("LIVE_AUDIO"); // seq 0 consumed
    s.feed("audio", { seq: 5 });
    s.feed("audio", { seq: 5 });
    rejected(s, "duplicate");
    s.feed("audio", { seq: 3 });
    rejected(s, "out_of_order");
    expect(s.ctx.verified_packets).toBe(2);
  });
  it("packet for another session / owner is rejected", () => {
    const s = toConnecting();
    s.feed("audio", { session_id: crypto.randomUUID() });
    rejected(s, "wrong_session");
    s.feed("audio", { owner_id: crypto.randomUUID() });
    expect(s.state).toBe("CONNECTING");
  });
  it("late packet during FINALIZING is stored but cannot change liveness", () => {
    const s = reach("FINALIZING");
    const before = s.ctx.verified_packets;
    s.advance(100).feed("video");
    expect(s.effects).toContainEqual(expect.objectContaining({ kind: "packet_accepted", late: true }));
    expect(s.state).toBe("FINALIZING");
    expect(s.ctx.verified_packets).toBe(before);
  });
  it("rejections never bump the version", () => {
    const s = toConnecting();
    const v = s.ctx.version;
    s.feed("audio", { payload_bytes: 0 });
    expect(s.ctx.version).toBe(v);
  });
});

describe("Stop semantics", () => {
  it("double Stop is idempotent: one stop_sources, second is a visible no-op", () => {
    const s = reach("LIVE_AV");
    s.send({ type: "STOP" });
    const v = s.ctx.version;
    const again = s.send({ type: "STOP" });
    expect(again.effects).toEqual([{ kind: "noop", reason: "already_stopping" }]);
    expect(s.ctx.version).toBe(v);
    expect(s.kinds().filter((k) => k === "stop_sources")).toHaveLength(1);
    s.send({ type: "FINALIZED" });
    const third = s.send({ type: "STOP" });
    expect(third.effects).toEqual([{ kind: "noop", reason: "already_stopping" }]);
  });
  it("Stop in IDLE is a no-op; before capture it cancels to IDLE", () => {
    expect(new Sim().send({ type: "STOP" }).effects[0]).toEqual({ kind: "noop", reason: "nothing_to_stop" });
    const s = reach("PERMISSION");
    s.send({ type: "STOP" });
    expect(s.state).toBe("IDLE");
  });
  it("Stop from every capture state lands in FINALIZING with stop_sources", () => {
    for (const st of ["CONNECTING", ...LIVE_STATES, "DEGRADED", "PAUSED", "RECOVERING"] as const) {
      const s = reach(st);
      const r = s.send({ type: "STOP" });
      expect(s.state, st).toBe("FINALIZING");
      expect(r.effects.map((e) => e.kind)).toContain("stop_sources");
    }
  });
});

describe("fuzz: invariants hold on random event sequences", () => {
  // Small seeded PRNG so failures are reproducible.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  it("never LIVE without an accepted packet, never invalid terminal, 3000 runs", () => {
    for (let run = 0; run < 3000; run++) {
      const r = rng(run + 1);
      const s = new Sim();
      for (let i = 0; i < 40; i++) {
        s.advance(Math.floor(r() * 4000));
        const type = EVENT_TYPES_ALL[Math.floor(r() * EVENT_TYPES_ALL.length)]!;
        let ev = sampleEvent(s, type);
        if (type === "PACKET") {
          const mod = (["audio", "video", "transcript"] as const)[Math.floor(r() * 3)]!;
          ev = {
            type,
            packet: s.packet(mod, {
              seq: Math.floor(r() * 50),
              payload_bytes: r() < 0.1 ? 0 : 100,
              source_epoch: r() < 0.15 ? 1 + Math.floor(r() * 3) : s.ctx.source_epoch,
            }),
          };
        }
        const prev = s.ctx;
        const res = s.try(ev);
        if (isLive(s.ctx.state) && !isLive(prev.state)) {
          expect(type, `run ${run}: LIVE entered via ${type}`).toBe("PACKET");
        }
        expect(checkInvariants(s.ctx), `run ${run} after ${type}`).toEqual([]);
        if (!res.ok) expect(res.ctx).toBe(prev);
        if (isTerminal(prev.state)) expect(s.ctx.state).toBe(prev.state);
      }
    }
  });
  it("newContext is IDLE and invariant-clean", () => {
    const c = newContext({ session_id: crypto.randomUUID(), owner_id: crypto.randomUUID() }, { wall_ms: 1, mono_ms: 1 });
    expect(checkInvariants(c)).toEqual([]);
  });
});

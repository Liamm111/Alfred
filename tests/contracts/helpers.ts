import { randomUUID, createHash } from "node:crypto";
import {
  SCHEMA_VERSION,
  newContext,
  step,
  type Clock,
  type Effect,
  type MachineEvent,
  type Modality,
  type Packet,
  type SessionContext,
  type SessionState,
  type Thresholds,
  DEFAULT_THRESHOLDS,
} from "../../src/contracts/index.js";

/** Deterministic driver around the pure machine. */
export class Sim {
  ctx: SessionContext;
  now: Clock = { wall_ms: 1_700_000_000_000, mono_ms: 100_000 };
  effects: Effect[] = [];
  private seq: Record<string, number> = {};
  constructor(
    public session_id: string = randomUUID(),
    public owner_id: string = randomUUID(),
    private t: Thresholds = DEFAULT_THRESHOLDS,
  ) {
    this.ctx = newContext({ session_id, owner_id }, this.now);
  }
  advance(ms: number) {
    this.now = { wall_ms: this.now.wall_ms + ms, mono_ms: this.now.mono_ms + ms };
    return this;
  }
  /** Send an event; asserts it was accepted by the machine. */
  send(e: MachineEvent) {
    const r = this.try(e);
    if (!r.ok) throw new Error(`unexpected ${r.code}: ${r.message}`);
    return r;
  }
  try(e: MachineEvent) {
    const r = step(this.ctx, e, this.now, this.t);
    if (r.ok) {
      this.ctx = r.ctx;
      this.effects.push(...r.effects);
    }
    return r;
  }
  packet(modality: Modality, o: Partial<Packet> = {}): Packet {
    const epoch = o.source_epoch ?? this.ctx.source_epoch;
    const key = `${epoch}:${modality}`;
    const seq = o.seq ?? (this.seq[key] = (this.seq[key] ?? -1) + 1);
    return {
      schema_version: SCHEMA_VERSION,
      id: randomUUID(),
      session_id: this.session_id,
      owner_id: this.owner_id,
      source_epoch: epoch,
      modality,
      seq,
      source_ts_ms: this.now.wall_ms - 40,
      received_wall_ms: this.now.wall_ms,
      received_mono_ms: this.now.mono_ms,
      payload_bytes: 320,
      payload_sha256: createHash("sha256").update(`${modality}${seq}`).digest("hex"),
      idempotency_key: `${this.session_id}:${epoch}:${modality}:${seq}`,
      ...o,
    };
  }
  feed(modality: Modality, o: Partial<Packet> = {}) {
    return this.send({ type: "PACKET", packet: this.packet(modality, o) });
  }
  get state(): SessionState {
    return this.ctx.state;
  }
  kinds() {
    return this.effects.map((e) => e.kind);
  }
}

export function toConnecting(s = new Sim()): Sim {
  s.send({ type: "DETECT", meeting_uuid: "mtg-1" });
  s.send({ type: "REQUEST_PERMISSION" });
  s.send({ type: "PERMISSION_GRANTED", source_epoch: 1, stream_id: "stream-1" });
  return s;
}

/** Reach each state through legitimate events only (never by forging a context). */
export function reach(state: SessionState): Sim {
  const s = new Sim();
  switch (state) {
    case "IDLE":
      return s;
    case "DETECTED":
      s.send({ type: "DETECT", meeting_uuid: "mtg-1" });
      return s;
    case "PERMISSION":
      s.send({ type: "DETECT", meeting_uuid: "mtg-1" });
      s.send({ type: "REQUEST_PERMISSION" });
      return s;
    case "CONNECTING":
      return toConnecting(s);
    case "LIVE_AUDIO":
      toConnecting(s).feed("audio");
      return s;
    case "LIVE_VIDEO":
      toConnecting(s).feed("video");
      return s;
    case "LIVE_AV":
      toConnecting(s).feed("audio");
      s.feed("video");
      return s;
    case "DEGRADED":
      reach("LIVE_AUDIO");
      toConnecting(s).feed("audio");
      s.advance(DEFAULT_THRESHOLDS.modality.audio.fresh_ms + 1).send({ type: "TICK" });
      return s;
    case "PAUSED":
      toConnecting(s).feed("audio");
      s.send({ type: "PAUSE" });
      return s;
    case "RECOVERING":
      return reachRecovering(s);
    case "FINALIZING":
      toConnecting(s).feed("audio");
      s.send({ type: "STOP" });
      return s;
    case "COMPLETED":
      toConnecting(s).feed("audio");
      s.send({ type: "STOP" });
      s.send({ type: "FINALIZED" });
      return s;
    case "PARTIAL":
      toConnecting(s).feed("audio");
      s.advance(DEFAULT_THRESHOLDS.modality.audio.fresh_ms + 1).send({ type: "TICK" });
      s.send({ type: "STOP" });
      s.send({ type: "FINALIZED" });
      return s;
    case "FAILED":
      toConnecting(s);
      s.send({ type: "FATAL", reason: "boom" });
      return s;
  }
}

function reachRecovering(s: Sim): Sim {
  toConnecting(s).feed("audio");
  s.advance(DEFAULT_THRESHOLDS.modality.audio.fresh_ms + 1).send({ type: "TICK" });
  s.send({ type: "RECOVERY_STARTED", source_epoch: 2 });
  return s;
}

/** One valid instance of every event type (used by the exhaustive matrix). */
export function sampleEvent(s: Sim, type: MachineEvent["type"]): MachineEvent {
  switch (type) {
    case "DETECT":
      return { type, meeting_uuid: "mtg-x" };
    case "PERMISSION_GRANTED":
      return { type, source_epoch: s.ctx.source_epoch + 1 };
    case "RESUME":
    case "RECOVERY_STARTED":
      return { type, source_epoch: s.ctx.source_epoch + 1 };
    case "PACKET":
      return { type, packet: s.packet("audio") };
    case "FATAL":
      return { type, reason: "x" };
    default:
      return { type } as MachineEvent;
  }
}

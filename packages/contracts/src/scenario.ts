/**
 * Replayable scenario format shared by TS tests, public fixtures and (future) Swift tests.
 * A scenario is a timeline of steps; each step advances both clocks, sends one event and
 * states the session state expected afterwards.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULT_THRESHOLDS } from "./freshness.js";
import { Modality, SCHEMA_VERSION, SessionState, type Packet } from "./schemas.js";
import { newContext, step, type MachineEvent } from "./state-machine.js";

const PacketSpec = z.strictObject({
  type: z.literal("PACKET"),
  modality: Modality,
  seq: z.number().int().nonnegative(),
  source_epoch: z.number().int().min(1),
  payload_bytes: z.number().int().nonnegative().default(320),
  /** receiver queueing delay: received_mono = now - queued_ms */
  queued_ms: z.number().int().nonnegative().default(0),
  /** source capture delay: source_ts = received_wall - source_lag_ms */
  source_lag_ms: z.number().int().default(40),
});
const PlainEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("DETECT"), meeting_uuid: z.string() }),
  z.strictObject({ type: z.literal("REQUEST_PERMISSION") }),
  z.strictObject({ type: z.literal("PERMISSION_GRANTED"), source_epoch: z.number().int(), stream_id: z.string().nullable().optional() }),
  z.strictObject({ type: z.literal("PERMISSION_DENIED") }),
  z.strictObject({ type: z.literal("CANCEL") }),
  z.strictObject({ type: z.literal("CONNECTED") }),
  z.strictObject({ type: z.literal("TICK") }),
  z.strictObject({ type: z.literal("SOURCE_LOST") }),
  z.strictObject({ type: z.literal("PAUSE") }),
  z.strictObject({ type: z.literal("RESUME"), source_epoch: z.number().int() }),
  z.strictObject({ type: z.literal("RECOVERY_STARTED"), source_epoch: z.number().int() }),
  z.strictObject({ type: z.literal("RECOVERY_FAILED") }),
  z.strictObject({ type: z.literal("STOP") }),
  z.strictObject({ type: z.literal("FATAL"), reason: z.string() }),
  z.strictObject({ type: z.literal("FINALIZED") }),
]);

export const Scenario = z.strictObject({
  name: z.string(),
  description: z.string(),
  session_id: z.uuid(),
  owner_id: z.uuid(),
  steps: z.array(
    z.strictObject({
      advance_ms: z.number().int().nonnegative(),
      do: z.union([PacketSpec, PlainEvent]),
      /** false => the machine must answer INVALID_TRANSITION/INVALID_EVENT and keep its state */
      accepted: z.boolean().default(true),
      expect_state: SessionState,
      /** optional extra assertions */
      expect_effects: z.array(z.string()).optional(),
    }),
  ),
  expect_final: z.strictObject({
    state: SessionState,
    outcome: z.enum(["completed", "partial", "failed"]).nullable(),
  }),
});
export type Scenario = z.infer<typeof Scenario>;

export function replayScenario(raw: unknown): { states: string[] } {
  const sc = Scenario.parse(raw);
  let now = { wall_ms: 1_700_000_000_000, mono_ms: 100_000 };
  let ctx = newContext({ session_id: sc.session_id, owner_id: sc.owner_id }, now);
  const states: string[] = [];
  sc.steps.forEach((st, i) => {
    now = { wall_ms: now.wall_ms + st.advance_ms, mono_ms: now.mono_ms + st.advance_ms };
    let ev: MachineEvent;
    if (st.do.type === "PACKET") {
      const d = st.do;
      const p: Packet = {
        schema_version: SCHEMA_VERSION,
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        session_id: sc.session_id,
        owner_id: sc.owner_id,
        source_epoch: d.source_epoch,
        modality: d.modality,
        seq: d.seq,
        source_ts_ms: now.wall_ms - d.source_lag_ms,
        received_wall_ms: now.wall_ms,
        received_mono_ms: now.mono_ms - d.queued_ms,
        payload_bytes: d.payload_bytes,
        payload_sha256: createHash("sha256").update(`${d.modality}:${d.seq}`).digest("hex"),
        idempotency_key: `${sc.session_id}:${d.source_epoch}:${d.modality}:${d.seq}`,
      };
      ev = { type: "PACKET", packet: p };
    } else {
      ev = st.do as MachineEvent;
    }
    const r = step(ctx, ev, now, DEFAULT_THRESHOLDS);
    if (r.ok !== st.accepted) throw new Error(`${sc.name} step ${i} (${st.do.type}): accepted=${r.ok}, expected ${st.accepted}`);
    ctx = r.ctx;
    if (ctx.state !== st.expect_state)
      throw new Error(`${sc.name} step ${i} (${st.do.type}): state ${ctx.state}, expected ${st.expect_state}`);
    for (const k of st.expect_effects ?? []) {
      const has = r.effects.some((e) => e.kind === k || ("reason" in e && e.reason === k));
      if (!has) throw new Error(`${sc.name} step ${i}: missing effect ${k}`);
    }
    states.push(ctx.state);
  });
  if (ctx.state !== sc.expect_final.state || ctx.outcome !== sc.expect_final.outcome)
    throw new Error(`${sc.name}: final ${ctx.state}/${ctx.outcome}`);
  return { states };
}

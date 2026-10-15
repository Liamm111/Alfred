/**
 * Versioned event envelope (API `v1`). Producers stamp `api_version` and
 * `schema_version`; consumers refuse anything outside SUPPORTED_API_VERSIONS and
 * any schema_version with a different major. Additive changes bump the minor
 * (schemas are strict, so a v1.1 producer must target v1.1 consumers: negotiate
 * by `api_version` + `schema_version` before emitting new fields).
 */
import { z } from "zod";
import { API_VERSION, Alert, Assignment, Evidence, Gap, Packet, SCHEMA_VERSION, SessionState } from "./schemas.js";

export const SUPPORTED_API_VERSIONS = [API_VERSION] as const;
const major = (v: string) => v.split(".")[0];

const base = {
  event_id: z.uuid(),
  api_version: z.literal(API_VERSION),
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  session_id: z.uuid(),
  owner_id: z.uuid(),
  occurred_at_ms: z.number().int().nonnegative(),
};

const RejectReason = z.enum([
  "wrong_session",
  "stale_epoch",
  "unknown_epoch",
  "clock_skew_future",
  "expired",
  "duplicate",
  "out_of_order",
  "empty_payload",
  "paused",
]);

export const EventEnvelope = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("session.state_changed"),
    payload: z.strictObject({ from: SessionState, to: SessionState, reason: z.string().max(128) }),
  }),
  z.strictObject({ ...base, type: z.literal("packet.accepted"), payload: z.strictObject({ packet: Packet }) }),
  z.strictObject({
    ...base,
    type: z.literal("packet.rejected"),
    payload: z.strictObject({ packet_id: z.uuid(), reason: RejectReason }),
  }),
  z.strictObject({ ...base, type: z.literal("gap.opened"), payload: z.strictObject({ gap: Gap }) }),
  z.strictObject({ ...base, type: z.literal("gap.closed"), payload: z.strictObject({ gap: Gap }) }),
  z.strictObject({ ...base, type: z.literal("alert.raised"), payload: z.strictObject({ alert: Alert }) }),
  z.strictObject({ ...base, type: z.literal("evidence.created"), payload: z.strictObject({ evidence: Evidence }) }),
  z.strictObject({
    ...base,
    type: z.literal("assignment.created"),
    payload: z.strictObject({ assignment: Assignment }),
  }),
]);
export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type EventType = EventEnvelope["type"];
export const EVENT_TYPES = EventEnvelope.options.map((o) => o.shape.type.value) as EventType[];

export type ParseEventResult =
  | { ok: true; event: EventEnvelope }
  | { ok: false; code: "UNSUPPORTED_API_VERSION" | "UNSUPPORTED_SCHEMA_VERSION" | "INVALID"; message: string };

export function parseEvent(input: unknown): ParseEventResult {
  if (typeof input !== "object" || input === null) return { ok: false, code: "INVALID", message: "not an object" };
  const rec = input as Record<string, unknown>;
  if (!(SUPPORTED_API_VERSIONS as readonly unknown[]).includes(rec.api_version))
    return { ok: false, code: "UNSUPPORTED_API_VERSION", message: `api_version ${String(rec.api_version)}` };
  if (typeof rec.schema_version !== "string" || major(rec.schema_version) !== major(SCHEMA_VERSION))
    return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", message: `schema_version ${String(rec.schema_version)}` };
  const r = EventEnvelope.safeParse(input);
  if (!r.success) return { ok: false, code: "INVALID", message: r.error.message };
  // Nested entities are pinned to the exact schema version the code was built for.
  if (r.data.schema_version !== SCHEMA_VERSION)
    return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", message: `schema_version ${r.data.schema_version}` };
  return { ok: true, event: r.data };
}

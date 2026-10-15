/**
 * Source of truth for every persisted / exchanged entity (BLOC 01).
 *
 * - TS types are inferred from these Zod schemas.
 * - JSON Schemas (schemas/*.json) and Swift Codable types
 *   (swift/AlfredContracts/Sources/Contracts.generated.swift) are GENERATED from
 *   them by `npm run gen`; CI fails (`npm run gen:check`) on drift.
 * - All objects are strict: unknown fields are rejected. In particular there is no
 *   field able to carry raw audio / raw image bytes (privacy fail-safe).
 *
 * Time conventions: every `*_ms` is an integer number of milliseconds.
 *   - `source_ts_ms`      : timestamp on the SOURCE clock (Zoom / capture device). Untrusted.
 *   - `received_wall_ms`  : receiver wall clock (epoch ms). Stored / displayed. Never used for freshness.
 *   - `received_mono_ms`  : receiver monotonic clock. Used for every freshness decision.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;
export const API_VERSION = "v1" as const;

const uuid = z.uuid();
const ms = z.number().int().nonnegative();
const version = z.literal(SCHEMA_VERSION);
const text = (max: number) => z.string().min(1).max(max);

export const Modality = z.enum(["audio", "video", "transcript"]);
export type Modality = z.infer<typeof Modality>;
export const MODALITIES = Modality.options;
/** Modalities able to PROVE that media flows. A transcript alone never does. */
export const MEDIA_MODALITIES = ["audio", "video"] as const satisfies readonly Modality[];

export const SessionState = z.enum([
  "IDLE",
  "DETECTED",
  "PERMISSION",
  "CONNECTING",
  "LIVE_AUDIO",
  "LIVE_VIDEO",
  "LIVE_AV",
  "DEGRADED",
  "PAUSED",
  "RECOVERING",
  "FINALIZING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionOutcome = z.enum(["completed", "partial", "failed"]);
export type SessionOutcome = z.infer<typeof SessionOutcome>;

export const LastPacketAt = z.strictObject({
  audio_ms: ms.nullable(),
  video_ms: ms.nullable(),
  transcript_ms: ms.nullable(),
});

export const Session = z.strictObject({
  schema_version: version,
  id: uuid,
  owner_id: uuid,
  state: SessionState,
  source_epoch: z.number().int().nonnegative(),
  meeting_uuid: text(256).nullable(),
  stream_id: text(256).nullable(),
  version: z.number().int().nonnegative(),
  verified_packets: z.number().int().nonnegative(),
  last_packet_wall_ms: LastPacketAt,
  outcome: SessionOutcome.nullable(),
  failure_reason: text(128).nullable(),
  created_at_ms: ms,
  updated_at_ms: ms,
  started_at_ms: ms.nullable(),
  ended_at_ms: ms.nullable(),
});
export type Session = z.infer<typeof Session>;

export const CaptureSourceKind = z.enum(["zoom_rtms", "local_capture"]);
export const CaptureSourceStatus = z.enum([
  "pending",
  /** A started/connected callback was seen. This is NOT proof of media. */
  "connected_unverified",
  /** At least one valid, fresh media packet was accepted. Only packets set this. */
  "receiving",
  "lost",
  "closed",
]);
export const CaptureSource = z.strictObject({
  schema_version: version,
  id: uuid,
  session_id: uuid,
  owner_id: uuid,
  kind: CaptureSourceKind,
  source_epoch: z.number().int().min(1),
  meeting_uuid: text(256).nullable(),
  stream_id: text(256).nullable(),
  status: CaptureSourceStatus,
  connected_callback_at_ms: ms.nullable(),
  first_media_at_ms: ms.nullable(),
  created_at_ms: ms,
});
export type CaptureSource = z.infer<typeof CaptureSource>;

/** Packet METADATA only. Raw media is never part of the contract. */
export const Packet = z.strictObject({
  schema_version: version,
  id: uuid,
  session_id: uuid,
  owner_id: uuid,
  source_epoch: z.number().int().min(1),
  modality: Modality,
  seq: z.number().int().nonnegative(),
  source_ts_ms: ms,
  received_wall_ms: ms,
  received_mono_ms: ms,
  payload_bytes: z.number().int().nonnegative(),
  payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  idempotency_key: text(200),
});
export type Packet = z.infer<typeof Packet>;

export const EvidenceKind = z.enum(["transcript_span", "audio_summary", "frame_observation"]);
export const Evidence = z
  .strictObject({
    schema_version: version,
    id: uuid,
    session_id: uuid,
    owner_id: uuid,
    kind: EvidenceKind,
    modality: Modality,
    packet_ids: z.array(uuid).min(1),
    start_ms: ms,
    end_ms: ms,
    text: z.string().max(20000),
    confidence: z.number().min(0).max(1),
    created_at_ms: ms,
  })
  .refine((e) => e.end_ms >= e.start_ms, { message: "end_ms < start_ms", path: ["end_ms"] });
export type Evidence = z.infer<typeof Evidence>;

export const GapReason = z.enum([
  "silence",
  "packet_expired",
  "source_lost",
  "paused",
  "clock_skew",
  "session_end",
  "unknown",
]);
export type GapReason = z.infer<typeof GapReason>;
export const Gap = z
  .strictObject({
    schema_version: version,
    id: uuid,
    session_id: uuid,
    owner_id: uuid,
    modality: Modality,
    source_epoch: z.number().int().min(1),
    start_ms: ms,
    /** null while the gap is still open. */
    end_ms: ms.nullable(),
    reason: GapReason,
  })
  .refine((g) => g.end_ms === null || g.end_ms >= g.start_ms, { message: "end_ms < start_ms", path: ["end_ms"] });
export type Gap = z.infer<typeof Gap>;

export const AlertSeverity = z.enum(["info", "warning", "critical"]);
export const AlertCode = z.enum([
  "connected_without_media",
  "media_silence",
  "modality_lost",
  "recovery_requested",
  "recovery_failed",
  "connect_timeout",
  "clock_skew",
  "session_partial",
  "session_failed",
]);
export type AlertCode = z.infer<typeof AlertCode>;
export const Alert = z.strictObject({
  schema_version: version,
  id: uuid,
  session_id: uuid,
  owner_id: uuid,
  severity: AlertSeverity,
  code: AlertCode,
  message: text(500),
  raised_at_ms: ms,
  resolved_at_ms: ms.nullable(),
});
export type Alert = z.infer<typeof Alert>;

export const AssignmentStatus = z.enum(["open", "done", "dismissed"]);
export const Assignment = z.strictObject({
  schema_version: version,
  id: uuid,
  session_id: uuid,
  owner_id: uuid,
  title: text(500),
  assignee_label: text(200).nullable(),
  due_at_ms: ms.nullable(),
  status: AssignmentStatus,
  /** An assignment without evidence is invalid by construction. */
  evidence_ids: z.array(uuid).min(1),
  created_at_ms: ms,
});
export type Assignment = z.infer<typeof Assignment>;

/** Registry used by generators and fixtures. */
export const ENTITY_SCHEMAS = {
  Session,
  CaptureSource,
  Packet,
  Evidence,
  Gap,
  Alert,
  Assignment,
} as const;

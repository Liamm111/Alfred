/**
 * `npm run gen`        writes JSON Schemas, Swift types and public fixtures.
 * `npm run gen:check`  fails (exit 1) if any generated file differs from disk (drift guard).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ENTITY_SCHEMAS,
  EventEnvelope,
  SCHEMA_VERSION,
  API_VERSION,
  replayScenario,
} from "../src/index.js";
import { generateSwift } from "./gen-swift.js";
import { SCENARIOS } from "./scenarios.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const out = new Map<string, string>();
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

// ---- JSON Schemas ----------------------------------------------------------------------------
for (const [name, schema] of Object.entries(ENTITY_SCHEMAS))
  out.set(`schemas/${name}.schema.json`, json(z.toJSONSchema(schema, { io: "output" })));
out.set("schemas/EventEnvelope.schema.json", json(z.toJSONSchema(EventEnvelope, { io: "output" })));

// ---- Swift -----------------------------------------------------------------------------------
out.set("swift/AlfredContracts/Sources/AlfredContracts/Contracts.generated.swift", generateSwift());

// ---- Public, synthetic fixtures (no real people, meetings, or media) ---------------------------
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S = id(1), O = id(2);
const sha = "a".repeat(64);
const v = SCHEMA_VERSION;
const valid = {
  Session: { schema_version: v, id: S, owner_id: O, state: "LIVE_AV", source_epoch: 1, meeting_uuid: "synthetic-meeting-001", stream_id: "synthetic-stream-001", version: 7, verified_packets: 42, last_packet_wall_ms: { audio_ms: 1700000005000, video_ms: 1700000004900, transcript_ms: null }, outcome: null, failure_reason: null, created_at_ms: 1700000000000, updated_at_ms: 1700000005000, started_at_ms: 1700000000100, ended_at_ms: null },
  CaptureSource: { schema_version: v, id: id(3), session_id: S, owner_id: O, kind: "zoom_rtms", source_epoch: 1, meeting_uuid: "synthetic-meeting-001", stream_id: "synthetic-stream-001", status: "connected_unverified", connected_callback_at_ms: 1700000000200, first_media_at_ms: null, created_at_ms: 1700000000100 },
  Packet: { schema_version: v, id: id(4), session_id: S, owner_id: O, source_epoch: 1, modality: "audio", seq: 0, source_ts_ms: 1700000000460, received_wall_ms: 1700000000500, received_mono_ms: 100500, payload_bytes: 320, payload_sha256: sha, idempotency_key: `${S}:1:audio:0` },
  Evidence: { schema_version: v, id: id(5), session_id: S, owner_id: O, kind: "transcript_span", modality: "transcript", packet_ids: [id(4)], start_ms: 1700000000400, end_ms: 1700000002400, text: "Synthetic sentence for fixtures.", confidence: 0.92, created_at_ms: 1700000003000 },
  Gap: { schema_version: v, id: id(6), session_id: S, owner_id: O, modality: "audio", source_epoch: 1, start_ms: 1700000004000, end_ms: null, reason: "silence" },
  Alert: { schema_version: v, id: id(7), session_id: S, owner_id: O, severity: "warning", code: "connected_without_media", message: "Connected callback received but no media after 8s.", raised_at_ms: 1700000008000, resolved_at_ms: null },
  Assignment: { schema_version: v, id: id(8), session_id: S, owner_id: O, title: "Send the synthetic summary", assignee_label: "Synthetic Person A", due_at_ms: null, status: "open", evidence_ids: [id(5)], created_at_ms: 1700000009000 },
} as const;
for (const [k, val] of Object.entries(valid)) out.set(`fixtures/valid/${k}.json`, json(val));

const bad = (entity: keyof typeof valid, reason: string, mutate: (o: any) => void) => {
  const o = structuredClone(valid[entity]) as any;
  mutate(o);
  return { entity, reason, value: o };
};
const invalid: Record<string, ReturnType<typeof bad>> = {
  "Packet.raw_audio_field": bad("Packet", "unknown field carrying raw media is rejected", (o) => (o.raw_audio = "AAAA")),
  "Packet.negative_seq": bad("Packet", "seq must be >= 0", (o) => (o.seq = -1)),
  "Packet.bad_sha": bad("Packet", "payload_sha256 must be 64 hex chars", (o) => (o.payload_sha256 = "xyz")),
  "Packet.epoch_zero": bad("Packet", "source_epoch starts at 1", (o) => (o.source_epoch = 0)),
  "Packet.unknown_modality": bad("Packet", "modality enum", (o) => (o.modality = "screen")),
  "Packet.wrong_schema_version": bad("Packet", "schema_version pinned", (o) => (o.schema_version = "2.0.0")),
  "Session.unknown_state": bad("Session", "state enum", (o) => (o.state = "LIVE")),
  "Session.not_uuid": bad("Session", "id must be a uuid", (o) => (o.id = "not-a-uuid")),
  "Session.missing_owner": bad("Session", "owner_id required", (o) => delete o.owner_id),
  "Evidence.no_packets": bad("Evidence", "evidence must cite at least one packet", (o) => (o.packet_ids = [])),
  "Evidence.end_before_start": bad("Evidence", "end_ms >= start_ms", (o) => (o.end_ms = o.start_ms - 1)),
  "Evidence.confidence_range": bad("Evidence", "confidence in [0,1]", (o) => (o.confidence = 1.5)),
  "Gap.end_before_start": bad("Gap", "end_ms >= start_ms", (o) => (o.end_ms = o.start_ms - 1)),
  "Assignment.no_evidence": bad("Assignment", "an assignment without evidence is invalid", (o) => (o.evidence_ids = [])),
  "Alert.bad_severity": bad("Alert", "severity enum", (o) => (o.severity = "fatal")),
  "CaptureSource.bad_status": bad("CaptureSource", "status enum", (o) => (o.status = "connected")),
};
for (const [k, val] of Object.entries(invalid)) out.set(`fixtures/invalid/${k}.json`, json(val));

const ev = (n: number, type: string, payload: unknown) => ({ event_id: id(100 + n), api_version: API_VERSION, schema_version: v, type, session_id: S, owner_id: O, occurred_at_ms: 1700000000000 + n, payload });
const events: Record<string, unknown> = {
  "session.state_changed": ev(1, "session.state_changed", { from: "CONNECTING", to: "LIVE_AUDIO", reason: "fresh_media_packet" }),
  "packet.accepted": ev(2, "packet.accepted", { packet: valid.Packet }),
  "packet.rejected": ev(3, "packet.rejected", { packet_id: id(4), reason: "expired" }),
  "gap.opened": ev(4, "gap.opened", { gap: valid.Gap }),
  "gap.closed": ev(5, "gap.closed", { gap: { ...valid.Gap, end_ms: 1700000006000 } }),
  "alert.raised": ev(6, "alert.raised", { alert: valid.Alert }),
  "evidence.created": ev(7, "evidence.created", { evidence: valid.Evidence }),
  "assignment.created": ev(8, "assignment.created", { assignment: valid.Assignment }),
};
for (const [k, val] of Object.entries(events)) out.set(`fixtures/events/${k}.json`, json(val));
out.set("fixtures/events_invalid/unsupported_api_version.json", json({ expect: "UNSUPPORTED_API_VERSION", value: { ...(events["packet.rejected"] as object), api_version: "v2" } }));
out.set("fixtures/events_invalid/unsupported_schema_major.json", json({ expect: "UNSUPPORTED_SCHEMA_VERSION", value: { ...(events["packet.rejected"] as object), schema_version: "2.0.0" } }));
out.set("fixtures/events_invalid/unknown_type.json", json({ expect: "INVALID", value: { ...(events["packet.rejected"] as object), type: "packet.teleported" } }));
out.set("fixtures/events_invalid/extra_field.json", json({ expect: "INVALID", value: { ...(events["packet.rejected"] as object), raw_audio: "AAAA" } }));

for (const sc of SCENARIOS) {
  replayScenario(sc); // the generator refuses to publish a scenario the machine contradicts
  out.set(`fixtures/scenarios/${sc.name}.json`, json(sc));
}

out.set("fixtures/README.md", [
  "# Public fixtures",
  "",
  `Generated by \`npm run gen\` (schema ${SCHEMA_VERSION}, api ${API_VERSION}). **Synthetic data only**: no real person, meeting, token or media.`,
  "",
  "- `valid/<Entity>.json` — one valid instance per entity (also decoded by the Swift tests).",
  "- `invalid/*.json` — `{entity, reason, value}`; every value must be rejected by the schema.",
  "- `events/`, `events_invalid/` — versioned event envelopes and refusals.",
  "- `scenarios/*.json` — replayable timelines with expected states (`replayScenario`).",
  "",
].join("\n"));

// ---- write or check --------------------------------------------------------------------------
const managed = ["schemas", "fixtures", "swift/AlfredContracts/Sources/AlfredContracts/Contracts.generated.swift"];
function listFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  if (!readdirSyncSafe(abs)) return [dir];
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) => listFiles(join(dir, d.name)));
}
function readdirSyncSafe(p: string) {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}
const existing = new Set(managed.flatMap(listFiles));
const problems: string[] = [];
for (const [rel, content] of out) {
  const abs = join(ROOT, rel);
  if (check) {
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) problems.push(`drift: ${rel}`);
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  existing.delete(rel);
}
for (const stale of existing) {
  if (check) problems.push(`stale file: ${stale}`);
  else rmSync(join(ROOT, stale));
}
if (check && problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${check ? "checked" : "wrote"} ${out.size} generated files`);
void relative;

/**
 * Repository functions. They take a `Tx` obtained from withUser()/withMaintenance(), so the
 * owner binding (RLS) is always in force; none of them accepts an owner_id they could abuse
 * to read other users' rows - isolation does not depend on this code being correct.
 */
import { Alert, Assignment, Evidence, Gap, Packet, type Session } from "@alfred/contracts";
import type { Tx } from "./pool.js";

export class ConcurrencyError extends Error {
  constructor(what: string) {
    super(`optimistic concurrency conflict on ${what}`);
  }
}

export interface SessionRow {
  id: string;
  owner_id: string;
  state: Session["state"];
  source_epoch: number;
  meeting_uuid: string | null;
  stream_id: string | null;
  verified_packets: number;
  last_audio_wall_ms: number | null;
  last_video_wall_ms: number | null;
  last_transcript_wall_ms: number | null;
  outcome: Session["outcome"];
  failure_reason: string | null;
  idempotency_key: string;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  ended_at_ms: number | null;
}

export interface OutboxEvent {
  event_type: string;
  payload: unknown;
  dedupe_key: string;
}

async function emit(tx: Tx, owner_id: string, aggregate_type: string, aggregate_id: string, ev: OutboxEvent) {
  await tx.query(
    `insert into outbox (owner_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
     values ($1,$2,$3,$4,$5,$6) on conflict (owner_id, dedupe_key) do nothing`,
    [owner_id, aggregate_type, aggregate_id, ev.event_type, JSON.stringify(ev.payload), ev.dedupe_key],
  );
}

/** Idempotent create: same (owner, idempotency_key) returns the existing row and creates no second outbox event. */
export async function createSession(
  tx: Tx,
  a: { id: string; owner_id: string; idempotency_key: string; now_ms: number },
): Promise<{ row: SessionRow; created: boolean }> {
  const ins = await tx.query<SessionRow>(
    `insert into sessions (id, owner_id, state, idempotency_key, created_at_ms, updated_at_ms)
     values ($1,$2,'IDLE',$3,$4,$4) on conflict (owner_id, idempotency_key) do nothing returning *`,
    [a.id, a.owner_id, a.idempotency_key, a.now_ms],
  );
  if (ins.rows[0]) {
    await emit(tx, a.owner_id, "session", a.id, { event_type: "session.created", payload: { session_id: a.id }, dedupe_key: `session.created:${a.id}` });
    return { row: ins.rows[0], created: true };
  }
  const ex = await tx.query<SessionRow>("select * from sessions where owner_id=$1 and idempotency_key=$2", [a.owner_id, a.idempotency_key]);
  return { row: ex.rows[0]!, created: false };
}

export async function getSession(tx: Tx, id: string): Promise<SessionRow | null> {
  const r = await tx.query<SessionRow>("select * from sessions where id=$1", [id]);
  return r.rows[0] ?? null;
}

export type SessionPatch = Partial<
  Pick<SessionRow, "state" | "source_epoch" | "meeting_uuid" | "stream_id" | "verified_packets" | "last_audio_wall_ms" | "last_video_wall_ms" | "last_transcript_wall_ms" | "outcome" | "failure_reason" | "started_at_ms" | "ended_at_ms">
>;
const PATCHABLE = ["state", "source_epoch", "meeting_uuid", "stream_id", "verified_packets", "last_audio_wall_ms", "last_video_wall_ms", "last_transcript_wall_ms", "outcome", "failure_reason", "started_at_ms", "ended_at_ms"] as const;

/**
 * State change + outbox event in ONE transaction (the event exists iff the change committed).
 * `expectedVersion` is the optimistic-concurrency token: a concurrent writer makes this throw.
 */
export async function transitionSession(
  tx: Tx,
  id: string,
  expectedVersion: number,
  patch: SessionPatch,
  now_ms: number,
  event: OutboxEvent,
): Promise<SessionRow> {
  const keys = PATCHABLE.filter((k) => k in patch);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const r = await tx.query<SessionRow>(
    `update sessions set ${[...sets, `updated_at_ms = $${keys.length + 3}`].join(", ")} where id = $1 and version = $2 returning *`,
    [id, expectedVersion, ...keys.map((k) => patch[k] ?? null), now_ms],
  );
  const row = r.rows[0];
  if (!row) throw new ConcurrencyError(`session ${id} @v${expectedVersion}`);
  await emit(tx, row.owner_id, "session", id, event);
  return row;
}

/** Idempotent packet write. Returns false for a duplicate (same key or same epoch/modality/seq). */
export async function recordPacket(tx: Tx, raw: unknown): Promise<boolean> {
  const p = Packet.parse(raw);
  const r = await tx.query(
    `insert into packets (id, session_id, owner_id, source_epoch, modality, seq, source_ts_ms, received_wall_ms, received_mono_ms, payload_bytes, payload_sha256, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing`,
    [p.id, p.session_id, p.owner_id, p.source_epoch, p.modality, p.seq, p.source_ts_ms, p.received_wall_ms, p.received_mono_ms, p.payload_bytes, p.payload_sha256, p.idempotency_key],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function createEvidence(tx: Tx, raw: unknown): Promise<void> {
  const e = Evidence.parse(raw);
  await tx.query(
    `insert into evidence (id, session_id, owner_id, kind, modality, start_ms, end_ms, text, confidence, created_at_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.id, e.session_id, e.owner_id, e.kind, e.modality, e.start_ms, e.end_ms, e.text, e.confidence, e.created_at_ms],
  );
  for (const pid of e.packet_ids)
    await tx.query("insert into evidence_packets (evidence_id, packet_id, owner_id) values ($1,$2,$3)", [e.id, pid, e.owner_id]);
}

export async function createAssignment(tx: Tx, raw: unknown): Promise<void> {
  const a = Assignment.parse(raw);
  await tx.query(
    `insert into assignments (id, session_id, owner_id, title, assignee_label, due_at_ms, status, created_at_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.id, a.session_id, a.owner_id, a.title, a.assignee_label, a.due_at_ms, a.status, a.created_at_ms],
  );
  for (const eid of a.evidence_ids)
    await tx.query("insert into assignment_evidence (assignment_id, evidence_id, owner_id) values ($1,$2,$3)", [a.id, eid, a.owner_id]);
}

export async function openGap(tx: Tx, raw: unknown): Promise<void> {
  const g = Gap.parse(raw);
  await tx.query(
    `insert into gaps (id, session_id, owner_id, modality, source_epoch, start_ms, end_ms, reason) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [g.id, g.session_id, g.owner_id, g.modality, g.source_epoch, g.start_ms, g.end_ms, g.reason],
  );
}

export async function raiseAlert(tx: Tx, raw: unknown): Promise<void> {
  const a = Alert.parse(raw);
  await tx.query(
    `insert into alerts (id, session_id, owner_id, severity, code, message, raised_at_ms, resolved_at_ms) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.id, a.session_id, a.owner_id, a.severity, a.code, a.message, a.raised_at_ms, a.resolved_at_ms],
  );
}

// ---- jobs -----------------------------------------------------------------------------------
export async function enqueueJob(tx: Tx, a: { owner_id: string; type: string; payload: unknown; idempotency_key: string; run_at?: Date }): Promise<{ id: string; created: boolean }> {
  const r = await tx.query<{ id: string }>(
    `insert into jobs (owner_id, type, payload, idempotency_key, run_at) values ($1,$2,$3,$4,coalesce($5, now()))
     on conflict (owner_id, type, idempotency_key) do nothing returning id`,
    [a.owner_id, a.type, JSON.stringify(a.payload), a.idempotency_key, a.run_at ?? null],
  );
  if (r.rows[0]) return { id: r.rows[0].id, created: true };
  const ex = await tx.query<{ id: string }>("select id from jobs where owner_id=$1 and type=$2 and idempotency_key=$3", [a.owner_id, a.type, a.idempotency_key]);
  return { id: ex.rows[0]!.id, created: false };
}

/** Claim up to `limit` due jobs; concurrent workers never get the same job (SKIP LOCKED). */
export async function claimJobs(tx: Tx, worker: string, limit = 1): Promise<Array<{ id: string; owner_id: string; type: string; payload: unknown; attempts: number }>> {
  const r = await tx.query(
    `update jobs set status='running', locked_by=$1, locked_at=now(), attempts=attempts+1
     where id in (select id from jobs where status='queued' and run_at <= now() order by run_at for update skip locked limit $2)
     returning id, owner_id, type, payload, attempts`,
    [worker, limit],
  );
  return r.rows;
}

export async function finishJob(tx: Tx, id: string, outcome: { ok: true } | { ok: false; error: string; retryInSeconds?: number }): Promise<void> {
  if (outcome.ok) {
    await tx.query("update jobs set status='succeeded', locked_by=null, locked_at=null where id=$1", [id]);
    return;
  }
  await tx.query(
    `update jobs set last_error=$2, locked_by=null, locked_at=null,
       status = case when attempts >= max_attempts then 'dead' else 'queued' end,
       run_at = now() + make_interval(secs => $3)
     where id=$1`,
    [id, outcome.error.slice(0, 1000), outcome.retryInSeconds ?? 30],
  );
}

// ---- outbox relay -----------------------------------------------------------------------------
export async function claimOutbox(tx: Tx, limit = 100): Promise<Array<{ id: number; owner_id: string; event_type: string; payload: unknown }>> {
  const r = await tx.query(
    `select id, owner_id, event_type, payload from outbox where published_at is null order by id for update skip locked limit $1`,
    [limit],
  );
  return r.rows;
}
export async function markOutboxPublished(tx: Tx, ids: number[]): Promise<void> {
  await tx.query("update outbox set published_at = now(), publish_attempts = publish_attempts + 1 where id = any($1::bigint[])", [ids]);
}

// ---- retention / erasure --------------------------------------------------------------------------
export async function runRetention(tx: Tx, now = new Date()) {
  const r = await tx.query("select * from run_retention($1)", [now]);
  return r.rows[0] as { deleted_packets: number; deleted_evidence: number; deleted_jobs: number; deleted_outbox: number };
}
export async function eraseUser(tx: Tx, userId: string) {
  const r = await tx.query<{ erase_user: { verified: boolean; deleted: Record<string, number> } }>("select erase_user($1)", [userId]);
  return r.rows[0]!.erase_user;
}

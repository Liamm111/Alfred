import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client';

export interface EnqueueInput {
  type: string;
  /** Stable business key: enqueueing the same (type, uniqueKey) twice is a no-op. */
  uniqueKey: string;
  payloadReference?: string;
  payload?: Record<string, unknown>;
  availableAt?: Date;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  type: string;
  uniqueKey: string;
  payloadReference: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  /** Fencing token: ack/fail must present the same worker id AND attempt number. */
  lockedBy: string;
}

type Row = Record<string, unknown>;
const rows = (r: unknown): Row[] => (r as { rows: Row[] }).rows;

/** Idempotent. Pass a transaction handle to make this an outbox write. Returns created=false for duplicates. */
export async function enqueue(db: DbOrTx, input: EnqueueInput): Promise<{ id: string | null; created: boolean }> {
  const res = await db.execute(sql`
    insert into job_queue (type, unique_key, payload_reference, payload, available_at, max_attempts)
    values (${input.type}, ${input.uniqueKey}, ${input.payloadReference ?? null}, ${JSON.stringify(input.payload ?? {})}::jsonb,
            ${(input.availableAt ?? new Date()).toISOString()}::timestamptz, ${input.maxAttempts ?? 5})
    on conflict (type, unique_key) do nothing
    returning id`);
  const r = rows(res)[0];
  return r ? { id: String(r.id), created: true } : { id: null, created: false };
}

/**
 * Lease-based claim. Takes pending jobs that are due, AND running jobs whose lease expired (worker crashed before ack).
 * FOR UPDATE SKIP LOCKED => concurrent workers never claim the same job. Exhausted expired leases are moved to dead.
 */
export async function claim(
  db: DbOrTx,
  opts: { workerId: string; leaseMs: number; types?: string[]; now?: Date },
): Promise<ClaimedJob | null> {
  const now = (opts.now ?? new Date()).toISOString();
  await db.execute(sql`
    update job_queue set status='dead', error_code='lease_expired_max_attempts', finished_at=${now}::timestamptz, updated_at=${now}::timestamptz
    where status='running' and locked_until < ${now}::timestamptz and attempts >= max_attempts`);
  const typeFilter = opts.types && opts.types.length > 0 ? sql`and type in (${sql.join(opts.types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await db.execute(sql`
    update job_queue j set status='running', attempts = j.attempts + 1, locked_by=${opts.workerId},
      locked_until = ${now}::timestamptz + (${opts.leaseMs} * interval '1 millisecond'), updated_at=${now}::timestamptz
    where j.id = (
      select id from job_queue
      where ((status='pending' and available_at <= ${now}::timestamptz)
          or (status='running' and locked_until < ${now}::timestamptz and attempts < max_attempts))
        ${typeFilter}
      order by available_at, created_at
      for update skip locked
      limit 1)
    returning id, type, unique_key, payload_reference, payload, attempts, max_attempts, locked_by`);
  const r = rows(res)[0];
  if (!r) return null;
  return {
    id: String(r.id),
    type: String(r.type),
    uniqueKey: String(r.unique_key),
    payloadReference: (r.payload_reference as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    lockedBy: String(r.locked_by),
  };
}

/** Ack. Returns false if the lease was lost (another worker re-claimed it) — the stale worker must not assume success. */
export async function complete(db: DbOrTx, job: Pick<ClaimedJob, 'id' | 'lockedBy' | 'attempts'>, now = new Date()): Promise<boolean> {
  const res = await db.execute(sql`
    update job_queue set status='succeeded', finished_at=${now.toISOString()}::timestamptz, updated_at=${now.toISOString()}::timestamptz,
      locked_until=null, error_code=null
    where id=${job.id} and status='running' and locked_by=${job.lockedBy} and attempts=${job.attempts}
    returning id`);
  return rows(res).length === 1;
}

export function backoffMs(attempt: number, baseMs = 1000, capMs = 5 * 60_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Record a failure: retryable & attempts left => back to pending with exponential backoff; else dead. */
export async function fail(
  db: DbOrTx,
  job: Pick<ClaimedJob, 'id' | 'lockedBy' | 'attempts' | 'maxAttempts'>,
  opts: { errorCode: string; retryable?: boolean; now?: Date; baseMs?: number },
): Promise<'retry' | 'dead' | 'lost'> {
  const now = opts.now ?? new Date();
  const dead = opts.retryable === false || job.attempts >= job.maxAttempts;
  const delay = backoffMs(job.attempts, opts.baseMs);
  const res = dead
    ? await db.execute(sql`
        update job_queue set status='dead', error_code=${opts.errorCode}, finished_at=${now.toISOString()}::timestamptz,
          updated_at=${now.toISOString()}::timestamptz, locked_until=null
        where id=${job.id} and status='running' and locked_by=${job.lockedBy} and attempts=${job.attempts} returning id`)
    : await db.execute(sql`
        update job_queue set status='pending', error_code=${opts.errorCode}, locked_until=null, locked_by=null,
          available_at=${now.toISOString()}::timestamptz + (${delay} * interval '1 millisecond'), updated_at=${now.toISOString()}::timestamptz
        where id=${job.id} and status='running' and locked_by=${job.lockedBy} and attempts=${job.attempts} returning id`);
  if (rows(res).length !== 1) return 'lost';
  return dead ? 'dead' : 'retry';
}

/** Extend a lease for long jobs; false if the lease was lost. */
export async function heartbeat(db: DbOrTx, job: Pick<ClaimedJob, 'id' | 'lockedBy' | 'attempts'>, leaseMs: number, now = new Date()): Promise<boolean> {
  const res = await db.execute(sql`
    update job_queue set locked_until=${now.toISOString()}::timestamptz + (${leaseMs} * interval '1 millisecond'), updated_at=${now.toISOString()}::timestamptz
    where id=${job.id} and status='running' and locked_by=${job.lockedBy} and attempts=${job.attempts} returning id`);
  return rows(res).length === 1;
}

export async function queueDepth(db: DbOrTx): Promise<Record<string, number>> {
  const res = await db.execute(sql`select status, count(*)::int as n from job_queue group by status`);
  return Object.fromEntries(rows(res).map((r) => [String(r.status), Number(r.n)]));
}

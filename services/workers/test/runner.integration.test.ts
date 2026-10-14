import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueue, queueDepth } from '@alfred/db';
import { freshTestDb } from '@alfred/db/testing';
import { NonRetryableError, runOnce } from '../src/runner';

let h: Awaited<ReturnType<typeof freshTestDb>>;
beforeAll(async () => { h = await freshTestDb(); });
afterAll(() => h.close());
beforeEach(async () => { await h.db.execute(sql`truncate job_queue`); });

const T0 = new Date('2026-01-01T10:00:00Z');
const base = () => ({ db: h.db, workerId: 'w1', leaseMs: 1000, now: () => T0 });

describe('worker runner', () => {
  it('idle when nothing to do; success acks', async () => {
    expect(await runOnce({ ...base(), handlers: {} })).toBe('idle');
    await enqueue(h.db, { type: 'x', uniqueKey: '1', availableAt: T0 });
    let ran = 0;
    expect(await runOnce({ ...base(), handlers: { x: async () => { ran++; } } })).toBe('succeeded');
    expect(ran).toBe(1);
    expect((await queueDepth(h.db)).succeeded).toBe(1);
  });
  it('handler crash before ack: job is NOT lost and is retried after lease', async () => {
    await enqueue(h.db, { type: 'x', uniqueKey: '1', availableAt: T0, maxAttempts: 3 });
    // process "dies" mid-handler: simulate by claiming through a handler that never returns to ack — the fail path is skipped
    // by using a never-acking claim directly:
    const { claim } = await import('@alfred/db');
    await claim(h.db, { workerId: 'dead-worker', leaseMs: 1000, now: T0 });
    // a healthy worker after lease expiry processes it
    const later = () => new Date(T0.getTime() + 5000);
    expect(await runOnce({ ...base(), now: later, handlers: { x: async () => undefined } })).toBe('succeeded');
  });
  it('throwing handler => retry with backoff; NonRetryable => dead; message is never stored', async () => {
    await enqueue(h.db, { type: 'x', uniqueKey: '1', availableAt: T0 });
    expect(await runOnce({ ...base(), handlers: { x: async () => { throw new Error('contains private transcript text'); } } })).toBe('retry');
    const r = (await h.db.execute(sql`select error_code, status from job_queue`)) as unknown as { rows: { error_code: string; status: string }[] };
    expect(r.rows[0]).toEqual({ error_code: 'handler_error', status: 'pending' });
    await h.db.execute(sql`truncate job_queue`);
    await enqueue(h.db, { type: 'y', uniqueKey: '1', availableAt: T0 });
    expect(await runOnce({ ...base(), handlers: { y: async () => { throw new NonRetryableError('bad_payload'); } } })).toBe('dead');
  });
  it('ignores job types without a registered handler', async () => {
    await enqueue(h.db, { type: 'unknown', uniqueKey: '1', availableAt: T0 });
    expect(await runOnce({ ...base(), handlers: { x: async () => undefined } })).toBe('idle');
  });
});

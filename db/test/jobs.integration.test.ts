import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claim, complete, enqueue, fail, heartbeat, queueDepth } from '../src';
import { freshTestDb } from '../src/testing';

let h: Awaited<ReturnType<typeof freshTestDb>>;
beforeAll(async () => { h = await freshTestDb(); });
afterAll(() => h.close());
beforeEach(async () => { await h.db.execute(sql`truncate job_queue`); });

const T0 = new Date('2026-01-01T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('job queue: idempotence, lease, retries', () => {
  it('unique (type, key): second enqueue is a no-op, even concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => enqueue(h.db, { type: 't', uniqueKey: 'same' })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await queueDepth(h.db)).pending).toBe(1);
    expect((await enqueue(h.db, { type: 'other', uniqueKey: 'same' })).created).toBe(true);
  });

  it('outbox: rollback leaves no job, commit keeps it', async () => {
    await expect(h.db.transaction(async (tx) => { await enqueue(tx, { type: 't', uniqueKey: 'rolled-back' }); throw new Error('boom'); })).rejects.toThrow();
    expect(await queueDepth(h.db)).toEqual({});
    await h.db.transaction(async (tx) => { await enqueue(tx, { type: 't', uniqueKey: 'committed' }); });
    expect((await queueDepth(h.db)).pending).toBe(1);
  });

  it('respects availableAt and type filter', async () => {
    await enqueue(h.db, { type: 'a', uniqueKey: '1', availableAt: at(10_000) });
    expect(await claim(h.db, { workerId: 'w', leaseMs: 1000, now: T0 })).toBeNull();
    expect(await claim(h.db, { workerId: 'w', leaseMs: 1000, now: at(10_000), types: ['b'] })).toBeNull();
    expect((await claim(h.db, { workerId: 'w', leaseMs: 1000, now: at(10_000), types: ['a'] }))?.uniqueKey).toBe('1');
  });

  it('50 concurrent workers never double-claim the same job', async () => {
    for (let i = 0; i < 10; i++) await enqueue(h.db, { type: 't', uniqueKey: `k${i}`, availableAt: T0 });
    const claimed = await Promise.all(Array.from({ length: 50 }, (_, i) => claim(h.db, { workerId: `w${i}`, leaseMs: 60_000, now: at(1) })));
    const ids = claimed.filter((c) => c).map((c) => c!.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('crash before ack: lease expires, job is re-claimed, stale worker cannot ack (fencing)', async () => {
    await enqueue(h.db, { type: 't', uniqueKey: 'k', availableAt: T0 });
    const first = (await claim(h.db, { workerId: 'crashy', leaseMs: 1000, now: T0 }))!;
    expect(first.attempts).toBe(1);
    // still leased: nobody else gets it
    expect(await claim(h.db, { workerId: 'other', leaseMs: 1000, now: at(500) })).toBeNull();
    // worker died; lease expired
    const second = (await claim(h.db, { workerId: 'rescuer', leaseMs: 1000, now: at(1500) }))!;
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);
    expect(await complete(h.db, first, at(1600))).toBe(false); // zombie ack rejected
    expect(await complete(h.db, second, at(1700))).toBe(true);
    expect((await queueDepth(h.db)).succeeded).toBe(1);
  });

  it('heartbeat extends the lease', async () => {
    await enqueue(h.db, { type: 't', uniqueKey: 'k', availableAt: T0 });
    const job = (await claim(h.db, { workerId: 'w', leaseMs: 1000, now: T0 }))!;
    expect(await heartbeat(h.db, job, 5000, at(900))).toBe(true);
    expect(await claim(h.db, { workerId: 'x', leaseMs: 1000, now: at(3000) })).toBeNull();
  });

  it('fail: exponential backoff, then dead after max attempts', async () => {
    await enqueue(h.db, { type: 't', uniqueKey: 'k', availableAt: T0, maxAttempts: 2 });
    const a = (await claim(h.db, { workerId: 'w', leaseMs: 1000, now: T0 }))!;
    expect(await fail(h.db, a, { errorCode: 'provider_timeout', now: T0, baseMs: 1000 })).toBe('retry');
    expect(await claim(h.db, { workerId: 'w', leaseMs: 1000, now: at(500) })).toBeNull(); // backoff not elapsed
    const b = (await claim(h.db, { workerId: 'w', leaseMs: 1000, now: at(1100) }))!;
    expect(b.attempts).toBe(2);
    expect(await fail(h.db, b, { errorCode: 'provider_timeout', now: at(1100) })).toBe('dead');
    expect(await queueDepth(h.db)).toEqual({ dead: 1 });
    const row = (await h.db.execute(sql`select error_code from job_queue`)) as unknown as { rows: { error_code: string }[] };
    expect(row.rows[0]?.error_code).toBe('provider_timeout');
  });

  it('non-retryable failure goes straight to dead', async () => {
    await enqueue(h.db, { type: 't', uniqueKey: 'k', availableAt: T0 });
    const a = (await claim(h.db, { workerId: 'w', leaseMs: 1000, now: T0 }))!;
    expect(await fail(h.db, a, { errorCode: 'invalid_payload', retryable: false, now: T0 })).toBe('dead');
  });

  it('worker that keeps crashing: job is dead-lettered when attempts are exhausted', async () => {
    await enqueue(h.db, { type: 't', uniqueKey: 'k', availableAt: T0, maxAttempts: 2 });
    await claim(h.db, { workerId: 'w1', leaseMs: 1000, now: T0 });
    await claim(h.db, { workerId: 'w2', leaseMs: 1000, now: at(2000) });
    expect(await claim(h.db, { workerId: 'w3', leaseMs: 1000, now: at(4000) })).toBeNull();
    expect(await queueDepth(h.db)).toEqual({ dead: 1 });
  });
});

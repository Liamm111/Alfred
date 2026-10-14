import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { parseEnv } from '@alfred/core';
import { freshTestDb } from '@alfred/db/testing';
import { migrateDown } from '@alfred/db';
import { buildApp } from '../src/app';

let h: Awaited<ReturnType<typeof freshTestDb>>;
beforeAll(async () => { h = await freshTestDb(); });
afterAll(() => h.close());

describe('/health/ready against real Postgres', () => {
  it('ok when schema is current, degraded (O01) when behind', async () => {
    const app = await buildApp({ env: parseEnv({ LOG_LEVEL: 'silent' }), db: h.db });
    const ok = await app.inject('/health/ready');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', checks: { database: 'ok', schema: 'ok' }, schemaVersion: '0000_foundation' });
    await h.db.execute(sql`select 1`);
    await migrateDown(h.db, 1);
    const behind = await app.inject('/health/ready');
    expect(behind.statusCode).toBe(503);
    expect(behind.json().checks.schema).toBe('behind');
  });
});

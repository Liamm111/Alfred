import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, migrateDown, migrateUp, schemaStatus, assertSchemaUpToDate } from '../src';
import { TEST_DATABASE_URL } from '../src/testing';

const h = createDb(TEST_DATABASE_URL, { max: 2 });
afterAll(() => h.close());

const tables = async () =>
  ((await h.db.execute(sql`select tablename from pg_tables where schemaname='public' order by 1`)) as unknown as { rows: { tablename: string }[] }).rows.map((r) => r.tablename);

describe('migrations up / down / up', () => {
  it('starts from an empty database: status is behind, then up applies', async () => {
    await h.db.execute(sql`drop schema if exists public cascade`);
    await h.db.execute(sql`drop schema if exists drizzle cascade`);
    await h.db.execute(sql`create schema public`);
    expect((await schemaStatus(h.db)).state).toBe('behind');
    await expect(assertSchemaUpToDate(h.db)).rejects.toThrow(/behind/);
    await migrateUp(h.db);
    expect((await schemaStatus(h.db)).state).toBe('ok');
    expect(await tables()).toEqual(expect.arrayContaining(['audit_events', 'job_queue']));
  });
  it('up is idempotent', async () => {
    await migrateUp(h.db);
    expect((await schemaStatus(h.db)).applied).toBe((await schemaStatus(h.db)).expected);
  });
  it('rollback removes the tables and marks schema behind; re-apply restores', async () => {
    await migrateDown(h.db, 99);
    expect(await tables()).not.toContain('job_queue');
    expect((await schemaStatus(h.db)).state).toBe('behind');
    await migrateUp(h.db);
    expect(await tables()).toContain('job_queue');
    expect((await schemaStatus(h.db)).state).toBe('ok');
  });
});

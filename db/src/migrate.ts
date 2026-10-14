import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';

interface JournalEntry { idx: number; tag: string; when: number }

/** Locate the migrations folder: explicit arg > MIGRATIONS_DIR > next to this source file > repo-relative fallback. */
export function resolveMigrationsDir(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.MIGRATIONS_DIR,
    join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
    resolve(process.cwd(), 'db/drizzle'),
    resolve(process.cwd(), '../../db/drizzle'),
  ].filter((c): c is string => !!c);
  const found = candidates.find((c) => existsSync(join(c, 'meta', '_journal.json')));
  if (!found) throw new Error('Migrations folder not found (set MIGRATIONS_DIR)');
  return found;
}

export function readJournal(dir: string): JournalEntry[] {
  const j = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
  return j.entries;
}

async function appliedTimestamps(db: Db): Promise<number[]> {
  const exists = await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') as t`);
  if (!(exists as unknown as { rows: { t: string | null }[] }).rows[0]?.t) return [];
  const res = await db.execute(sql`select created_at from drizzle.__drizzle_migrations order by id`);
  return (res as unknown as { rows: { created_at: string }[] }).rows.map((r) => Number(r.created_at));
}

export async function migrateUp(db: Db, dir = resolveMigrationsDir()): Promise<void> {
  await migrate(db, { migrationsFolder: dir });
}

/** Roll back the most recent `steps` migrations using hand-written `drizzle/down/<tag>.sql` files. */
export async function migrateDown(db: Db, steps = 1, dir = resolveMigrationsDir()): Promise<string[]> {
  const journal = readJournal(dir);
  const rolledBack: string[] = [];
  for (let i = 0; i < steps; i++) {
    const applied = await appliedTimestamps(db);
    const last = applied[applied.length - 1];
    if (last === undefined) break;
    const entry = journal.find((e) => e.when === last);
    if (!entry) throw new Error(`Applied migration ${last} not found in journal`);
    const downFile = join(dir, 'down', `${entry.tag}.sql`);
    if (!existsSync(downFile)) throw new Error(`Missing down migration: ${entry.tag}.sql`);
    const statements = readFileSync(downFile, 'utf8').split('--> statement-breakpoint');
    await db.transaction(async (tx) => {
      for (const s of statements) if (s.trim()) await tx.execute(sql.raw(s));
      await tx.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${last}`);
    });
    rolledBack.push(entry.tag);
  }
  return rolledBack;
}

export interface SchemaStatus {
  state: 'ok' | 'behind' | 'ahead' | 'unknown';
  applied: number;
  expected: number;
  latestTag: string | null;
}

/** O01: compare applied migrations with those shipped in this build. */
export async function schemaStatus(db: Db, dir = resolveMigrationsDir()): Promise<SchemaStatus> {
  const journal = readJournal(dir);
  const applied = await appliedTimestamps(db);
  const expectedTs = journal.map((e) => e.when);
  const latestTag = journal[journal.length - 1]?.tag ?? null;
  const missing = expectedTs.filter((t) => !applied.includes(t));
  const unknownApplied = applied.filter((t) => !expectedTs.includes(t));
  const state = missing.length > 0 ? 'behind' : unknownApplied.length > 0 ? 'ahead' : 'ok';
  return { state, applied: applied.length, expected: journal.length, latestTag };
}

export async function assertSchemaUpToDate(db: Db, dir?: string): Promise<SchemaStatus> {
  const s = await schemaStatus(db, dir);
  if (s.state !== 'ok') throw new Error(`Database schema is ${s.state} (applied ${s.applied}/${s.expected}); run migrations before starting`);
  return s;
}

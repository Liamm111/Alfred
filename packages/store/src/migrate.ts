import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, Tx } from "./pool.js";

const DIR = join(import.meta.dirname, "../migrations");
const LOCK_KEY = 727_001; // arbitrary, shared by all migrators so they serialise

export interface Migration {
  version: string;
  name: string;
  up: string;
  down: string;
  checksum: string;
}

export function loadMigrations(dir = DIR): Migration[] {
  const ups = readdirSync(dir).filter((f) => f.endsWith(".up.sql")).sort();
  return ups.map((f) => {
    const m = /^(\d{4})_(.+)\.up\.sql$/.exec(f);
    if (!m) throw new Error(`bad migration filename ${f}`);
    const up = readFileSync(join(dir, f), "utf8");
    const down = readFileSync(join(dir, f.replace(".up.sql", ".down.sql")), "utf8");
    return { version: m[1]!, name: m[2]!, up, down, checksum: createHash("sha256").update(up).digest("hex") };
  });
}

async function withLock<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await c.query(
      "create table if not exists schema_migrations (version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())",
    );
    return await fn(c);
  } finally {
    await c.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    c.release();
  }
}

/** Applies pending migrations (each in its own transaction). Detects edited, already-applied migrations. */
export async function migrateUp(db: Db, opts: { to?: string; dir?: string } = {}): Promise<string[]> {
  const all = loadMigrations(opts.dir);
  return withLock(db, async (c) => {
    const { rows } = await c.query<{ version: string; checksum: string }>("select version, checksum from schema_migrations");
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of all) {
      const have = applied.get(m.version);
      if (have !== undefined && have !== m.checksum) throw new Error(`migration ${m.version} was modified after being applied`);
    }
    const done: string[] = [];
    for (const m of all) {
      if (applied.has(m.version)) continue;
      if (opts.to && m.version > opts.to) break;
      try {
        await c.query("begin");
        await c.query(m.up);
        await c.query("insert into schema_migrations (version, name, checksum) values ($1,$2,$3)", [m.version, m.name, m.checksum]);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback");
        throw new Error(`migration ${m.version}_${m.name} failed: ${(e as Error).message}`);
      }
      done.push(m.version);
    }
    return done;
  });
}

/** Reverts the last `steps` applied migrations (default 1). */
export async function migrateDown(db: Db, steps = 1, dir?: string): Promise<string[]> {
  const all = new Map(loadMigrations(dir).map((m) => [m.version, m]));
  return withLock(db, async (c) => {
    const { rows } = await c.query<{ version: string }>("select version from schema_migrations order by version desc limit $1", [steps]);
    const done: string[] = [];
    for (const r of rows) {
      const m = all.get(r.version);
      if (!m) throw new Error(`no migration file for applied version ${r.version}`);
      try {
        await c.query("begin");
        await c.query(m.down);
        await c.query("delete from schema_migrations where version = $1", [m.version]);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback");
        throw new Error(`down ${m.version} failed: ${(e as Error).message}`);
      }
      done.push(m.version);
    }
    return done;
  });
}

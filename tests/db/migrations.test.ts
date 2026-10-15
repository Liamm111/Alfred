import { mkdtempSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, loadMigrations, migrateDown, migrateUp } from "../../src/db/index.js";
import { freshDb, type Db } from "./helpers.js";

let db: Db;
beforeAll(async () => (db = await freshDb()));
afterAll(() => db.end());

const tables = async () =>
  (await db.query<{ t: string }>("select tablename t from pg_tables where schemaname='public' and tablename <> 'schema_migrations' order by 1")).rows.map((r) => r.t);

describe("migrations", () => {
  it("up creates the PRD tables", async () => {
    expect(await tables()).toEqual(
      ["access_tokens","alerts","assignment_evidence","assignments","auth_codes","auth_sessions","capture_sources","deletion_receipts","evidence","evidence_packets","gaps","identities","jobs","oauth_states","outbox","packets","refresh_tokens","retention_policies","secret_refs","sessions","stream_associations","users","zoom_events","zoom_links"].sort(),
    );
  });

  it("down then up is clean and repeatable (rollback)", async () => {
    expect(await migrateDown(db, 99)).toEqual(["0002", "0001"]);
    expect(await tables()).toEqual([]);
    const fn = await db.query("select proname from pg_proc where proname in ('app_current_user','run_retention','erase_user','bump_version')");
    expect(fn.rowCount).toBe(0);
    expect(await migrateUp(db)).toEqual(["0001", "0002"]);
    expect((await tables()).length).toBe(24);
    expect(await migrateUp(db)).toEqual([]); // idempotent
  });

  it("detects a migration edited after being applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    for (const f of readdirSync(join(import.meta.dirname, "../../db/migrations"))) copyFileSync(join(import.meta.dirname, "../../db/migrations", f), join(dir, f));
    writeFileSync(join(dir, "0001_core.up.sql"), "-- tampered\n" + (await import("node:fs")).readFileSync(join(dir, "0001_core.up.sql"), "utf8"));
    await expect(migrateUp(db, { dir })).rejects.toThrow(/modified after being applied/);
  });

  it("a failing migration rolls back entirely and is not recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    for (const f of readdirSync(join(import.meta.dirname, "../../db/migrations"))) copyFileSync(join(import.meta.dirname, "../../db/migrations", f), join(dir, f));
    writeFileSync(join(dir, "0003_bad.up.sql"), "create table half_done (id int);\nselect 1/0;");
    writeFileSync(join(dir, "0003_bad.down.sql"), "drop table if exists half_done;");
    await expect(migrateUp(db, { dir })).rejects.toThrow(/0003_bad failed/);
    expect((await db.query("select to_regclass('public.half_done') r")).rows[0].r).toBeNull();
    expect((await db.query("select version from schema_migrations")).rows.map((r) => r.version)).toEqual(["0001", "0002"]);
  });

  it("two migrators racing apply each migration exactly once", async () => {
    await migrateDown(db, 99);
    const other = createPool();
    const [a, b] = await Promise.all([migrateUp(db), migrateUp(other)]);
    await other.end();
    expect([...a, ...b]).toEqual(["0001", "0002"]);
    expect((await db.query("select count(*)::int c from schema_migrations")).rows[0].c).toBe(2);
  });

  it("migration files come in up/down pairs with ordered versions", () => {
    const m = loadMigrations();
    expect(m.map((x) => x.version)).toEqual([...m.map((x) => x.version)].sort());
    for (const x of m) expect(x.down.length).toBeGreaterThan(10);
  });
});

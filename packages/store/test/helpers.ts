import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, inTx, migrateUp, withMaintenance, withUser, type Db, type Tx } from "../src/index.js";
import { createSession, transitionSession, type SessionRow } from "../src/repo.js";
import { SCHEMA_VERSION, type Packet } from "@alfred/contracts";

/**
 * The store test database is a SEPARATE database `<DATABASE_URL_TEST name>_store` on the same server:
 * these tests `drop schema public cascade`, so they must never share a database with @alfred/db's tests.
 */
export async function storeTestUrl(): Promise<string> {
  const base = process.env.DATABASE_URL_TEST ?? "postgres://alfred_test:alfred_test@127.0.0.1:5432/alfred_test";
  const u = new URL(base);
  const name = `${u.pathname.slice(1)}_store`;
  if (!/^[a-z0-9_]+_test_store$/.test(name)) throw new Error(`refusing to use non-test database "${name}"`);
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) await admin.query(`create database ${name}`);
  } finally { await admin.end(); }
  u.pathname = `/${name}`;
  return u.toString();
}

export async function freshDb(): Promise<Db> {
  const db = createPool(await storeTestUrl());
  await db.query("drop schema if exists public cascade");
  await db.query("create schema public");
  await db.query("grant usage, create on schema public to public");
  await migrateUp(db);
  return db;
}

export async function mkUser(db: Db): Promise<string> {
  const id = randomUUID();
  await withMaintenance(db, (tx) => tx.query("insert into users (id) values ($1)", [id]));
  return id;
}

let n = 0;
export const mkSession = (db: Db, owner: string, key = `k${++n}-${randomUUID()}`) =>
  withUser(db, owner, async (tx) => (await createSession(tx, { id: randomUUID(), owner_id: owner, idempotency_key: key, now_ms: 1000 })).row);

export function mkPacket(session: SessionRow, o: Partial<Packet> = {}): Packet {
  const seq = o.seq ?? ++n;
  return {
    schema_version: SCHEMA_VERSION,
    id: randomUUID(),
    session_id: session.id,
    owner_id: session.owner_id,
    source_epoch: 1,
    modality: "audio",
    seq,
    source_ts_ms: 1_700_000_000_000,
    received_wall_ms: 1_700_000_000_040,
    received_mono_ms: 5000,
    payload_bytes: 320,
    payload_sha256: "c".repeat(64),
    idempotency_key: `${session.id}:${seq}:${randomUUID()}`,
    ...o,
  };
}

export const ev = (k: string) => ({ event_type: "session.state_changed", payload: { k }, dedupe_key: `${k}:${randomUUID()}` });

export async function activate(db: Db, s: SessionRow): Promise<SessionRow> {
  return withUser(db, s.owner_id, (tx) =>
    transitionSession(tx, s.id, s.version, { state: "CONNECTING", source_epoch: 1 }, 2000, ev("connecting")),
  );
}

export async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}
export type { Db, Tx };
export { inTx, withMaintenance, withUser };

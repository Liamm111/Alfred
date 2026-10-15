import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS address_events (
  address_event_id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('alert','upgrade','retract')),
  level TEXT NOT NULL CHECK (level IN ('urgent','normal')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','rejected')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL,
  last_accepted_at INTEGER,
  last_ack_at INTEGER
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address_event_id TEXT NOT NULL REFERENCES address_events(address_event_id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','accepted','dead','cancelled','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  delivery_token TEXT NOT NULL UNIQUE,
  UNIQUE (address_event_id, channel)
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS delivery_state (
  outbox_id INTEGER PRIMARY KEY REFERENCES outbox(id),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  accepted_at INTEGER,
  device_ack_at INTEGER,
  seen_at INTEGER,
  gateway_status INTEGER,
  unconfirmed_at INTEGER
);`;

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Transaction IMMEDIATE : verrou d'écriture pris dès le début, pas de upgrade-deadlock entre deux workers. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

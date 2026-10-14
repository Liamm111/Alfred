import { sql } from 'drizzle-orm';
import { createDb } from './client';
import { migrateUp } from './migrate';

export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgres://postgres@127.0.0.1:54329/alfred_test';

/** Fresh, fully migrated database for an integration test file. DESTROYS all data in the target database. */
export async function freshTestDb(url = TEST_DATABASE_URL) {
  if (!/_test(\?|$)/.test(url)) throw new Error('Refusing to reset a database whose name does not end in _test');
  const h = createDb(url, { max: 8 });
  await h.db.execute(sql`drop schema if exists public cascade`);
  await h.db.execute(sql`drop schema if exists drizzle cascade`);
  await h.db.execute(sql`create schema public`);
  await migrateUp(h.db);
  return h;
}

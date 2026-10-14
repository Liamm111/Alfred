import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];
/** Either the root db or a transaction handle — both accept the same query API. */
export type DbOrTx = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export function createDb(databaseUrl: string, opts: { max?: number } = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  // Idle-client errors (e.g. DB restart) must not crash the process; the pool reconnects on next use.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

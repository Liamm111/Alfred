import pg from "pg";

// bigint (int8) columns hold epoch milliseconds: safely representable as JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(
  connectionString = process.env.DATABASE_URL ?? "postgres://alfred_test:alfred_test@127.0.0.1:5432/alfred_test",
  max = 10,
): Db {
  return new pg.Pool({ connectionString, max });
}

/**
 * Run `fn` in a transaction as the API role, bound to one user. `app.user_id` is set with
 * `set_config(..., is_local=true)` so it disappears at COMMIT/ROLLBACK and can not leak to the
 * next request on the same pooled connection.
 */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTx(db, async (tx) => {
    await tx.query("set local role alfred_app");
    await tx.query("select set_config('app.user_id', $1, true)", [userId]);
    return fn(tx);
  });
}

/** Privileged maintenance (retention, outbox relay, erasure on behalf of the system). */
export async function withMaintenance<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTx(db, async (tx) => {
    await tx.query("set local role alfred_maintenance");
    return fn(tx);
  });
}

export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("begin");
    const out = await fn(tx);
    await tx.query("commit");
    return out;
  } catch (e) {
    await tx.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}

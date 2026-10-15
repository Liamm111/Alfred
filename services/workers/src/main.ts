import { hostname } from 'node:os';
import { createLogger, newId, parseEnv, requireDatabaseUrl } from '@alfred/core';
import { assertSchemaUpToDate, createDb } from '@alfred/db';
import { startWorker, type Handlers } from './runner';

async function main() {
  const env = parseEnv();
  const logger = createLogger({ level: env.LOG_LEVEL });
  const { db, close } = createDb(requireDatabaseUrl(env), { max: 5 });
  await assertSchemaUpToDate(db, env.MIGRATIONS_DIR);
  // Business handlers arrive in later blocks. Only the synthetic one exists, and only in simulation mode.
  const handlers: Handlers = env.MOCK_MODE ? { 'demo.noop': async () => undefined } : {};
  const w = startWorker({ db, workerId: `${hostname()}-${newId().slice(0, 8)}`, handlers, leaseMs: env.WORKER_LEASE_MS, pollMs: env.WORKER_POLL_MS });
  logger.info({ handlers: Object.keys(handlers), mockMode: env.MOCK_MODE }, 'worker started');
  const stop = async () => { await w.stop(); await close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch((e: unknown) => { process.stderr.write(`fatal: ${e instanceof Error ? e.message : 'startup failed'}\n`); process.exit(1); });

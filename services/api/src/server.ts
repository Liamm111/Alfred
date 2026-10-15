import { createLogger, parseEnv, requireDatabaseUrl } from '@alfred/core';
import { assertSchemaUpToDate, createDb } from '@alfred/db';
import { buildApp } from './app';

async function main() {
  const env = parseEnv(); // throws (exit 1) on invalid config, incl. MOCK_MODE=true in production
  const logger = createLogger({ level: env.LOG_LEVEL });
  const { db, close } = createDb(requireDatabaseUrl(env));
  await assertSchemaUpToDate(db, env.MIGRATIONS_DIR); // O01: refuse to serve on a schema that is behind
  const app = await buildApp({ env, db, logger });
  const shutdown = async () => { await app.close(); await close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info({ mockMode: env.MOCK_MODE, appEnv: env.APP_ENV }, 'api started');
}
main().catch((e: unknown) => { process.stderr.write(`fatal: ${e instanceof Error ? e.message : 'startup failed'}\n`); process.exit(1); });

/* eslint-disable no-console -- CLI output */
import { parseEnv, requireDatabaseUrl } from '@alfred/core';
import { createDb } from './client';
import { migrateDown, migrateUp, schemaStatus } from './migrate';

async function main() {
  const cmd = process.argv[2];
  const env = parseEnv();
  const { db, close } = createDb(requireDatabaseUrl(env), { max: 2 });
  try {
    if (cmd === 'up') { await migrateUp(db); console.log('migrated up'); }
    else if (cmd === 'down') { const steps = Number(process.argv[3] ?? 1); console.log('rolled back:', await migrateDown(db, steps)); }
    else if (cmd === 'status') { console.log(await schemaStatus(db)); }
    else { console.error('usage: up | down [steps] | status'); process.exitCode = 64; }
  } finally {
    await close();
  }
}
main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : 'migration failed'); process.exit(1); });

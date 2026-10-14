import { claim, createDb } from '../db/src/index';

const h = createDb(process.env.DATABASE_URL ?? '');
const j = await claim(h.db, { workerId: 'post-crash', leaseMs: 1000 });
console.log(j ? `claim after restart: OK (${j.type}/${j.uniqueKey})` : 'claim after restart: NONE');
await h.close();
process.exit(j ? 0 : 1);

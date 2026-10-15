import { createLogger } from './redact.js';
import { DeadLetter } from './dead-letter.js';
import { SessionManager } from './session-manager.js';
import { AssociationStore } from './association.js';
import { createSdkAdapterFactory } from './rtms-adapter.js';
import { createServer } from './server.js';

const logger = createLogger();
const need = (k) => { if (!process.env[k]) { logger.error('missing_env', { key: k }); process.exit(2); } return process.env[k]; };
const secretToken = need('ZOOM_WEBHOOK_SECRET_TOKEN');
need('ZM_RTMS_CLIENT'); need('ZM_RTMS_SECRET');
const association = new AssociationStore({ secret: need('ASSOCIATION_SECRET') });
const deadLetter = new DeadLetter({ onEntry: (e) => logger.warn('dead_letter', e) });
const manager = new SessionManager({
  adapterFactory: await createSdkAdapterFactory({ logger }),
  sink: (item) => { if (item.kind === 'health' || item.kind === 'gap') logger.info('item', item); /* media sink: Bloc 08+ */ },
  deadLetter, logger,
  authorize: (uuid) => process.env.ALLOW_UNASSOCIATED === '1' || association.profileFor(uuid) !== null,
  maxConcurrent: Number(process.env.MAX_CONCURRENT ?? 5),
});
setInterval(() => manager.reconcile(), 30_000).unref();
const server = createServer({ secret: secretToken, manager, association, logger });
server.listen(Number(process.env.PORT ?? 8080), () => logger.info('listening', { port: Number(process.env.PORT ?? 8080) }));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { manager.stopAll('process_exit'); server.close(); setTimeout(() => process.exit(0), 200); });

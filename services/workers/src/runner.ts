import { claim, complete, fail, type ClaimedJob, type Db } from '@alfred/db';

export class NonRetryableError extends Error {
  constructor(public readonly errorCode: string) {
    super(errorCode);
    this.name = 'NonRetryableError';
  }
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;
export type Handlers = Record<string, JobHandler>;

export interface RunnerOptions {
  db: Db;
  workerId: string;
  handlers: Handlers;
  leaseMs: number;
  now?: () => Date;
}

/** Claim and execute at most one job. Ack only after the handler resolved. Returns what happened. */
export async function runOnce(opts: RunnerOptions): Promise<'idle' | 'succeeded' | 'retry' | 'dead' | 'lost'> {
  const now = opts.now ?? (() => new Date());
  const job = await claim(opts.db, { workerId: opts.workerId, leaseMs: opts.leaseMs, types: Object.keys(opts.handlers), now: now() });
  if (!job) return 'idle';
  const handler = opts.handlers[job.type];
  try {
    if (!handler) throw new NonRetryableError('no_handler');
    await handler(job);
  } catch (e) {
    // Only an error *code* is stored — never the message (could contain user content).
    const errorCode = e instanceof NonRetryableError ? e.errorCode : 'handler_error';
    return fail(opts.db, job, { errorCode, retryable: !(e instanceof NonRetryableError), now: now() });
  }
  return (await complete(opts.db, job, now())) ? 'succeeded' : 'lost';
}

export function startWorker(opts: RunnerOptions & { pollMs: number }) {
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      let r: Awaited<ReturnType<typeof runOnce>> = 'idle';
      try { r = await runOnce(opts); } catch { /* transient DB error: retry on next tick */ }
      if (r === 'idle') await new Promise((res) => setTimeout(res, opts.pollMs));
    }
  })();
  return { stop: async () => { stopped = true; await done; } };
}

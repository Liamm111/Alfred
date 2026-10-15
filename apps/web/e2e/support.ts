import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUTBOX = process.env.E2E_OUTBOX ?? '/tmp/alfred-e2e-outbox';
export const E2E_DB = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL_TEST ?? 'postgres://postgres@127.0.0.1:54329/alfred_test';

/** Newest magic-link URL written by the file mail transport for this recipient. */
export async function latestLinkFor(email: string, after = 0): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.reverse()) {
      const mail = JSON.parse(readFileSync(join(OUTBOX, f), 'utf8')) as { to: string; text: string };
      if (mail.to.toLowerCase() === email.toLowerCase() && Number(f.split('-')[0]) >= after) {
        const m = /https?:\/\/\S+/.exec(mail.text);
        if (m) return m[0];
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail for ${email}`);
}

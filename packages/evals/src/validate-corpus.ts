/* eslint-disable no-console -- CLI output */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attentionExampleSchema, parseJsonl } from './index';

const dir = join(import.meta.dirname, '..', 'data');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  const items = parseJsonl(readFileSync(join(dir, f), 'utf8'), attentionExampleSchema);
  console.log(`${f}: ${items.length} valid examples (synthetic only)`);
}

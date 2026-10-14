import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attentionExampleSchema, parseJsonl } from '../src';

describe('eval corpus format', () => {
  it('sample corpus is valid and synthetic', () => {
    const raw = readFileSync(join(import.meta.dirname, '../data/attention.sample.synthetic.jsonl'), 'utf8');
    expect(parseJsonl(raw, attentionExampleSchema)).toHaveLength(3);
  });
  it('rejects non-synthetic origin', () => {
    expect(() => parseJsonl('{"id":"x","origin":"real","lang":"fr","category":"MENTION_ONLY","alias":"a","utterance":"u","expectedUrgent":false}', attentionExampleSchema)).toThrow();
  });
});

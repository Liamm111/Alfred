import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { scanSource } from '../forbid-bot-join.mjs';

const scan = (p: string, t: string): string[] => scanSource(p, t);
// Fixtures are assembled at runtime so this very file never contains a forbidden literal.
const j = (...p: string[]) => p.join('');

describe('bot-join guard', () => {
  it('flags participant-join calls, declarations and imports (AST)', () => {
    expect(scan('a.ts', `await client.${j('join', 'Meeting')}({ id: 1 });`)).toHaveLength(1);
    expect(scan('a.ts', `const b = await svc.${j('create', 'Bot')}(x);`)).toHaveLength(1);
    expect(scan('a.ts', `class P { async ${j('create', 'Bot')}() {} }`)).toHaveLength(1);
    expect(scan('a.ts', `import R from '${j('recall', 'ai-sdk')}';`).length).toBeGreaterThan(0);
    expect(scan('a.ts', `import { x } from '@zoom/${j('meeting', 'sdk')}';`).length).toBeGreaterThan(0);
    expect(scan('a.js', `const z = require('${j('@zoomus/', 'websdk')}');`).length).toBeGreaterThan(0);
    expect(scan('a.ts', `const m = await import('${j('meeting', '-sdk')}');`).length).toBeGreaterThan(0);
    expect(scan('a.ts', `${j('Zoom', 'Mtg')}.join({});`).length).toBeGreaterThan(0);
  });
  it('flags bot_join=true in code, env files and yaml, but not false', () => {
    expect(scan('c.ts', `const f = { ${j('bot', '_join')}: true };`)).toHaveLength(1);
    expect(scan('c.ts', `process.env.${j('BOT', '_JOIN')} = 'true';`)).toHaveLength(1);
    expect(scan('.env', `${j('BOT', '_JOIN')}=true`)).toHaveLength(1);
    expect(scan('ci.yml', `  ${j('bot', '_join')}: "true"`)).toHaveLength(1);
    expect(scan('c.ts', `const f = { ${j('bot', '_join')}: false };`)).toEqual([]);
    expect(scan('.env', `${j('BOT', '_JOIN')}=false`)).toEqual([]);
  });
  it('flags forbidden dependencies and Swift meeting SDK usage', () => {
    expect(scan('package.json', JSON.stringify({ dependencies: { [j('@zoom/', 'meetingsdk')]: '1.0.0' } })).length).toBeGreaterThan(0);
    expect(scan('x/Join.swift', `let s = ${j('Mobile', 'RTC')}.shared()`)).toHaveLength(1);
    expect(scan('p.ts', `fetch('https://${j('api.', 'recall', '.ai')}/api/v1/bot/')`)).toHaveLength(1);
  });
  it('allows the sanctioned Zoom surfaces', () => {
    expect(scan('g.ts', `import rtms from '@zoom/rtms'; rtms.onWebhookEvent(() => {});`)).toEqual([]);
    expect(scan('s.ts', `import zoomSdk from '@zoom/appssdk'; await zoomSdk.callZoomApi('startRTMS');`)).toEqual([]);
    expect(scan('n.ts', `const x = recall(0.95); // classifier recall metric`)).toEqual([]);
    expect(scan('package.json', JSON.stringify({ dependencies: { '@zoom/rtms': '1.0.0', '@zoom/appssdk': '1.0.0' } }))).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers';

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => { t = await makeTestApp({ AUTH_MAGIC_LINK_MAX_PER_MIN: '3' }); });
afterAll(async () => { await t.app.close(); await t.close(); });

describe('magic-link rate limit per client', () => {
  it('buckets by the server-resolved IP: a client-sent x-client-ip cannot dodge it', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { ...t.jsonHeaders(), 'x-client-ip': `198.51.100.${i}` }, payload: { email: `spoof${i}@example.test` }, remoteAddress: '203.0.113.50' });
      codes.push(r.statusCode);
    }
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it('returns 429 after the configured number of requests per minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: t.jsonHeaders(), payload: { email: `rl${i}@example.test` }, remoteAddress: '203.0.113.9' });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '@alfred/core';
import { freshTestDb } from '@alfred/db/testing';
import { buildApp } from '../src/app';

let h: Awaited<ReturnType<typeof freshTestDb>>;
beforeAll(async () => { h = await freshTestDb(); });
afterAll(() => h.close());

describe('email transport disabled', () => {
  it('fails honestly (no fake "mail sent")', async () => {
    const app = await buildApp({ env: parseEnv({ APP_ENV: 'test', LOG_LEVEL: 'silent', EMAIL_TRANSPORT: 'disabled' }), db: h.db });
    const r = await app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, payload: { email: 'x@example.test' } });
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    await app.close();
  });
});

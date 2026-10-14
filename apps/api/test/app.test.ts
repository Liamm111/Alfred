import { describe, expect, it } from 'vitest';
import { errorResponseSchema, parseEnv } from '@alfred/core';
import { buildApp } from '../src/app';

const silent = { LOG_LEVEL: 'silent' };
const mk = async (e: Record<string, string>) => buildApp({ env: parseEnv({ ...silent, ...e }), db: null });

describe('api foundation', () => {
  it('liveness is public and reveals nothing', async () => {
    const app = await mk({});
    const r = await app.inject('/health/live');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });
  it('echoes a safe x-request-id and generates one otherwise', async () => {
    const app = await mk({});
    expect((await app.inject({ url: '/health/live', headers: { 'x-request-id': 'trace-12345678' } })).headers['x-request-id']).toBe('trace-12345678');
    expect((await app.inject({ url: '/health/live', headers: { 'x-request-id': 'bad id\t!' } })).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('404 and malformed requests use the standard error shape, no leak', async () => {
    const app = await mk({});
    const r = await app.inject('/nope');
    expect(r.statusCode).toBe(404);
    const body = errorResponseSchema.parse(r.json());
    expect(body.code).toBe('not_found');
    expect(body.requestId).toBe(r.headers['x-request-id']);
  });
  it('oversize body => 413 standard error', async () => {
    const app = await mk({});
    app.post('/echo', async () => ({}));
    const r = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ a: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(r.statusCode).toBe(413);
    expect(errorResponseSchema.parse(r.json()).code).toBe('payload_too_large');
  });
  it('readiness without db is 503 degraded', async () => {
    const app = await mk({});
    const r = await app.inject('/health/ready');
    expect(r.statusCode).toBe(503);
    expect(r.json().status).toBe('degraded');
  });
  it('readiness requires the bearer token when configured', async () => {
    const token = 't'.repeat(30);
    const app = await mk({ HEALTH_TOKEN: token });
    expect((await app.inject('/health/ready')).statusCode).toBe(401);
    expect((await app.inject({ url: '/health/ready', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/health/ready', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(503); // authed, db absent
  });
});

describe('demo routes are simulation-only', () => {
  it('absent when MOCK_MODE=false', async () => {
    const app = await mk({ MOCK_MODE: 'false' });
    expect((await app.inject('/dev/demo/transcript')).statusCode).toBe(404);
  });
  it('present, flagged as simulation, when MOCK_MODE=true outside production', async () => {
    const app = await mk({ APP_ENV: 'test', MOCK_MODE: 'true' });
    const r = await app.inject('/dev/demo/transcript');
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-simulation']).toBe('true');
    expect(r.json().simulated).toBe(true);
  });
  it('a production app cannot even be configured with mock mode', () => {
    expect(() => parseEnv({ APP_ENV: 'production', MOCK_MODE: 'true', DATABASE_URL: 'postgres://x', HEALTH_TOKEN: 'h'.repeat(24), PUBLIC_WEB_ORIGIN: 'https://a.test' })).toThrow();
  });
});

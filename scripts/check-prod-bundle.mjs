#!/usr/bin/env node
// Release check: after `pnpm build`, prove that the PRODUCTION artefacts expose no demo route and no secret.
// Requires a migrated Postgres at DATABASE_URL_TEST (default local sandbox cluster).
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DB = process.env.DATABASE_URL_TEST ?? 'postgres://postgres@127.0.0.1:54329/alfred_test';
const SENTINEL = 'SENTINEL_SECRET_' + 'Zq9x'.repeat(8);
let failures = 0;
const waitExit = (p) => (p.exitCode !== null ? Promise.resolve(p.exitCode) : new Promise((r) => p.on('exit', r)));
// The check needs a migrated DB regardless of what previous test suites left behind.
execFileSync('pnpm', ['--filter', '@alfred/db', 'migrate:up'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' });
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failures++; };

function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

// 1) Web bundle: client-reachable output must contain no sentinel secret and no demo route.
for (const f of walk('apps/web/.next/static')) {
  const t = readFileSync(f, 'utf8');
  if (t.includes(SENTINEL) || t.includes('/dev/demo') || t.includes('DATABASE_URL') || t.includes('HEALTH_TOKEN')) { check(false, `web static file leaks: ${f}`); }
}
check(true, 'web client bundle (.next/static) contains no secret names, sentinel or demo route');

// 2) Production API refuses MOCK_MODE=true.
const baseEnv = { PATH: process.env.PATH, APP_ENV: 'production', DATABASE_URL: DB, HEALTH_TOKEN: SENTINEL, AUTH_SECRET: SENTINEL + 'AUTH', EMAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://user:pw@127.0.0.1:2525', EMAIL_FROM: 'Assistant IA <no-reply@example.test>', PUBLIC_WEB_ORIGIN: 'https://app.example.test', API_PORT: '4555', MIGRATIONS_DIR: 'packages/db/drizzle', LOG_LEVEL: 'silent' };
const run = (env) => spawn('node', ['apps/api/dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });

const bad = run({ ...baseEnv, MOCK_MODE: 'true' });
let badErr = '';
bad.stderr.on('data', (d) => (badErr += d));
const badCode = await waitExit(bad);
check(badCode !== 0 && /MOCK_MODE/.test(badErr), 'built API exits non-zero with APP_ENV=production MOCK_MODE=true');
check(!badErr.includes(SENTINEL), 'startup error does not echo secret values');

// 3) Production API with mock off: demo route absent, ready is token-protected.
const good = run({ ...baseEnv, MOCK_MODE: 'false' });
let out = '';
good.stdout.on('data', (d) => (out += d)); good.stderr.on('data', (d) => (out += d));
const base = 'http://127.0.0.1:4555';
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try { up = (await fetch(`${base}/health/live`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
check(up, `built API (production) starts on migrated DB${up ? '' : ': ' + out}`);
if (up) {
  check((await fetch(`${base}/dev/demo/transcript`)).status === 404, 'production API: /dev/demo/transcript => 404');
  check((await fetch(`${base}/api/me`)).status === 401, 'production API: /api/me without session => 401');
  check((await fetch(`${base}/health/ready`)).status === 401, 'production API: /health/ready without token => 401');
  const r = await fetch(`${base}/health/ready`, { headers: { authorization: `Bearer ${SENTINEL}` } });
  const j = await r.json();
  check(r.status === 200 && j.mockMode === false && j.checks.schema === 'ok', 'production API: ready with token => ok, mockMode=false, schema ok');
  const t = JSON.stringify(j);
  check(!t.includes(SENTINEL) && !t.includes('postgres://'), 'ready payload leaks no secret/DSN');
}
// File mail transport (writes magic links to disk) must be impossible in production.
const fileMail = run({ ...baseEnv, MOCK_MODE: 'false', EMAIL_TRANSPORT: 'file', EMAIL_OUTBOX_DIR: '/tmp/x', API_PORT: '4556' });
let fileErr = '';
fileMail.stderr.on('data', (d) => (fileErr += d));
check((await waitExit(fileMail)) !== 0 && /EMAIL_TRANSPORT/.test(fileErr), 'production API refuses EMAIL_TRANSPORT=file');
good.kill('SIGTERM');
await waitExit(good);

process.exit(failures ? 1 : 0);

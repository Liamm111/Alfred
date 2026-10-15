import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeBackoff } from '../src/backoff.js';
import { redact, createLogger } from '../src/redact.js';
import { AssociationStore } from '../src/association.js';
import { classifyStop } from '../src/stop-reasons.js';

test('backoff: exponential ceiling, full jitter, capped', () => {
  assert.equal(computeBackoff(0, { rng: () => 0.999 }), 499);
  assert.equal(computeBackoff(3, { rng: () => 0.999 }), 3996);
  assert.ok(computeBackoff(20, { rng: () => 0.999 }) <= 30_000);
  assert.equal(computeBackoff(5, { rng: () => 0 }), 0);
  const samples = new Set(Array.from({ length: 50 }, () => computeBackoff(4)));
  assert.ok(samples.size > 10, 'jitter must spread delays');
  assert.throws(() => computeBackoff(-1));
});

test('redaction: secrets, ids, names, text, urls never logged in clear', () => {
  const lines = []; const log = createLogger((l) => lines.push(l), () => 't');
  log.info('x', { signature: 'v0=abcdef0123456789abcdef', client_secret: 's3cr3t', rtms_stream_id: 'STREAM-ABC', meeting_uuid: 'UUID-XYZ',
    userName: 'Alice Martin', text: 'private words', server_urls: 'wss://rtms.zoom.us/x', note: 'Bearer abc.def.ghi', buffer: Buffer.alloc(9) });
  const s = lines[0];
  for (const bad of ['s3cr3t', 'STREAM-ABC', 'UUID-XYZ', 'Alice', 'private words', 'rtms.zoom.us', 'abc.def.ghi', 'abcdef0123456789']) assert.ok(!s.includes(bad), bad);
  assert.ok(s.includes('[bytes:9]') || s.includes('[redacted]'));
});

test('association: nonce single-use, expiring, receipt verifiable', () => {
  let t = 1000; const st = new AssociationStore({ secret: 'k', now: () => t, ttlMs: 1000 });
  const { nonce } = st.issueNonce('p'); const r = st.redeem(nonce, 'meeting-uuid-123');
  assert.ok(r.ok); assert.ok(st.verifyReceipt('p', 'meeting-uuid-123', r.receipt)); assert.ok(!st.verifyReceipt('p', 'other-meeting-xx', r.receipt));
  assert.equal(st.redeem(nonce, 'meeting-uuid-123').reason, 'unknown_nonce');
  const n2 = st.issueNonce('p').nonce; t += 1500;
  assert.equal(st.redeem(n2, 'meeting-uuid-123').reason, 'expired_nonce');
  assert.equal(st.profileFor('meeting-uuid-123'), 'p');
});

test('stop-reason classification', () => {
  assert.equal(classifyStop('HOST_TRIGGERED'), 'terminal');
  assert.equal(classifyStop('KEEP_ALIVE_TIMEOUT'), 'transient');
  assert.equal(classifyStop('AUTHENTICATION_FAILURE'), 'fatal');
  assert.equal(classifyStop('SOMETHING_NEW'), 'transient');
});

test('REAL @zoom/rtms SDK: version locked and API surface present', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies['@zoom/rtms'], '1.1.0'); // exact pin, no ^ or ~
  const installed = JSON.parse(readFileSync(new URL('../node_modules/@zoom/rtms/package.json', import.meta.url)));
  assert.equal(installed.version, '1.1.0');
  const rtms = (await import('@zoom/rtms')).default;
  const c = new rtms.Client();
  for (const m of ['join', 'leave', 'onAudioData', 'onTranscriptData', 'onDeskshareData', 'onJoinConfirm', 'onLeave', 'setAudioParams', 'onSharingEvent'])
    assert.equal(typeof c[m], 'function', m);
  assert.equal(rtms.StopReason.HOST_TRIGGERED, 1);
  assert.equal(typeof c.onChatData, 'undefined', 'chat callback absent in 1.1.0 -> documented gap');
  const { TERMINAL } = await import('../src/stop-reasons.js');
  for (const name of TERMINAL) assert.ok(name in rtms.StopReason, `unknown stop reason ${name}`);
});

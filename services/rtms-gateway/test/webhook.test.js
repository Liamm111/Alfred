import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { verifyWebhook, sign, urlValidationResponse, ReplayCache } from '../src/webhook.js';
import { createServer } from '../src/server.js';
import { AssociationStore } from '../src/association.js';
import { silentLogger } from './helpers.js';

const secret = 'test-secret-token';
const NOW = 1_700_000_000_000;
const mk = (body, tsMs = NOW, s = secret) => {
  const ts = String(Math.floor(tsMs / 1000));
  return { rawBody: body, headers: { 'x-zm-signature': sign(s, ts, body), 'x-zm-request-timestamp': ts } };
};
const body = JSON.stringify({ event: 'meeting.rtms_started', payload: { rtms_stream_id: 'x' } });

test('valid signature accepted', () => {
  const r = verifyWebhook({ ...mk(body), secret, now: NOW });
  assert.equal(r.ok, true); assert.equal(r.event.event, 'meeting.rtms_started');
});
test('wrong secret rejected', () => assert.equal(verifyWebhook({ ...mk(body, NOW, 'other'), secret, now: NOW }).reason, 'bad_signature'));
test('tampered body rejected', () => {
  const m = mk(body); assert.equal(verifyWebhook({ ...m, rawBody: body + ' ', secret, now: NOW }).reason, 'bad_signature');
});
test('stale timestamp rejected (before signature check result matters)', () =>
  assert.equal(verifyWebhook({ ...mk(body, NOW - 6 * 60_000), secret, now: NOW }).reason, 'stale_timestamp'));
test('future timestamp rejected', () =>
  assert.equal(verifyWebhook({ ...mk(body, NOW + 6 * 60_000), secret, now: NOW }).reason, 'stale_timestamp'));
test('missing / malformed headers rejected', () => {
  assert.equal(verifyWebhook({ rawBody: body, headers: {}, secret, now: NOW }).reason, 'missing_headers');
  assert.equal(verifyWebhook({ rawBody: body, headers: { 'x-zm-signature': 'v0=a', 'x-zm-request-timestamp': 'abc' }, secret, now: NOW }).reason, 'bad_timestamp');
});
test('replay rejected, but forged request does not poison the cache', () => {
  const cache = new ReplayCache({ now: () => NOW }); const m = mk(body);
  assert.equal(verifyWebhook({ ...m, secret, now: NOW, replayCache: cache }).ok, true);
  assert.equal(verifyWebhook({ ...m, secret, now: NOW, replayCache: cache }).reason, 'replay');
  const forged = { rawBody: body, headers: { ...m.headers, 'x-zm-signature': 'v0=' + '0'.repeat(64) } };
  assert.equal(verifyWebhook({ ...forged, secret, now: NOW, replayCache: cache }).reason, 'bad_signature');
  assert.equal(cache.map.size, 1);
});
test('url validation token', () => {
  const r = urlValidationResponse(secret, 'abc');
  assert.equal(r.plainToken, 'abc'); assert.match(r.encryptedToken, /^[0-9a-f]{64}$/);
});

async function withServer(fn) {
  const calls = [];
  const mgr = { onWebhook: (e) => { calls.push(e); return { handled: true }; }, active: () => [] };
  const association = new AssociationStore({ secret: 'assoc' });
  const srv = createServer({ secret, manager: mgr, association, logger: silentLogger });
  srv.listen(0); await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn({ base, calls, association }); } finally { srv.close(); }
}
const signed = (b) => { const ts = String(Math.floor(Date.now() / 1000)); return { 'x-zm-signature': sign(secret, ts, b), 'x-zm-request-timestamp': ts, 'content-type': 'application/json' }; };

test('HTTP: forged webhook never reaches the manager; valid one does; replay is refused', async () => {
  await withServer(async ({ base, calls }) => {
    let r = await fetch(`${base}/zoom/webhook`, { method: 'POST', body, headers: { ...signed(body), 'x-zm-signature': 'v0=bad' } });
    assert.equal(r.status, 401); assert.equal(calls.length, 0);
    const h = signed(body);
    r = await fetch(`${base}/zoom/webhook`, { method: 'POST', body, headers: h }); assert.equal(r.status, 200);
    r = await fetch(`${base}/zoom/webhook`, { method: 'POST', body, headers: h }); assert.equal(r.status, 409);
    assert.equal(calls.length, 1);
  });
});
test('HTTP: url_validation answered', async () => {
  await withServer(async ({ base }) => {
    const b = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'tok' } });
    const r = await fetch(`${base}/zoom/webhook`, { method: 'POST', body: b, headers: signed(b) });
    assert.deepEqual(await r.json(), urlValidationResponse(secret, 'tok'));
  });
});
test('HTTP: association accepts only nonce + meetingUUID (no tokens), single use', async () => {
  await withServer(async ({ base, association }) => {
    const { nonce } = association.issueNonce('profile-1');
    const post = (o) => fetch(`${base}/v1/association`, { method: 'POST', body: JSON.stringify(o) });
    assert.equal((await post({ nonce, meetingUUID: 'abcdEFGH12345678==', access_token: 'leak' })).status, 400);
    const { nonce: n2 } = association.issueNonce('profile-1');
    const ok = await post({ nonce: n2, meetingUUID: 'abcdEFGH12345678==' });
    assert.equal(ok.status, 200);
    assert.equal(association.profileFor('abcdEFGH12345678=='), 'profile-1');
    assert.equal((await post({ nonce: n2, meetingUUID: 'abcdEFGH12345678==' })).status, 403);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtmsController, classifyError, compareVersions } from '../src/rtms-controller.js';
import { createAssociationClient } from '../src/association-client.js';
import { compareParticipantLists } from '../src/participants.js';

const P = (n) => Array.from({ length: n }, (_, i) => ({ participantUUID: `u${i}`, screenName: `P${i}` }));

function mockSdk(over = {}) {
  const calls = []; let handler = null; const participants = over.participants ?? P(3);
  const sdk = {
    calls, emit: (e) => handler(e),
    config: async (o) => { calls.push(['config', o]); if (over.configError) throw over.configError; return { runningContext: 'inMeeting', clientVersion: '6.5.0', unsupportedApis: [], auth: { status: 'authorized' }, ...over.cfg }; },
    getMeetingUUID: async () => ({ meetingUUID: 'abc/def+MEETING==' }),
    getMeetingParticipants: async () => ({ participants: [...participants] }),
    getRTMSStatus: async () => ({ rtmsStatus: over.status ?? [] }),
    onRTMSStatusChange: (h) => { handler = h; },
    startRTMS: async () => { calls.push(['startRTMS']); if (over.startError) throw over.startError; return { message: 'ok' }; },
    stopRTMS: async () => { calls.push(['stopRTMS']); return { message: 'ok' }; },
    addParticipantOnStart: over.addParticipantOnStart,
  };
  return sdk;
}
const okAssoc = () => { const sent = []; return { sent, associate: async (x) => { sent.push(x); return { ok: true }; } }; };
const mk = (sdk, association = okAssoc(), extra = {}) => new RtmsController({ zoomSdk: sdk, association, ...extra });
const called = (sdk, n) => sdk.calls.filter((c) => c[0] === n).length;

test('init never starts RTMS by itself', async () => {
  const sdk = mockSdk(); const c = mk(sdk); await c.init();
  assert.equal(c.state, 'ready'); assert.equal(called(sdk, 'startRTMS'), 0);
});
test('Zoom Apps unavailable (opened in a normal browser)', async () => { const c = mk(undefined); await c.init(); assert.equal(c.state, 'unavailable'); });
test('config failure -> unavailable; guest error -> guest', async () => {
  let c = mk(mockSdk({ configError: new Error('boom') })); await c.init(); assert.equal(c.state, 'unavailable');
  c = mk(mockSdk({ configError: Object.assign(new Error('Guest users are not supported'), {}) })); await c.init(); assert.equal(c.state, 'guest');
});
test('not in a meeting / old client / API unsupported', async () => {
  let c = mk(mockSdk({ cfg: { runningContext: 'inMainClient' } })); await c.init(); assert.equal(c.state, 'not_in_meeting');
  c = mk(mockSdk({ cfg: { clientVersion: '6.3.0' } })); await c.init(); assert.equal(c.state, 'unsupported'); assert.equal(c.detail.why, 'client_version');
  c = mk(mockSdk({ cfg: { unsupportedApis: ['startRTMS'] } })); await c.init(); assert.equal(c.state, 'unsupported'); assert.equal(c.detail.why, 'api_unsupported');
});
test('request -> awaiting_host -> started; only nonce+meetingUUID leave the app', async () => {
  const sdk = mockSdk(); const assoc = okAssoc(); const c = mk(sdk, assoc); await c.init();
  await c.requestStart({ nonce: 'ABCD2345' });
  assert.equal(c.state, 'awaiting_host'); assert.equal(called(sdk, 'startRTMS'), 1);
  assert.deepEqual(assoc.sent, [{ nonce: 'ABCD2345', meetingUUID: 'abc/def+MEETING==' }]);
  await sdk.emit({ status: 'started', rtmsSessionId: 's', displayName: 'x', timestamp: 1 });
  assert.equal(c.state, 'started');
});
test('same participant list before/after start (no extra participant)', async () => {
  const sdk = mockSdk(); const c = mk(sdk); await c.init(); await c.requestStart({ nonce: 'N' });
  await sdk.emit({ status: 'started' });
  const r = c.participantsUnchanged(); assert.equal(r.same, true); assert.equal(r.beforeCount, 3);
  assert.equal(compareParticipantLists(P(3), P(4)).same, false); // detector would catch a bot joining
});
test('host denies via rejection or via status stopped while awaiting', async () => {
  let c = mk(mockSdk({ startError: Object.assign(new Error('Request denied by host'), { code: 10017 }) })); await c.init(); await c.requestStart({ nonce: 'N' });
  assert.equal(c.state, 'denied');
  const sdk = mockSdk(); c = mk(sdk); await c.init(); await c.requestStart({ nonce: 'N' });
  await sdk.emit({ status: 'stopped' }); assert.equal(c.state, 'denied');
});
test('disabled by host/admin', async () => {
  const c = mk(mockSdk({ startError: new Error('RTMS is disabled for this account') })); await c.init(); await c.requestStart({ nonce: 'N' });
  assert.equal(c.state, 'disabled');
});
test('approval timeout', async () => {
  let fire; const c = mk(mockSdk(), okAssoc(), { setTimeoutFn: (fn) => { fire = fn; return 1; }, clearTimeoutFn: () => {} });
  await c.init(); await c.requestStart({ nonce: 'N' }); fire(); assert.equal(c.state, 'timeout');
});
test('association refused -> startRTMS is never called', async () => {
  const sdk = mockSdk(); const c = mk(sdk, { associate: async () => ({ ok: false, reason: 'expired_nonce' }) });
  await c.init(); await c.requestStart({ nonce: 'N' });
  assert.equal(c.state, 'association_failed'); assert.equal(called(sdk, 'startRTMS'), 0);
});
test('stop after started', async () => {
  const sdk = mockSdk(); const c = mk(sdk); await c.init(); await c.requestStart({ nonce: 'N' }); await sdk.emit({ status: 'started' });
  await c.stop(); assert.equal(c.state, 'stopped'); assert.equal(called(sdk, 'stopRTMS'), 1);
});
test('host stops RTMS from Zoom UI', async () => {
  const sdk = mockSdk(); const c = mk(sdk); await c.init(); await c.requestStart({ nonce: 'N' }); await sdk.emit({ status: 'started' });
  await sdk.emit({ status: 'stopped' }); assert.equal(c.state, 'stopped');
});
test('app reopened mid-session picks up existing RTMS status', async () => {
  const c = mk(mockSdk({ status: [{ rtmsSessionId: 's', displayName: 'x', status: 'started', timestamp: 1 }] })); await c.init();
  assert.equal(c.state, 'started');
});
test('request ignored unless state allows it (no double start)', async () => {
  const sdk = mockSdk(); const c = mk(sdk); await c.init(); await c.requestStart({ nonce: 'N' }); await c.requestStart({ nonce: 'N' });
  assert.equal(called(sdk, 'startRTMS'), 1);
});
test('association client: body has exactly two fields, no credentials, no secrets', async () => {
  let seen; const cl = createAssociationClient({ baseUrl: 'https://b.invalid', fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true }; } });
  await cl.associate({ nonce: 'N', meetingUUID: 'M', access_token: 'LEAK' });
  assert.deepEqual(JSON.parse(seen.o.body), { nonce: 'N', meetingUUID: 'M' }); assert.equal(seen.o.credentials, 'omit');
  const down = createAssociationClient({ baseUrl: 'x', fetchImpl: async () => { throw new Error('net'); } });
  assert.deepEqual(await down.associate({ nonce: 'N', meetingUUID: 'M' }), { ok: false, reason: 'network' });
});
test('classifiers', () => {
  assert.equal(classifyError(new Error('xyz')), 'error'); assert.equal(compareVersions('6.10.0', '6.4.10'), 1); assert.equal(compareVersions('6.4.10', '6.4.10'), 0);
});
test('Zoom App source contains no secret / token handling', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  for (const f of readdirSync(new URL('../src/', import.meta.url))) {
    const s = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!/client_secret|ZM_RTMS_SECRET|access_token|Authorization/i.test(s.replace(/\/\/.*$/gm, '')), f);
  }
});
test('REAL @zoom/appssdk typings expose the RTMS API we rely on', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const p = new URL('../node_modules/@zoom/appssdk/dist/sdk.d.ts', import.meta.url);
  if (!existsSync(p)) return; // run `npm i` to enable
  const d = readFileSync(p, 'utf8');
  for (const m of ['startRTMS()', 'stopRTMS()', 'pauseRTMS()', 'resumeRTMS()', 'getRTMSStatus()', 'onRTMSStatusChange(']) assert.ok(d.includes(m), m);
});

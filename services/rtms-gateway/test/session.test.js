import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, started, stopped, audio, pcm } from './helpers.js';

const join = (a) => a.h.onJoin(true, 'OK');

test('start -> join -> normalized per-participant audio with source id, epoch, provenance', () => {
  const { mgr, ad, items } = setup();
  assert.equal(mgr.onWebhook(started()).reason, 'started');
  const a = ad.last(); join(a); audio(a, 1000); audio(a, 1020, 20, 8);
  const au = items.filter((i) => i.kind === 'audio');
  assert.equal(au.length, 2);
  assert.notEqual(au[0].source_id, au[1].source_id);
  assert.equal(au[0].source_epoch, 1);
  assert.deepEqual(au[0].format, { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 });
  assert.equal(au[0].provenance.personal_screen_capture, false);
});

test('out-of-order: stopped before started -> started ignored, no connection', () => {
  const { mgr, ad } = setup();
  assert.equal(mgr.onWebhook(stopped()).reason, 'stop_without_session');
  assert.equal(mgr.onWebhook(started()).reason, 'out_of_order_after_stop');
  assert.equal(ad.made.length, 0);
});

test('duplicate started is idempotent', () => {
  const { mgr, ad } = setup();
  mgr.onWebhook(started()); assert.equal(mgr.onWebhook(started()).reason, 'duplicate'); assert.equal(ad.made.length, 1);
});

test('started without media: alert + dead-letter, session stays up', () => {
  const { mgr, ad, clock, dl, items } = setup();
  mgr.onWebhook(started()); join(ad.last()); clock.advance(21_000);
  assert.equal(dl.count('started_without_media'), 1);
  assert.ok(items.some((i) => i.status === 'no_media'));
  assert.equal(mgr.active().length, 1);
});

test('lost socket: reconnect with backoff, epoch++ , continuity reset (no false gap)', () => {
  const { mgr, ad, clock, items } = setup();
  mgr.onWebhook(started()); join(ad.last()); audio(ad.last(), 1000);
  ad.last().h.onLeave('DATA_CONNECTION_INTERRUPTED');
  assert.equal(ad.made.length, 1);
  clock.advance(5_000);
  assert.equal(ad.made.length, 2);
  const b = ad.last(); join(b); audio(b, 9000);
  const last = items.filter((i) => i.kind === 'audio').at(-1);
  assert.equal(last.source_epoch, 2);
  assert.equal(items.filter((i) => i.kind === 'gap').length, 0);
  assert.ok(items.some((i) => i.status === 'reconnecting'));
});

test('host STOP / app disabled / meeting ended are terminal: never reconnect', () => {
  for (const reason of ['HOST_TRIGGERED', 'HOST_DISABLED_APP', 'ADMIN_DISABLED_APP', 'MEETING_ENDED', 'USER_EJECTED', 'ALL_APPS_DISABLED']) {
    const { mgr, ad, clock, items } = setup();
    mgr.onWebhook(started()); join(ad.last()); ad.last().h.onLeave(reason);
    clock.advance(120_000);
    assert.equal(ad.made.length, 1, reason);
    assert.ok(items.some((i) => i.status === 'stopped' && i.reason === reason));
    assert.equal(mgr.onWebhook(started()).reason, 'out_of_order_after_stop'); // late/duplicate start cannot revive it
  }
});

test('authentication failure is fatal, not retried', () => {
  const { mgr, ad, clock, dl } = setup();
  mgr.onWebhook(started()); join(ad.last()); ad.last().h.onLeave('AUTHENTICATION_FAILURE'); clock.advance(120_000);
  assert.equal(ad.made.length, 1); assert.equal(dl.count('fatal_leave'), 1);
});

test('webhook rtms_stopped leaves and cancels pending reconnect', () => {
  const { mgr, ad, clock } = setup();
  mgr.onWebhook(started()); join(ad.last()); ad.last().h.onLeave('DATA_CONNECTION_INTERRUPTED');
  mgr.onWebhook(stopped()); clock.advance(120_000);
  assert.equal(ad.made.length, 1);
});

test('reconnect attempts are bounded -> dead-letter', () => {
  const { mgr, ad, clock, dl } = setup({ maxReconnect: 3 });
  mgr.onWebhook(started());
  for (let i = 0; i < 10; i++) { const a = ad.last(); if (a.h) a.h.onLeave('CONNECTION_TIMEOUT'); clock.advance(60_000); }
  assert.equal(ad.made.length, 4); // 1 + 3 retries
  assert.equal(dl.count('reconnect_exhausted'), 1);
});

test('join refused / join timeout -> retry path', () => {
  const { mgr, ad, clock } = setup();
  mgr.onWebhook(started()); clock.advance(16_000); // join timeout
  clock.advance(5_000);
  assert.equal(ad.made.length, 2);
});

test('liveness: silent stream after media triggers reconnect', () => {
  const { mgr, ad, clock } = setup();
  mgr.onWebhook(started()); join(ad.last()); audio(ad.last(), 1000);
  clock.advance(31_000); clock.advance(5_000);
  assert.equal(ad.made.length, 2);
});

test('incompatible formats are dead-lettered, never emitted', () => {
  const { mgr, ad, items, dl } = setup();
  mgr.onWebhook(started()); const a = ad.last(); join(a);
  a.h.onAudio(Buffer.alloc(33), 33, 1000, { userId: 7 });          // odd byte count (not s16)
  a.h.onAudio(pcm(20), 10, 1000, { userId: 7 });                    // size mismatch
  a.h.onAudio(pcm(20), 640, 1000, {});                              // no source id
  a.h.onAudio(Buffer.alloc(0), 0, 1000, { userId: 7 });
  a.h.onTranscript(Buffer.from([0xff, 0xfe, 0xfd]), 3, 1, { userId: 7 }); // invalid utf8
  assert.equal(items.filter((i) => ['audio', 'transcript'].includes(i.kind)).length, 0);
  assert.equal(dl.count('audio_incompatible_format'), 1);
  assert.equal(dl.count('audio_size_mismatch'), 1);
  assert.equal(dl.count('audio_no_source_id'), 1);
  assert.equal(dl.count('transcript_bad_encoding'), 1);
});

test('gap and out-of-order tracing per source', () => {
  const { mgr, ad, items, dl } = setup();
  mgr.onWebhook(started()); const a = ad.last(); join(a);
  audio(a, 1000); audio(a, 1020);    // contiguous
  audio(a, 1500);                    // 460 ms hole
  audio(a, 1100);                    // late packet
  const gaps = items.filter((i) => i.kind === 'gap');
  assert.equal(gaps.length, 1); assert.equal(gaps[0].gap_ms, 460);
  assert.equal(dl.count('out_of_order'), 1);
});

test('transcript normalised; share frames refused unless Zoom announced sharing (no private content)', () => {
  const { mgr, ad, items, dl } = setup();
  mgr.onWebhook(started()); const a = ad.last(); join(a);
  a.h.onTranscript(Buffer.from('bonjour'), 7, 5, { userId: 7 });
  assert.equal(items.find((i) => i.kind === 'transcript').text, 'bonjour');
  a.h.onShare(Buffer.from([1, 2, 3]), 3, 6, { userId: 7 });
  assert.equal(items.filter((i) => i.kind === 'share').length, 0);
  assert.equal(dl.count('unshared_content_rejected'), 1);
  a.h.onSharingEvent('start', 7, 7); a.h.onShare(Buffer.from([1, 2, 3]), 3, 8, { userId: 7 });
  assert.equal(items.filter((i) => i.kind === 'share').length, 1);
  a.h.onSharingEvent('stop', 9); a.h.onShare(Buffer.from([1]), 1, 10, { userId: 7 });
  assert.equal(items.filter((i) => i.kind === 'share').length, 1);
});

test('quota: concurrency limit', () => {
  const { mgr, dl } = setup({ maxConcurrent: 2 });
  mgr.onWebhook(started('s1', 'm1')); mgr.onWebhook(started('s2', 'm2'));
  assert.equal(mgr.onWebhook(started('s3', 'm3')).reason, 'quota_exceeded');
  assert.equal(dl.count('quota_exceeded'), 1);
  mgr.onWebhook(stopped('s1'));
  assert.equal(mgr.onWebhook(started('s4', 'm4')).reason, 'started'); // slot freed
});

test('unassociated meeting is not joined', () => {
  const { mgr, ad, dl } = setup({ authorize: () => false });
  assert.equal(mgr.onWebhook(started()).reason, 'unassociated_meeting');
  assert.equal(ad.made.length, 0); assert.equal(dl.count('unassociated_meeting'), 1);
});

test('malformed started payload dead-lettered', () => {
  const { mgr, dl } = setup();
  assert.equal(mgr.onWebhook({ event: 'meeting.rtms_started', payload: {} }).reason, 'malformed');
  assert.equal(dl.count('malformed_started'), 1);
});

test('stopAll leaves every session and blocks reconnection', () => {
  const { mgr, ad, clock } = setup();
  mgr.onWebhook(started('s1', 'm1')); mgr.onWebhook(started('s2', 'm2'));
  ad.made.forEach((a) => a.h.onJoin(true));
  mgr.stopAll(); clock.advance(60_000);
  assert.deepEqual(ad.made.map((a) => a.left > 0), [true, true]); assert.equal(mgr.active().length, 0);
});

test('events from a superseded connection (old epoch) are ignored', () => {
  const { mgr, ad, clock, items } = setup();
  mgr.onWebhook(started()); const old = ad.last(); join(old); old.h.onLeave('DATA_CONNECTION_INTERRUPTED'); clock.advance(5000);
  audio(old, 5000); // zombie callback from dead socket
  assert.equal(items.filter((i) => i.kind === 'audio').length, 0);
});

test('sink failure does not kill the stream', () => {
  const { mgr, ad, dl } = setup({ sink: () => { throw new Error('disk'); } });
  mgr.onWebhook(started()); join(ad.last()); audio(ad.last(), 1000);
  assert.equal(dl.count('sink_error'), 1); assert.equal(mgr.active().length, 1);
});

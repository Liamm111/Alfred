import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { AddressEngine } from '../src/address/engine.ts';
import { openDb } from '../src/outbox/db.ts';
import { OutboxStore } from '../src/outbox/store.ts';
import { OutboxWorker, WebPushSender } from '../src/outbox/worker.ts';
import { VapidSigner, generateVapidKeys, type PushRequest, type PushTransport } from '../src/outbox/webpush.ts';
import type { InSegment } from '../src/address/types.ts';

const T0 = 1_800_000_000_000;

test('bout en bout : transcription finale → moteur d’interpellation → outbox → push ; mention = rien ; annulation = rétractation visible', async () => {
  const store = new OutboxStore(openDb());
  const ua = createECDH('prime256v1'); ua.generateKeys();
  store.subs.add({ endpoint: 'https://web.push.apple.com/e2e', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } }, T0);
  const posts: PushRequest[] = [];
  const tr: PushTransport = { post: async (r) => { posts.push(r); return { status: 201 }; } };
  const worker = new OutboxWorker({ store, owner: 'e2e', senders: { webpush: new WebPushSender(store, tr, new VapidSigner(generateVapidKeys(), 'mailto:a@b.c')), mac: { send: async () => ({ kind: 'accepted', http: 200 }) } } });
  let now = T0;
  const engine = new AddressEngine({
    user: { id: 'u', first: 'Liam', last: 'Martin', aliases: [] }, roster: [{ id: 'prof', first: 'Prof' }, { id: 'u', first: 'Liam', last: 'Martin' }],
    emit: (e) => { store.enqueue(e, { asker_name: 'Prof Durand' }, now); },
  });
  let k = 0;
  const say = (text: string, dt = 5000) => { now += dt; const i = ++k; engine.onSegment({ segment_id: `s${i}`, utterance_id: `u${i}`, evidence_id: `ev${i}`, start_ms: now, end_ms: now + 2000, text, speaker_id: 'prof', finality: 'final', confidence: 0.95 } satisfies InSegment); };

  say('Liam a dit que la variance diminue.');   // mention
  say('Where is Liam?');                         // mention
  await worker.tick(now);
  assert.equal(posts.length, 0, 'aucune notification pour une mention');

  say('Liam, peux-tu répondre ?');               // appel explicite
  await worker.tick(now);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.headers.Urgency, 'high');

  say('Liam, tu m’entends ?', 3000);             // relance : aucun nouveau push
  await worker.tick(now);
  assert.equal(posts.length, 1);

  say('Non finalement, laisse tomber.', 4000);   // annulation → rétractation
  await worker.tick(now);
  assert.equal(posts.length, 2, 'la rétractation est un push visible supplémentaire');
  assert.deepEqual(store.report('q-1:alert').map((c) => c.status), ['accepted', 'accepted']);
  assert.equal(store.report('q-1:retract').length, 2);
});

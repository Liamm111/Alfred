import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/outbox/db.ts';
import { OutboxStore } from '../src/outbox/store.ts';
import { OutboxWorker, WebPushSender, type ChannelSender } from '../src/outbox/worker.ts';
import { VapidSigner, generateVapidKeys, type PushRequest, type PushResponse, type PushTransport } from '../src/outbox/webpush.ts';
import { MacPermissionDenied, MacSender, wireMacCallbacks, type MacBridge } from '../src/outbox/mac_bridge.ts';
import { validateSubscription } from '../src/outbox/subscriptions.ts';
import { createApi } from '../src/outbox/server.ts';
import type { EngineEvent } from '../src/address/types.ts';

const T0 = 1_800_000_000_000;
let qn = 0;
const alertEv = (level: 'urgent' | 'normal' = 'urgent', q = `q-${++qn}`): EngineEvent => ({
  type: 'alert', question_id: q, level, basis: 'final', evidence_ids: ['ev1'], at_ms: T0,
  decision: { segment_id: 's1', cls: level === 'urgent' ? 'DIRECT_CERTAIN' : 'DIRECT_PROBABLE', score: 0.95, reasons: ['VOCATIVE'], uncertainty: [], evidence_spans: ['Liam, peux-tu répondre'], engine_version: '11.0.0' },
});
const retractEv = (q: string): EngineEvent => ({ type: 'retract', question_id: q, reason: 'CANCELLED', at_ms: T0 });
const subInput = (host = 'web.push.apple.com', path = Math.random().toString(36).slice(2)) => { const e = createECDH('prime256v1'); e.generateKeys(); return { endpoint: `https://${host}/wpush/v2/${path}`, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } }; };

class FakeTransport implements PushTransport {
  posts: PushRequest[] = [];
  script: ((req: PushRequest, n: number) => PushResponse | Promise<PushResponse> | never)[] = [];
  default: PushResponse = { status: 201 };
  byEndpoint = new Map<string, PushResponse>();
  async post(req: PushRequest): Promise<PushResponse> {
    this.posts.push(req);
    const fixed = this.byEndpoint.get(req.endpoint);
    if (fixed) return fixed;
    const f = this.script.shift();
    if (!f) return this.default;
    return f(req, this.posts.length);
  }
}
const vapid = new VapidSigner(generateVapidKeys(), 'mailto:ops@example.org');
function setup(opts: { path?: string; subs?: number; rng?: () => number } = {}) {
  const db = openDb(opts.path ?? ':memory:');
  const store = new OutboxStore(db);
  const tr = new FakeTransport();
  const subIds: string[] = [];
  for (let i = 0; i < (opts.subs ?? 1); i++) subIds.push(store.subs.add(subInput(), T0).id);
  const worker = new OutboxWorker({ store, owner: 'w1', senders: { webpush: new WebPushSender(store, tr, vapid), mac: { send: async () => ({ kind: 'accepted', http: 200 }) } }, rng: opts.rng ?? (() => 1) });
  return { db, store, tr, worker, subIds };
}
const stateOf = (s: OutboxStore, ev: string, ch: string) => s.report(ev).find((c) => c.channel === ch)!;

test('écriture atomique : si une ligne d’outbox échoue, l’événement n’existe pas non plus', () => {
  const { store, db } = setup({ subs: 2 });
  store.injectFailureAfter(1);
  assert.throws(() => store.enqueue(alertEv(), {}, T0), /injected/);
  assert.equal(Number((db.prepare('SELECT COUNT(*) c FROM address_events').get() as { c: number }).c), 0);
  assert.equal(Number((db.prepare('SELECT COUNT(*) c FROM outbox').get() as { c: number }).c), 0);
  store.injectFailureAfter(null);
  assert.ok(store.enqueue(alertEv(), {}, T0));
});

test('idempotence par (address_event_id, canal) : un second enqueue ne crée rien', () => {
  const { store, db, subIds } = setup({ subs: 2 });
  const ev = alertEv('urgent', 'q-idem');
  const a = store.enqueue(ev, {}, T0)!, b = store.enqueue(ev, {}, T0 + 5)!;
  assert.equal(a.created.length, 3); // mac + 2 appareils
  assert.deepEqual(b.created, []); assert.equal(b.existing.length, 3);
  assert.equal(Number((db.prepare('SELECT COUNT(*) c FROM outbox').get() as { c: number }).c), 3);
  assert.ok(a.created.includes(`webpush:${subIds[0]}`));
});

test('email absent en V0 : tout canal hors mac/webpush est refusé', () => {
  const { store } = setup();
  assert.throws(() => store.enqueue(alertEv(), {}, T0, ['email:liam@example.org']), /channel_not_supported_v0/);
});

test('les événements sans notification (trace, relance, confirmed) ne créent rien', () => {
  const { store } = setup();
  assert.equal(store.enqueue({ type: 'closed', question_id: 'q', reason: 'answered_by_user', at_ms: 0 }, {}, T0), null);
  assert.equal(store.enqueue({ type: 'update', question_id: 'q', what: 'relance', relances: 1, decision: alertEv().type === 'alert' ? (alertEv() as Extract<EngineEvent, { type: 'alert' }>).decision : (undefined as never), at_ms: 0 }, {}, T0), null);
});

test('créé / envoyé / accepté / ack appareil / vu : cinq états distincts, HTTP 201 ne prouve que « accepté »', async () => {
  const { store, worker, subIds } = setup();
  const r = store.enqueue(alertEv('urgent', 'q-states'), {}, T0)!;
  const ch = `webpush:${subIds[0]}`;
  assert.equal(stateOf(store, r.address_event_id, ch).proof, 'created');
  await worker.tick(T0 + 10);
  const afterSend = stateOf(store, r.address_event_id, ch);
  assert.equal(afterSend.status, 'accepted');
  assert.deepEqual(Object.keys(afterSend.stages), ['created', 'sent', 'accepted']);
  assert.equal(afterSend.proof, 'accepted');
  assert.equal(afterSend.stages.device_ack, undefined); assert.equal(afterSend.stages.seen, undefined);
  const token = (store.db.prepare('SELECT delivery_token t FROM outbox WHERE channel=?').get(ch) as { t: string }).t;
  assert.ok(store.ack(token, T0 + 2000));
  assert.equal(stateOf(store, r.address_event_id, ch).proof, 'device_ack');
  assert.equal(stateOf(store, r.address_event_id, ch).stages.seen, undefined);
  assert.ok(store.seen(token, T0 + 5000));
  const s = stateOf(store, r.address_event_id, ch);
  assert.equal(s.proof, 'seen'); assert.equal(s.stages.seen, T0 + 5000);
  assert.equal(store.ack('jeton-inconnu', T0), false);
});

test('course : deux workers sur la même base — chaque ligne est envoyée exactement une fois', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-')); const path = join(dir, 'o.sqlite');
  const a = setup({ path, subs: 5 });
  const dbB = openDb(path); const storeB = new OutboxStore(dbB);
  const trB = a.tr; // même transport factice pour compter globalement
  trB.default = { status: 201 };
  const slow: ChannelSender = { send: async (row, now) => { await new Promise((r) => setTimeout(r, 5)); return new WebPushSender(storeB, trB, vapid).send(row, now); } };
  const workerB = new OutboxWorker({ store: storeB, owner: 'w2', senders: { webpush: slow, mac: { send: async () => ({ kind: 'accepted', http: 200 }) } } });
  for (let i = 0; i < 6; i++) a.store.enqueue(alertEv('urgent', `q-race-${i}`), {}, T0);
  const sends: string[] = [];
  const origPost = trB.post.bind(trB); trB.post = async (req) => { sends.push(req.endpoint + '|' + req.headers.Topic); return origPost(req); };
  await Promise.all([a.worker.tick(T0 + 1, 100), workerB.tick(T0 + 1, 100), a.worker.tick(T0 + 1, 100), workerB.tick(T0 + 1, 100)]);
  assert.equal(sends.length, 6 * 5, 'une requête push par (événement, appareil)');
  assert.equal(new Set(sends).size, sends.length, 'aucun doublon');
  assert.equal(Number((a.db.prepare("SELECT COUNT(*) c FROM outbox WHERE status='accepted'").get() as { c: number }).c), 6 * 6);
});

test('crash après envoi mais avant règlement : le bail expire, un autre worker réessaie avec le MÊME Topic (pas de doublon côté service push)', async () => {
  const { store, tr, worker } = setup();
  store.enqueue(alertEv('urgent', 'q-crash'), {}, T0);
  const crashing = new OutboxWorker({ store, owner: 'dead', senders: { webpush: { send: async (row, now) => { await new WebPushSender(store, tr, vapid).send(row, now); throw new Error('crash'); } }, mac: { send: async () => { throw new Error('crash'); } } } });
  await assert.rejects(crashing.tick(T0 + 1));
  assert.equal(await worker.tick(T0 + 2), 0, 'bail encore valide : personne ne reprend');
  await worker.tick(T0 + 31_000);
  const topics = tr.posts.map((p) => p.headers.Topic);
  assert.equal(topics.length, 2); assert.equal(topics[0], topics[1]);
});

test('worker lent : son règlement tardif ne peut pas écraser celui du worker qui a repris la ligne', async () => {
  const { store } = setup();
  store.enqueue(alertEv('urgent', 'q-late'), {}, T0);
  const [slowRow] = store.claim('slow', T0 + 1, { lease_ms: 1000 }).filter((r) => r.channel === 'mac');
  const [fastRow] = store.claim('fast', T0 + 5000).filter((r) => r.channel === 'mac');
  assert.ok(slowRow && fastRow);
  assert.equal(store.settle(fastRow, T0 + 5001, { kind: 'accepted' }), true);
  assert.equal(store.settle(slowRow, T0 + 6000, { kind: 'retry', at: T0 + 9000, error: 'late' }), false);
  assert.equal(stateOf(store, slowRow.address_event_id, 'mac').status, 'accepted');
});

test('429 : Retry-After respecté, pas de réessai avant, succès ensuite', async () => {
  const { store, tr, worker, subIds } = setup();
  store.enqueue(alertEv('urgent', 'q-429'), {}, T0);
  tr.script.push(() => ({ status: 429, retry_after: '30' }));
  await worker.tick(T0 + 1);
  const ch = `webpush:${subIds[0]}`;
  const r1 = store.db.prepare('SELECT status, next_attempt_at n, last_error e FROM outbox WHERE channel=?').get(ch) as { status: string; n: number; e: string };
  assert.equal(r1.status, 'pending'); assert.equal(r1.e, 'rate_limited'); assert.ok(r1.n >= T0 + 1 + 30_000);
  const before = tr.posts.length;
  await worker.tick(T0 + 20_000); assert.equal(tr.posts.length, before);
  await worker.tick(T0 + 31_500);
  assert.equal(tr.posts.length, before + 1);
  assert.equal(stateOf(store, store.db.prepare('SELECT address_event_id a FROM outbox LIMIT 1').get()!.a as string, ch).status, 'accepted');
});

test('429 avec Retry-After au-delà de l’expiration : l’alerte est abandonnée, jamais livrée en retard', async () => {
  const { store, tr, worker, subIds } = setup();
  const r = store.enqueue(alertEv('urgent', 'q-429b'), { ttl_ms: 60_000 }, T0)!;
  tr.script.push(() => ({ status: 429, retry_after: '600' }));
  await worker.tick(T0 + 1);
  const s = stateOf(store, r.address_event_id, `webpush:${subIds[0]}`);
  assert.equal(s.status, 'expired'); assert.match(s.last_error ?? '', /would_expire/);
  const n = tr.posts.length; await worker.tick(T0 + 700_000); assert.equal(tr.posts.length, n);
});

test('5xx / réseau : backoff exponentiel borné, puis mort après max_attempts', async () => {
  const { store, tr, worker, subIds } = setup({ rng: () => 1 });
  const r = store.enqueue(alertEv('urgent', 'q-5xx'), { ttl_ms: 3_600_000 }, T0)!;
  tr.default = { status: 503 };
  const ch = `webpush:${subIds[0]}`;
  let now = T0; const gaps: number[] = [];
  for (let i = 0; i < 8; i++) {
    await worker.tick(now);
    const row = store.db.prepare('SELECT status, next_attempt_at n FROM outbox WHERE channel=?').get(ch) as { status: string; n: number };
    if (row.status === 'dead') break;
    gaps.push(row.n - now); now = row.n;
  }
  assert.deepEqual(gaps, [2000, 4000, 8000, 16000, 32000]);
  const f = stateOf(store, r.address_event_id, ch);
  assert.equal(f.status, 'dead'); assert.equal(f.attempts, 6); assert.match(f.last_error ?? '', /max_attempts/);
  tr.posts.length = 0; await worker.tick(now + 1_000_000); assert.equal(tr.posts.length, 0);
  // erreur réseau (exception du transport) traitée comme transitoire
  const x = setup(); x.store.enqueue(alertEv(), {}, T0); x.tr.script.push(() => { throw new Error('ECONNRESET'); });
  await x.worker.tick(T0); assert.equal((x.store.db.prepare("SELECT status FROM outbox WHERE channel LIKE 'webpush:%'").get() as { status: string }).status, 'pending');
});

test('410 et 404 : souscription expirée et purgée, ligne morte, les autres appareils et le Mac sont servis', async () => {
  for (const code of [410, 404]) {
    const { store, tr, worker, subIds } = setup({ subs: 2 });
    const r = store.enqueue(alertEv('urgent', `q-gone-${code}`), {}, T0)!;
    tr.byEndpoint.set(store.subs.get(subIds[0]!)!.endpoint, { status: code });
    await worker.tick(T0 + 1);
    const rep = store.report(r.address_event_id);
    assert.equal(rep.find((c) => c.channel === `webpush:${subIds[0]}`)!.status, 'dead');
    assert.equal(rep.find((c) => c.channel === `webpush:${subIds[1]}`)!.status, 'accepted');
    assert.equal(rep.find((c) => c.channel === 'mac')!.status, 'accepted');
    assert.equal(store.subs.get(subIds[0]!)!.status, 'expired');
    const next = store.enqueue(alertEv('urgent', `q-after-${code}`), {}, T0 + 10)!;
    assert.ok(!next.created.includes(`webpush:${subIds[0]}`), 'plus d’envoi vers une souscription morte');
    assert.equal(store.subs.purgeExpired(T0 + 8 * 86_400_000), 1);
    assert.equal(store.subs.get(subIds[0]!), undefined);
  }
});

test('souscription à expirationTime dépassé : écartée avant envoi (aucun appel réseau)', async () => {
  const { store, tr, worker } = setup({ subs: 0 });
  const s = store.subs.add({ ...subInput(), expirationTime: T0 + 1000 }, T0);
  const r = store.enqueue(alertEv('urgent', 'q-exp'), {}, T0 + 500)!; // encore valide à l'enqueue
  await worker.tick(T0 + 2000);
  assert.equal(tr.posts.length, 0);
  assert.equal(stateOf(store, r.address_event_id, `webpush:${s.id}`).status, 'dead');
  assert.equal(store.subs.purgeExpired(T0 + 3000, 0), 1);
});

test('401/403 : pas de réessai ; à 3 échecs la souscription est rejetée', async () => {
  const { store, tr, worker, subIds } = setup({ subs: 1 });
  tr.default = { status: 403 };
  for (let i = 0; i < 3; i++) { store.enqueue(alertEv('urgent', `q-403-${i}`), {}, T0 + i * 1000); await worker.tick(T0 + i * 1000 + 1); }
  assert.equal(tr.posts.length, 3);
  assert.equal(store.subs.get(subIds[0]!)!.status, 'rejected');
  store.enqueue(alertEv('urgent', 'q-403-x'), {}, T0 + 10_000); await worker.tick(T0 + 10_001);
  assert.equal(tr.posts.length, 3, 'plus aucun envoi vers une souscription rejetée');
});

test('TTL : une alerte périmée n’est jamais envoyée', async () => {
  const { store, tr, worker } = setup();
  const r = store.enqueue(alertEv('urgent', 'q-ttl'), { ttl_ms: 60_000 }, T0)!;
  await worker.tick(T0 + 61_000);
  assert.equal(tr.posts.length, 0);
  assert.ok(store.report(r.address_event_id).every((c) => c.status === 'expired' && c.proof === 'created'));
});

test('rétractation : annule les envois en attente ; après livraison, part comme notification VISIBLE de même tag', async () => {
  const a = setup(); a.store.enqueue(alertEv('urgent', 'q-ret'), {}, T0);
  a.store.enqueue(retractEv('q-ret'), {}, T0 + 100);
  await a.worker.tick(T0 + 200);
  const reps = a.store.report('q-ret:alert');
  assert.ok(reps.every((c) => c.status === 'cancelled'));
  assert.equal(a.tr.posts.length, 1, 'seule la rétractation part'); // 1 appareil
  const b = setup(); b.store.enqueue(alertEv('urgent', 'q-ret2'), {}, T0); await b.worker.tick(T0 + 1);
  const rr = b.store.enqueue(retractEv('q-ret2'), {}, T0 + 5000)!;
  await b.worker.tick(T0 + 5001);
  const p = JSON.parse((b.store.db.prepare('SELECT payload FROM address_events WHERE address_event_id=?').get(rr.address_event_id) as { payload: string }).payload);
  assert.equal(p.tag, 'q-ret2'); assert.equal(p.kind, 'retract'); assert.ok(p.title.length > 0 && p.body.length > 0, 'iOS exige une notification visible pour chaque push');
});

test('écran verrouillé / Focus iOS (SIMULATION) : 201 sans ack → « non confirmé », jamais « délivré » ; ack tardif lève le doute', async () => {
  const { store, worker, subIds } = setup();
  const r = store.enqueue(alertEv('urgent', 'q-focus'), {}, T0)!;
  await worker.tick(T0 + 1);
  assert.deepEqual(store.sweepUnconfirmed(T0 + 30_000, 45_000), [], 'avant le délai : rien');
  const un = store.sweepUnconfirmed(T0 + 60_000, 45_000);
  assert.equal(un.length, 1); assert.equal(un[0]!.channel, `webpush:${subIds[0]}`);
  const c = stateOf(store, r.address_event_id, `webpush:${subIds[0]}`);
  assert.equal(c.proof, 'accepted'); assert.equal(c.unconfirmed, true);
  assert.deepEqual(store.sweepUnconfirmed(T0 + 120_000, 45_000), [], 'signalé une seule fois');
  const tok = (store.db.prepare('SELECT delivery_token t FROM outbox WHERE channel=?').get(`webpush:${subIds[0]}`) as { t: string }).t;
  store.ack(tok, T0 + 200_000);
  assert.equal(stateOf(store, r.address_event_id, `webpush:${subIds[0]}`).unconfirmed, false);
});

test('canal Mac : accepté ≠ vu ; permission refusée → mort sans réessai ; app injoignable → réessai', async () => {
  const added: string[] = [];
  const ok: MacBridge = { notify: async (n) => { added.push(n.token); return 'added'; } };
  const { store } = setup({ subs: 0 });
  const w = new OutboxWorker({ store, owner: 'm', senders: { mac: new MacSender(ok) }, rng: () => 1 });
  const r = store.enqueue(alertEv('urgent', 'q-mac'), {}, T0)!;
  await w.tick(T0 + 1);
  assert.equal(stateOf(store, r.address_event_id, 'mac').proof, 'accepted');
  const cb = wireMacCallbacks(store, () => T0 + 3000);
  cb.delivered(added[0]!); assert.equal(stateOf(store, r.address_event_id, 'mac').proof, 'device_ack');
  cb.clicked(added[0]!); assert.equal(stateOf(store, r.address_event_id, 'mac').proof, 'seen');
  const denied = setup({ subs: 0 });
  const w2 = new OutboxWorker({ store: denied.store, owner: 'm', senders: { mac: new MacSender({ notify: async () => { throw new MacPermissionDenied('refusée'); } }) } });
  denied.store.enqueue(alertEv('urgent', 'q-d'), {}, T0); await w2.tick(T0 + 1);
  assert.equal(stateOf(denied.store, 'q-d:alert', 'mac').status, 'dead');
  const down = setup({ subs: 0 });
  const w3 = new OutboxWorker({ store: down.store, owner: 'm', senders: { mac: new MacSender({ notify: async () => { throw new Error('helper injoignable'); } }) }, rng: () => 1 });
  down.store.enqueue(alertEv('urgent', 'q-u'), {}, T0); await w3.tick(T0 + 1);
  assert.equal(stateOf(down.store, 'q-u:alert', 'mac').status, 'pending');
});

test('confidentialité de l’aperçu : par défaut ni texte ni extrait dans la notification ; « full » seulement sur demande', async () => {
  const { store } = setup({ subs: 0 });
  store.enqueue(alertEv('urgent', 'q-p1'), { asker_name: 'Prof Durand' }, T0);
  store.enqueue(alertEv('urgent', 'q-p2'), { asker_name: 'Prof Durand', preview: 'full' }, T0);
  store.enqueue(alertEv('urgent', 'q-p3'), { preview: 'none' }, T0);
  const body = (id: string) => JSON.parse((store.db.prepare('SELECT payload FROM address_events WHERE address_event_id=?').get(id) as { payload: string }).payload).body as string;
  assert.equal(body('q-p1:alert'), "Prof Durand s'adresse à vous");
  assert.match(body('q-p2:alert'), /peux-tu répondre/);
  assert.equal(body('q-p3:alert'), 'Ouvrez pour voir');
});

test('validation des souscriptions : http, hôtes hors liste (SSRF), clés invalides refusés', () => {
  const good = subInput();
  assert.deepEqual(validateSubscription(good), []);
  for (const host of ['evil.example.com', '127.0.0.1', 'localhost', 'web.push.apple.com.evil.com']) assert.ok(validateSubscription(subInput(host)).length > 0, host);
  assert.ok(validateSubscription({ ...good, endpoint: good.endpoint.replace('https', 'http') }).length > 0);
  assert.ok(validateSubscription({ ...good, keys: { ...good.keys, auth: 'court' } }).length > 0);
  assert.ok(validateSubscription({ ...good, keys: { ...good.keys, p256dh: 'AAAA' } }).length > 0);
  assert.ok(validateSubscription(subInput('fcm.googleapis.com')).length === 0 && validateSubscription(subInput('updates.push.services.mozilla.com')).length === 0);
});

test('API PWA : appairage requis pour s’abonner ; ack/seen par jeton de livraison ; corps trop gros refusé', async () => {
  const { store, worker } = setup({ subs: 0 });
  const server = createApi({ store, vapidPublicKey: 'PUB', pairingToken: 'secret-pairing', now: () => T0 + 1 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await (await fetch(`${base}/api/vapid-public-key`)).json() as { key: string }).key, 'PUB');
    const sub = subInput();
    assert.equal((await fetch(`${base}/api/subscribe`, { method: 'POST', body: JSON.stringify({ subscription: sub }) })).status, 401);
    assert.equal((await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { authorization: 'Bearer faux' }, body: JSON.stringify({ subscription: sub }) })).status, 401);
    const ok = await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { authorization: 'Bearer secret-pairing' }, body: JSON.stringify({ subscription: sub }) });
    assert.equal(ok.status, 201);
    assert.equal((await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { authorization: 'Bearer secret-pairing' }, body: JSON.stringify({ subscription: subInput('evil.example.com') }) })).status, 422);
    assert.equal((await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { authorization: 'Bearer secret-pairing' }, body: 'x'.repeat(20_000) })).status, 413);
    store.enqueue(alertEv('urgent', 'q-api'), {}, T0);
    await worker.tick(T0);
    const tok = (store.db.prepare("SELECT delivery_token t FROM outbox WHERE channel LIKE 'webpush:%'").get() as { t: string }).t;
    assert.equal((await fetch(`${base}/api/ack`, { method: 'POST', body: JSON.stringify({ token: 'nope' }) })).status, 404);
    assert.equal((await fetch(`${base}/api/ack`, { method: 'POST', body: JSON.stringify({ token: tok }) })).status, 200);
    assert.equal(store.report('q-api:alert').find((c) => c.channel.startsWith('webpush'))!.proof, 'device_ack');
    assert.equal((await fetch(`${base}/api/seen`, { method: 'POST', body: JSON.stringify({ token: tok }) })).status, 200);
    assert.equal(store.report('q-api:alert').find((c) => c.channel.startsWith('webpush'))!.proof, 'seen');
  } finally { server.close(); }
});

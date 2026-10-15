import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockModel } from '../src/merge/timebase.ts';
import { SourceNormalizer, type RawEvent } from '../src/merge/normalizer.ts';
import { MergeHub, MeetingMerger } from '../src/merge/merge.ts';
import { ReplayBuffer } from '../src/merge/replay.ts';
import { similarity } from '../src/merge/text.ts';
import type { NormalizedEvidence } from '../src/contracts/evidence.ts';

const T0 = 1_800_000_000_000;
const synced = (offset = 0) => { const c = new ClockModel(); c.addSample({ local_send_ms: 1000, server_ms: 1000 + offset + 20, local_recv_ms: 1040 }); return c; };
const rtms = (m = 'M1', clock = synced(), id = 'rtms-1') => new SourceNormalizer({ meeting_id: m, source_id: id, kind: 'rtms', attested: true, clock });
const mac = (m = 'M1', clock = synced(), id = 'mac-1') => new SourceNormalizer({ meeting_id: m, source_id: id, kind: 'mac_local', clock });
const tr = (s: number, e: number, text: string, extra: Partial<RawEvent> = {}): RawEvent => ({ modality: 'transcript', local_start_ms: T0 + s, local_end_ms: T0 + e, local_now_ms: T0 + e + 300, text, ...extra });

test('similarité tolère petites divergences STT mais pas des phrases différentes', () => {
  assert.ok(similarity('Liam, peux-tu expliquer ?', 'Liam peux tu expliquer') > 0.85);
  assert.ok(similarity('Liam peux-tu expliquer', 'Passons à la diapositive suivante') < 0.4);
});

test('RTMS préféré : le même énoncé vu par RTMS et Mac n’apparaît qu’une fois, le fallback est tracé', () => {
  const m = new MeetingMerger('M1'); const r = rtms(), l = mac();
  m.ingest(r.normalize(tr(10_000, 12_000, 'Liam, peux-tu expliquer ?', { speaker_id: 'u-prof' })));
  m.ingest(l.normalize(tr(10_150, 12_200, 'Liam peux tu expliquer')));
  m.ingest(l.normalize(tr(20_000, 22_000, 'Phrase captée seulement en local')));
  const t = m.timeline();
  assert.equal(t.length, 2);
  assert.equal(t[0]!.source.kind, 'rtms');
  assert.equal(t[1]!.source.kind, 'mac_local');
  assert.ok(t[1]!.flags.includes('fallback_local'));
  assert.deepEqual(m.suppressed.map((s) => s.reason), ['duplicate']);
});

test('doublons : speakers vérifiés différents ou répétition tardive ne sont PAS fusionnés', () => {
  const m = new MeetingMerger('M1'); const a = rtms();
  const b = new SourceNormalizer({ meeting_id: 'M1', source_id: 'rtms-2', kind: 'rtms', attested: false, clock: synced() });
  m.ingest(a.normalize(tr(1000, 1800, 'oui', { speaker_id: 'alice' })));
  m.ingest(b.normalize(tr(1050, 1850, 'oui', { speaker_id: 'bob' })));
  assert.equal(m.timeline().length, 2);
  const l = mac();
  m.ingest(l.normalize(tr(31_000, 31_800, 'oui')));
  assert.equal(m.timeline().length, 3, 'même mot 30 s plus tard = autre énoncé');
});

test('doublons audio similaires : fort recouvrement fusionné, faible recouvrement conservé', () => {
  const m = new MeetingMerger('M1'); const r = rtms(), l = mac();
  m.ingest(r.normalize({ modality: 'audio', local_start_ms: T0, local_end_ms: T0 + 1000, local_now_ms: T0 + 1100 }));
  m.ingest(l.normalize({ modality: 'audio', local_start_ms: T0 + 50, local_end_ms: T0 + 1000, local_now_ms: T0 + 1100 }));
  m.ingest(l.normalize({ modality: 'audio', local_start_ms: T0 + 1500, local_end_ms: T0 + 2500, local_now_ms: T0 + 2600 }));
  m.ingest(r.normalize({ modality: 'audio', local_start_ms: T0 + 2000, local_end_ms: T0 + 3000, local_now_ms: T0 + 3100 }));
  assert.equal(m.timeline().length, 3); // 1 doublon retiré ; chevauchement 50 % (<80 %) conservé
});

test('dérive +1 min, horloge Mac jamais synchronisée : quarantaine, aucun doublon, puis rebase après sync', () => {
  const m = new MeetingMerger('M1');
  const r = rtms();
  const unsynced = new ClockModel(); // la vraie horloge Mac avance de 60 s mais le modèle l'ignore
  const l = mac('M1', unsynced);
  const fast = (e: RawEvent): RawEvent => ({ ...e, local_start_ms: e.local_start_ms + 60_000, local_end_ms: e.local_end_ms + 60_000, local_now_ms: e.local_now_ms + 60_000 });
  m.ingest(r.normalize(tr(5000, 7000, 'Le théorème de Bayes relie les probabilités conditionnelles', { speaker_id: 'prof' })));
  const res = m.ingest(l.normalize(fast(tr(5100, 7100, 'Le théorème de Bayes relie les probabilités conditionnelles'))));
  assert.ok(res.ok && res.status === 'quarantined');
  assert.equal(m.timeline().length, 1);
  assert.equal(m.quarantined.length, 1);
  const w = m.window(T0, T0 + 20_000);
  assert.equal(w.complete, false, 'contenu en quarantaine → fenêtre déclarée incomplète');
  // la sync arrive : offset réel = -60 000 ms
  assert.equal(m.rebaseSource('mac-1', 1, -60_000), 1);
  assert.equal(m.quarantined.length, 0);
  assert.equal(m.timeline().length, 1);
  assert.equal(m.suppressed.length, 1);
});

test('dérive +1 min avec horloge « synchronisée » à tort : détectée car en avance sur la tête RTMS attestée', () => {
  const m = new MeetingMerger('M1', {}, { trusted_now_ms: () => T0 + 45_000 }); const r = rtms(), l = mac();
  for (let i = 0; i < 5; i++) m.ingest(r.normalize(tr(i * 10_000, i * 10_000 + 3000, `phrase numéro ${i} du cours`, { speaker_id: 'prof' })));
  const res = m.ingest(l.normalize(tr(60_000, 63_000, 'phrase numéro 1 du cours')));
  assert.ok(res.ok && res.status === 'quarantined');
  assert.equal(m.timeline().length, 5);
});

test('dérive −1 min (non détectable par l’horloge) : détectée par appariement de texte puis corrigée', () => {
  const m = new MeetingMerger('M1'); const r = rtms(), l = mac();
  const lines = ['introduction aux chaînes de Markov', 'la matrice de transition est stochastique', 'les états récurrents reviennent presque sûrement', 'exemple avec trois états absorbants'];
  lines.forEach((t, i) => { m.ingest(r.normalize(tr(i * 20_000, i * 20_000 + 4000, t, { speaker_id: 'prof' }))); m.ingest(l.normalize(tr(i * 20_000 - 60_000, i * 20_000 + 4000 - 60_000, t))); });
  assert.equal(m.timeline().length, 8, 'avant correction: doublons décalés visibles');
  const d = m.detectDrift();
  assert.equal(d.length, 1);
  assert.ok(Math.abs(d[0]!.median_delta_ms + 60_000) < 1000);
  m.rebaseSource(d[0]!.source_id, d[0]!.source_epoch, -d[0]!.median_delta_ms);
  assert.equal(m.timeline().length, 4);
});

test('source reconnectée : seq repart, ids restent uniques, le trou est tracé (pas masqué)', () => {
  const m = new MeetingMerger('M1'); const r = rtms();
  m.ingest(r.normalize(tr(0, 4000, 'avant la coupure', { speaker_id: 'prof' })));
  r.reconnect();
  const e2 = r.normalize(tr(14_000, 17_000, 'après la reconnexion', { speaker_id: 'prof' }));
  assert.equal(e2.seq, 1); assert.equal(e2.source.source_epoch, 2);
  m.ingest(e2);
  const g = m.gaps();
  assert.equal(g.open.length, 1);
  assert.equal(g.open[0]!.reason, 'reconnect');
  assert.equal(g.open[0]!.utc_end_ms - g.open[0]!.utc_start_ms, 10_000);
  // retransmission de la même evidence : idempotent
  assert.equal((m.ingest(e2) as { status: string }).status, 'idempotent');
  assert.equal(m.timeline().length, 2);
});

test('fallback local qui comble partiellement un trou RTMS : reste du trou toujours ouvert', () => {
  const m = new MeetingMerger('M1'); const r = rtms(), l = mac();
  m.ingest(r.normalize(tr(0, 10_000, 'bloc avant la panne', { speaker_id: 'prof' })));
  r.reconnect();
  m.ingest(r.normalize(tr(20_000, 24_000, 'bloc après la panne', { speaker_id: 'prof' })));
  m.ingest(l.normalize(tr(14_000, 18_000, 'ce que le Mac a entendu pendant la panne')));
  const g = m.gaps();
  assert.deepEqual(g.open.map((x) => [x.utc_start_ms - T0, x.utc_end_ms - T0]), [[10_000, 14_000], [18_000, 20_000]]);
  assert.equal(g.filled.length, 1);
});

test('changement de source au milieu d’une question : fenêtre continue, bascule signalée, trou signalé, aucun doublon', () => {
  const m = new MeetingMerger('M1', {}, { trusted_now_ms: () => T0 + 10_000 }); const r = rtms(), l = mac();
  m.ingest(r.normalize(tr(0, 3000, 'Liam, tu peux nous expliquer', { speaker_id: 'prof' })));
  m.ingest(r.normalize(tr(3000, 5000, 'pourquoi la variance', { speaker_id: 'prof' })));
  m.setRtmsStatus('unavailable'); // coupure technique (pas une interdiction)
  m.reportGap({ meeting_id: 'M1', modality: 'transcript', source_id: 'rtms-1', source_epoch: 1, utc_start_ms: T0 + 5000, utc_end_ms: T0 + 8000, reason: 'source_down' });
  m.ingest(l.normalize(tr(4800, 5400, 'pourquoi la variance')));       // recouvre la fin de RTMS → doublon
  m.ingest(l.normalize(tr(6500, 9000, 'diminue quand n augmente ?'))); // seul le Mac l'a entendu
  const w = m.window(T0, T0 + 10_000);
  assert.deepEqual(w.items.map((e) => e.text), ['Liam, tu peux nous expliquer', 'pourquoi la variance', 'diminue quand n augmente ?']);
  assert.equal(w.source_switches.length, 1);
  assert.deepEqual([w.source_switches[0]!.from_source, w.source_switches[0]!.to_source], ['rtms-1', 'mac-1']);
  assert.equal(w.complete, false);
  assert.deepEqual(w.open_gaps.map((x) => [x.utc_start_ms - T0, x.utc_end_ms - T0]), [[5000, 6500]]);
  assert.equal(w.items[2]!.speaker.status, 'unknown', 'aucun speaker inventé pour le fallback local');
});

test('deux réunions : jamais fusionnées (meeting_id, source liée, merger séparé)', () => {
  const hub = new MergeHub();
  const rA = rtms('A', synced(), 'rtms-A'), lA = mac('A'), rB = rtms('B', synced(), 'rtms-B');
  assert.ok(hub.ingest(rA.normalize(tr(0, 2000, 'réunion A', { speaker_id: 'x' }))).ok);
  assert.ok(hub.ingest(lA.normalize(tr(0, 2000, 'réunion A'))).ok);
  // la source mac-1 (liée à A) émet soudain une evidence marquée B
  const sneaky = mac('B', synced(), 'mac-1').normalize(tr(0, 2000, 'réunion B'));
  const r = hub.ingest(sneaky);
  assert.ok(!r.ok && r.reason === 'source_bound_elsewhere');
  assert.ok(hub.ingest(rB.normalize(tr(0, 2000, 'réunion B', { speaker_id: 'y' }))).ok);
  assert.deepEqual(hub.merger('A').timeline().map((e) => e.text), ['réunion A']);
  assert.deepEqual(hub.merger('B').timeline().map((e) => e.text), ['réunion B']);
  // un merger de A refuse directement une evidence de B
  const direct = hub.merger('A').ingest(rB.normalize(tr(5000, 6000, 'fuite')));
  assert.ok(!direct.ok && direct.reason === 'wrong_meeting');
  // même Zoom meeting « récurrent » : l'identifiant d'instance différencie
  assert.equal(hub.merger('A').timeline().length, 1);
});

test('interdiction explicite : pas de bascule fallback ; trou « policy_blocked » jamais présenté comme comblé', () => {
  const m = new MeetingMerger('M1'); const l = mac();
  m.setRtmsStatus('denied_by_policy');
  const res = m.ingest(l.normalize(tr(0, 2000, 'ne devrait pas être capturé')));
  assert.ok(!res.ok && res.reason === 'rtms_denied_no_fallback');
  assert.equal(m.timeline().length, 0);
  assert.ok(m.gaps().open.every((g) => g.reason === 'policy_blocked'));
  const m2 = new MeetingMerger('M2'); m2.setPolicy({ capture_allowed: false, reason: 'interdiction enseignant' });
  const r2 = m2.ingest(rtms('M2').normalize(tr(0, 2000, 'x', { speaker_id: 'p' })));
  assert.ok(!r2.ok && r2.reason === 'policy_blocked');
  // panne technique ≠ interdiction : le fallback est alors autorisé
  const m3 = new MeetingMerger('M3'); m3.setRtmsStatus('unavailable');
  assert.ok(m3.ingest(mac('M3').normalize(tr(0, 2000, 'ok fallback'))).ok);
});

test('provisoire recouvert par le final de la même source : un seul texte', () => {
  const m = new MeetingMerger('M1'); const r = rtms();
  m.ingest(r.normalize(tr(0, 1500, 'Liam peux', { speaker_id: 'p', finality: 'provisional' })));
  m.ingest(r.normalize(tr(0, 2500, 'Liam, peux-tu répondre ?', { speaker_id: 'p', finality: 'final' })));
  assert.deepEqual(m.timeline().map((e) => e.finality), ['final']);
});

test('ordre canonique déterministe : mêmes données, ordre d’arrivée mélangé → même timeline', () => {
  const r = rtms(), l = mac(); const evs: NormalizedEvidence[] = [];
  for (let i = 0; i < 40; i++) { evs.push(r.normalize(tr(i * 5000, i * 5000 + 3000, `énoncé ${i} sur les martingales`, { speaker_id: 'p' }))); if (i % 3 === 0) evs.push(l.normalize(tr(i * 5000 + 100, i * 5000 + 3100, `énoncé ${i} sur les martingales`))); }
  const ref = new MeetingMerger('M1'); evs.forEach((e) => ref.ingest(e));
  let seed = 42; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let k = 0; k < 5; k++) {
    const sh = [...evs].sort(() => rnd() - 0.5); const m = new MeetingMerger('M1'); sh.forEach((e) => m.ingest(e));
    assert.deepEqual(m.timeline().map((e) => e.evidence_id), ref.timeline().map((e) => e.evidence_id));
  }
});

test('cache/replay borné : débordement tracé, isolation par réunion, reprise partielle idempotente', () => {
  const buf = new ReplayBuffer({ max_items: 5, max_bytes: 1_000_000 });
  const l = mac('A');
  for (let i = 0; i < 8; i++) buf.push(l.normalize(tr(i * 1000, i * 1000 + 500, `segment ${i}`)));
  buf.push(mac('B', synced(), 'mac-b').normalize(tr(100_000, 100_500, 'autre réunion')));
  assert.ok(buf.count() <= 5);
  assert.ok(buf.droppedGaps.length >= 4 && buf.droppedGaps.every((g) => g.reason === 'dropped_by_buffer'));
  const m = new MeetingMerger('A'); let n = 0;
  const flaky = (e: NormalizedEvidence) => { if (n++ >= 2) return false; return m.ingest(e).ok; };
  const first = buf.drain('A', flaky);
  assert.equal(first.delivered, 2);
  assert.ok(first.remaining > 0);
  const second = buf.drain('A', (e) => m.ingest(e).ok);
  assert.equal(second.remaining, 0);
  assert.ok(m.timeline().every((e) => e.meeting_id === 'A'));
  assert.equal(buf.count('B'), 1, 'la réunion B n’a pas été rejouée dans A');
  // double livraison (retry après timeout) : idempotent
  assert.equal(new Set(m.timeline().map((e) => e.evidence_id)).size, m.timeline().length);
});

test('borne en octets', () => {
  const buf = new ReplayBuffer({ max_items: 1000, max_bytes: 2000 });
  const l = mac('A');
  for (let i = 0; i < 30; i++) buf.push(l.normalize(tr(i * 1000, i * 1000 + 500, 'x'.repeat(50))));
  assert.ok(buf.bytes() <= 2000);
  assert.ok(buf.droppedGaps.length > 0);
});

test('perf 3 h : 2 sources × ~3 600 énoncés fusionnés < 5 s', () => {
  const r = rtms(), l = mac(); const m = new MeetingMerger('M1');
  const t0 = Date.now();
  for (let i = 0; i < 3600; i++) {
    m.ingest(r.normalize(tr(i * 3000, i * 3000 + 2500, `énoncé numéro ${i} du cours de probabilités`, { speaker_id: 'p' })));
    m.ingest(l.normalize(tr(i * 3000 + 80, i * 3000 + 2580, `énoncé numéro ${i} du cours de probabilites`)));
  }
  assert.equal(m.timeline().length, 3600);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

import { MediaTimebase } from '../src/merge/timebase.ts';
test('timebase média : offsets UTC et temps média cohérents, horloge source corrigée', () => {
  const l = mac('M1', synced(-2500)); // horloge Mac en retard de 2,5 s
  l.media = new MediaTimebase(T0);
  const e = l.normalize(tr(10_000, 12_000, 'x'));
  assert.equal(e.clock_offset_ms, -2500);
  assert.equal(e.utc_start_ms, T0 + 7_500);
  assert.equal(e.media_start_ms, 7_500);
  assert.equal(new MediaTimebase(T0).toUtc(7_500), T0 + 7_500);
});

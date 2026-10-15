import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressEngine } from '../src/address/engine.ts';
import { buildPrompt, parseVerdict, type LlmAddressClassifier } from '../src/address/llm.ts';
import { FeedbackStore } from '../src/address/feedback.ts';
import { ENGINE_VERSION, type EngineEvent, type InSegment, type Participant, type UserProfile } from '../src/address/types.ts';

const USER: UserProfile = { id: 'u-liam', first: 'Liam', last: 'Martin', aliases: ['Lyam'] };
const ROSTER: Participant[] = [{ id: 'prof', first: 'Prof' }, { id: 'alice', first: 'Alice' }, { id: 'bob', first: 'Bob' }, { id: 'u-liam', first: 'Liam', last: 'Martin' }];
const T = 1_800_000_000_000;
let k = 0;
const seg = (text: string, o: Partial<InSegment> = {}): InSegment => ({ segment_id: `s${++k}`, utterance_id: o.utterance_id ?? `u${k}`, evidence_id: `ev${k}`, start_ms: T + k * 3000, end_ms: T + k * 3000 + 2500, text, speaker_id: 'prof', finality: 'final', confidence: 0.95, ...o });
const mk = (llm?: LlmAddressClassifier, config?: Record<string, number>) => { const ev: EngineEvent[] = []; return { ev, eng: new AddressEngine({ user: USER, roster: ROSTER, emit: (e) => ev.push(e), ...(llm ? { llm } : {}), ...(config ? { config } : {}) }) }; };
const kinds = (ev: EngineEvent[]) => ev.filter((e) => e.type !== 'trace').map((e) => e.type === 'update' ? `update:${e.what}` : e.type);
const verdict = (cls: string, score: number, spans: string[] = []) => ({ cls, score, reason_codes: ['X'], evidence_spans: spans });

test('déclenchement rapide : l’alerte part de façon synchrone, avant toute réponse LLM', async () => {
  let release!: (v: unknown) => void;
  const llm: LlmAddressClassifier = { classify: () => new Promise((r) => { release = r; }) };
  const { ev, eng } = mk(llm);
  eng.onSegment(seg('Liam, peux-tu répondre ?'));
  assert.deepEqual(kinds(ev), ['alert']); // LLM pas encore revenu
  release(verdict('MENTION_SIMPLE', 0.97, [])); await eng.flush();
  assert.deepEqual(kinds(ev), ['alert', 'retract']);
  assert.equal((ev.find((e) => e.type === 'retract') as { reason: string }).reason, 'LLM_DOWNGRADE');
});

test('LLM : abaisser un appel CERTAIN exige ≥ 0,95 ; 0,9 ne retire rien', async () => {
  const { ev, eng } = mk({ classify: async () => verdict('HORS_SUJET', 0.9) });
  eng.onSegment(seg('Liam, peux-tu répondre ?')); await eng.flush();
  assert.deepEqual(kinds(ev), ['alert']);
});

test('LLM en timeout : l’alerte reste, l’incertitude est tracée', async () => {
  const { ev, eng } = mk({ classify: () => new Promise(() => {}) }, { llm_timeout_ms: 20 });
  eng.onSegment(seg('Liam, peux-tu répondre ?')); await eng.flush();
  assert.deepEqual(kinds(ev), ['alert']);
  assert.ok(ev.some((e) => e.type === 'trace' && e.decision.uncertainty.includes('LLM_TIMEOUT')));
});

test('LLM : sortie invalide, champs en trop ou extrait halluciné → ignorée et tracée', async () => {
  for (const bad of ['pas du json', { cls: 'DIRECT_CERTAIN', score: 0.99, reason_codes: [], evidence_spans: ['phrase jamais prononcée'], extra: 1 }, verdict('DIRECT_CERTAIN', 0.99, ['phrase jamais prononcée']), verdict('DIRECT_CERTAIN', 0.99, [])]) {
    const { ev, eng } = mk({ classify: async () => bad });
    eng.onSegment(seg('Peux-tu nous expliquer cela ?')); await eng.flush();
    assert.deepEqual(kinds(ev), [], 'aucune alerte née d’une sortie invalide');
    assert.ok(ev.some((e) => e.type === 'trace' && e.decision.uncertainty.includes('LLM_INVALID')));
  }
});

test('LLM seul peut proposer une sollicitation sans prénom — jamais urgente, extraits vérifiés', async () => {
  const text = 'Celui qui a posé la question tout à l’heure, tu peux préciser ?';
  const { ev, eng } = mk({ classify: async () => verdict('DIRECT_CERTAIN', 0.92, ['tu peux préciser']) });
  eng.onSegment(seg(text)); await eng.flush();
  const a = ev.find((e) => e.type === 'alert') as Extract<EngineEvent, { type: 'alert' }>;
  assert.ok(a); assert.equal(a.level, 'normal'); assert.ok(a.decision.reasons.includes('LLM_ONLY'));
});

test('LLM ne peut pas contourner une annulation détectée par les règles', async () => {
  const { ev, eng } = mk({ classify: async () => verdict('DIRECT_CERTAIN', 0.99, ['Liam']) });
  eng.onSegment(seg('Liam, peux-tu expliquer... non laisse tomber.')); await eng.flush();
  assert.deepEqual(kinds(ev), []);
});

test('LLM peut promouvoir PROBABLE → CERTAIN (mise à jour, pas une 2e alerte)', async () => {
  const { ev, eng } = mk({ classify: async () => verdict('DIRECT_CERTAIN', 0.95, ['Liam, tout va bien']) });
  eng.onSegment(seg('Liam, tout va bien'));
  await eng.flush();
  assert.deepEqual(kinds(ev), ['alert', 'update:upgraded']);
});

test('provisoire : appel explicite alerté tout de suite ; le final confirme sans doubler', () => {
  const { ev, eng } = mk();
  eng.onSegment(seg('Liam, peux-tu', { utterance_id: 'U', finality: 'provisional', confidence: 0.5 }));
  assert.deepEqual(kinds(ev), ['alert']);
  assert.equal((ev.find((e) => e.type === 'alert') as { basis: string }).basis, 'provisional');
  eng.onSegment(seg('Liam, peux-tu répondre ?', { utterance_id: 'U' }));
  assert.deepEqual(kinds(ev), ['alert', 'update:confirmed']);
});

test('provisoire : si le final annule ou diverge, l’alerte est retirée', () => {
  const a = mk();
  a.eng.onSegment(seg('Liam, peux-tu', { utterance_id: 'U', finality: 'provisional', confidence: 0.5 }));
  a.eng.onSegment(seg('Liam, peux-tu expliquer... non laisse tomber.', { utterance_id: 'U' }));
  assert.deepEqual(kinds(a.ev), ['alert', 'retract']);
  const b = mk();
  b.eng.onSegment(seg('Liam, peux-tu', { utterance_id: 'V', finality: 'provisional', confidence: 0.5 }));
  b.eng.onSegment(seg('Le lit en peluche', { utterance_id: 'V' })); // le STT s’est corrigé : ce n’était pas un appel
  assert.deepEqual(kinds(b.ev), ['alert', 'retract']);
});

test('provisoire : un appel seulement PROBABLE n’alerte pas avant le final', () => {
  const { ev, eng } = mk();
  eng.onSegment(seg('Liam, voici', { utterance_id: 'W', finality: 'provisional', confidence: 0.5 }));
  assert.deepEqual(kinds(ev), []);
  eng.onSegment(seg('Liam, voici la question.', { utterance_id: 'W' }));
  assert.deepEqual(kinds(ev), ['alert']);
});

test('relance après réponse de l’utilisateur : nouvelle question ; réponse ferme la précédente', () => {
  const { ev, eng } = mk();
  eng.onSegment(seg('Liam, peux-tu répondre ?'));
  eng.onSegment(seg('Oui, la réponse est trois.', { speaker_id: 'u-liam' }));
  eng.onSegment(seg('Liam, et la suivante ?'));
  assert.deepEqual(kinds(ev), ['alert', 'closed', 'alert']);
});

test('prompt LLM versionné ; fenêtre de contexte bornée à 15–60 s', async () => {
  const p = buildPrompt({ user: USER, context: [{ speaker: 'prof', text: 'Liam, peux-tu répondre ?', t_ms: 1000 }], target_segment_id: 's', rule_class: 'DIRECT_CERTAIN' });
  assert.match(p.system, new RegExp(ENGINE_VERSION.replace(/\./g, '\\.')));
  assert.match(p.user, /prof: Liam/);
  const lens: number[] = [];
  const llm: LlmAddressClassifier = { classify: async (r) => { lens.push(r.context.length); return verdict('DIRECT_CERTAIN', 0.5); } };
  for (const [cfg, expected] of [[1_000, 1], [300_000, 3]] as const) {
    lens.length = 0;
    const { eng } = mk(llm, { context_ms: cfg });
    // trois finaux espacés de 20 s : contexte plancher 15 s → 1 ligne ; plafond 60 s → 3 lignes
    eng.onSegment(seg('Bonjour à tous', { start_ms: T, end_ms: T + 1000 }));
    eng.onSegment(seg('Voici le plan', { start_ms: T + 20_000, end_ms: T + 21_000 }));
    eng.onSegment(seg('Liam, peux-tu répondre ?', { start_ms: T + 40_000, end_ms: T + 41_000 }));
    await eng.flush();
    assert.deepEqual(lens, [expected], `context_ms=${cfg}`);
  }
});

test('retour utilisateur : faux positif / raté tracés par version, export, candidats d’alias', () => {
  const f = new FeedbackStore();
  f.record({ kind: 'false_positive', question_id: 'q-1', text: 'Where is Liam?', at_ms: 1 });
  f.record({ kind: 'missed', segment_id: 's9', text: 'Lien, peux-tu répondre ?', at_ms: 2 });
  f.record({ kind: 'missed', segment_id: 's10', text: 'Lien tu peux ?', at_ms: 3 });
  f.record({ kind: 'correct', question_id: 'q-2', at_ms: 4, engine_version: '10.9.0' });
  assert.deepEqual(f.stats()[ENGINE_VERSION], { false_positive: 1, missed: 2, correct: 0 });
  assert.equal(f.stats()['10.9.0']!.correct, 1);
  assert.equal(f.exportJsonl().split('\n').length, 4);
  assert.equal(f.aliasCandidates()[0], 'lien');
});

test('parseVerdict : cas limites', () => {
  const ctx = 'Liam, peux-tu répondre ?';
  assert.ok(parseVerdict(JSON.stringify(verdict('DIRECT_CERTAIN', 0.9, ['Liam, peux-tu'])), ctx));
  assert.equal(parseVerdict(verdict('DIRECT_CERTAIN', 1.2, ['Liam']), ctx), null);
  assert.equal(parseVerdict(verdict('AUTRE', 0.5, []), ctx), null);
  assert.equal(parseVerdict(null, ctx), null);
  assert.ok(parseVerdict(verdict('MENTION_SIMPLE', 0.9, []), ctx));
});

test('débit : 20 000 segments traités par les règles en < 5 s', () => {
  const { eng } = mk();
  const t0 = Date.now();
  for (let i = 0; i < 20_000; i++) eng.onSegment(seg(i % 7 === 0 ? 'Liam, peux-tu répondre ?' : 'La variance est la moyenne des carrés des écarts à la moyenne.', { start_ms: T + i * 60_000, end_ms: T + i * 60_000 + 2000 }));
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

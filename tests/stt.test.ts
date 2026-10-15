import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, segment } from '../src/stt/segmenter.ts';
import { detectLang } from '../src/stt/lang.ts';
import { Glossary, phoneticKey } from '../src/stt/glossary.ts';
import { wer } from '../src/stt/wer.ts';
import { TranscriptAssembler, quote } from '../src/stt/assembler.ts';
import { ProviderSelector, type ProviderHealth } from '../src/stt/adapter.ts';
import { SourceNormalizer } from '../src/merge/normalizer.ts';
import { ClockModel } from '../src/merge/timebase.ts';
import { validateEvidence } from '../src/contracts/evidence.ts';
import { generate } from './support/corpus.ts';
import type { SttEvent } from '../src/stt/adapter.ts';

const ROSTER = new Map([['prof', 'Prof'], ['liam', 'Liam'], ['alice', 'Alice']]);
const T = 1_800_000_000_000;
const ev = (o: Partial<SttEvent> & Pick<SttEvent, 'kind' | 'revision' | 'text'>): SttEvent => ({ utterance_id: 'u1', start_ms: T, end_ms: T + 4000, confidence: 0.9, emitted_utc_ms: T + 4500, speaker_id: 'prof', ...o });

test('segmentation FR/EN : décimales, abréviations, ?, ! préservées', () => {
  assert.deepEqual(splitSentences('Le Dr. Martin a trouvé 3.14. Est-ce clair ? Oui ! On continue.'), ['Le Dr. Martin a trouvé 3.14.', 'Est-ce clair ?', 'Oui !', 'On continue.']);
  assert.deepEqual(splitSentences('Open the notebook. Then run it, e.g. the first cell.'), ['Open the notebook.', 'Then run it, e.g. the first cell.']);
});

test('longue pause (3 s) → coupure même sans ponctuation ; pause courte → pas de coupure', () => {
  const mk = (gap: number) => 'on regarde la variance puis on conclut sur le théorème'.split(' ').map((w, i) => ({ w, start_ms: i * 350 + (i >= 5 ? gap : 0), end_ms: i * 350 + 300 + (i >= 5 ? gap : 0) }));
  assert.equal(segment('', 0, 9000, mk(3000), { pause_ms: 2000 }).length, 2);
  assert.equal(segment('', 0, 9000, mk(500), { pause_ms: 2000 }).length, 1);
  const long = Array.from({ length: 80 }, (_, i) => ({ w: `mot${i}`, start_ms: i * 400, end_ms: i * 400 + 300 }));
  assert.ok(segment('', 0, 32_000, long, { max_segment_ms: 20_000 }).length >= 2);
});

test('code switching FR/EN détecté', () => {
  assert.equal(detectLang('Aujourd\'hui on voit la convergence et le théorème est très important').lang, 'fr');
  assert.equal(detectLang('Please open the notebook and run the first cell for this example').lang, 'en');
  assert.equal(detectLang('Alors can you share ton écran and then on continue avec la suite').lang, 'mixed');
  // Limite connue : des termes anglais insérés dans du français (sans mots-outils anglais) restent classés « fr » — le `lang` du moteur prime.
  assert.equal(detectLang('On va regarder le gradient descent algorithm puis on passe à la suite').lang, 'fr');
  assert.equal(detectLang('ok').lang, 'unknown');
});

test('glossaire : noms propres / termes corrigés, mots courants intacts, correction tracée', () => {
  const g = new Glossary(['Liam', 'Markov', 'martingale']);
  assert.equal(phoneticKey('Lyam'), phoneticKey('Liam'));
  const r = g.apply('Lyam explique les chaînes de Markof et la martingal');
  assert.equal(r.text, 'Liam explique les chaînes de Markov et la martingale');
  assert.equal(r.corrections.length, 3);
  const untouched = g.apply('la liane et le marteau sont une marge');
  assert.equal(untouched.text, 'la liane et le marteau sont une marge');
  assert.equal(untouched.corrections.length, 0);
});

test('homophones courants non réécrits sans glossaire (pas de devinette)', () => {
  const g = new Glossary(['Liam']);
  for (const s of ['le vers et le verre', 'cent mille sans doute', 'ce chant du champ']) assert.equal(g.apply(s).text, s);
});

test('WER : le glossaire réduit l’erreur sur noms propres bruités (mécanisme, pas qualité STT réelle)', () => {
  const refs = ['Liam explique Markov', 'la martingale de Liam', 'Markov et Liam discutent'];
  const hyps = ['Lyam explique Markof', 'la martingal de Lyam', 'Markof et Lyam discutent'];
  const g = new Glossary(['Liam', 'Markov', 'martingale']);
  const before = refs.reduce((s, r, i) => s + wer(r, hyps[i]!), 0) / 3;
  const after = refs.reduce((s, r, i) => s + wer(r, g.apply(hyps[i]!).text), 0) / 3;
  assert.ok(before > 0.3 && after === 0, `${before} → ${after}`);
  assert.equal(wer('a b c d', 'a b x d'), 0.25);
});

test('provisoire → corrections → final : un seul final, aucune révision tardive ne le rouvre', () => {
  const a = new TranscriptAssembler({ roster: ROSTER, source_kind: 'rtms' });
  a.ingest(ev({ kind: 'hypothesis', revision: 0, text: 'Liam peux' }));
  a.ingest(ev({ kind: 'hypothesis', revision: 1, text: 'Liam peux-tu' }));
  a.ingest(ev({ kind: 'hypothesis', revision: 1, text: 'ANCIEN' })); // révision périmée
  assert.equal(a.provisionals().length, 1);
  assert.equal(a.finals().length, 0, 'un provisoire ne compte pas comme final');
  assert.equal(a.provisionals()[0]!.text, 'Liam peux-tu');
  a.ingest(ev({ kind: 'final', revision: 2, text: 'Liam, peux-tu répondre ?' }));
  a.ingest(ev({ kind: 'hypothesis', revision: 3, text: 'tardif' }));
  assert.equal(a.provisionals().length, 0);
  assert.deepEqual(a.finals().map((s) => s.text), ['Liam, peux-tu répondre ?']);
  assert.equal(a.stats.stale_revisions, 1); assert.equal(a.stats.late_after_final, 1);
});

test('flux coupé : provisoire orphelin abandonné, jamais promu', () => {
  const a = new TranscriptAssembler({ roster: ROSTER, source_kind: 'rtms' });
  a.ingest(ev({ kind: 'hypothesis', revision: 0, text: 'phrase inachevée' }));
  assert.equal(a.close().orphan_provisionals, 1);
  assert.equal(a.finals().length, 0);
});

test('speakers : RTMS+roster seulement ; id inconnu ou source locale → UNKNOWN', () => {
  const rt = new TranscriptAssembler({ roster: ROSTER, source_kind: 'rtms' });
  rt.ingest(ev({ kind: 'final', revision: 0, text: 'Bonjour à tous', speaker_id: 'prof' }));
  rt.ingest(ev({ utterance_id: 'u2', kind: 'final', revision: 0, text: 'Intrus ici', speaker_id: 'u-ghost' }));
  const [a, b] = rt.finals();
  assert.equal(a!.speaker_id, 'prof'); assert.equal(b!.speaker_id, null); assert.ok(b!.flags.includes('speaker_not_in_roster'));
  const lo = new TranscriptAssembler({ roster: ROSTER, source_kind: 'mac_local' });
  lo.ingest(ev({ kind: 'final', revision: 0, text: 'Bonjour', speaker_id: 'prof', diar_cluster: 'S2' }));
  const s = lo.finals()[0]!;
  assert.equal(s.speaker_id, null); assert.equal(s.diar_cluster, 'S2');
  const norm = new SourceNormalizer({ meeting_id: 'M', source_id: 'mac', kind: 'mac_local', clock: new ClockModel() });
  const e = lo.toEvidence(s, norm, T + 5000);
  assert.deepEqual(e.speaker, { status: 'unknown' });
  assert.ok(e.flags.includes('diar_cluster:S2'));
});

test('quote() : provisoire / peu fiable jamais « certain »', () => {
  const a = new TranscriptAssembler({ roster: ROSTER, source_kind: 'rtms' });
  a.ingest(ev({ kind: 'hypothesis', revision: 0, text: 'Liam peux' }));
  a.ingest(ev({ utterance_id: 'u2', kind: 'final', revision: 0, text: 'mots flous', confidence: 0.3 }));
  a.ingest(ev({ utterance_id: 'u3', kind: 'final', revision: 0, text: 'phrase nette', confidence: 0.95 }));
  assert.equal(quote(a.provisionals()[0]!).certain, false);
  const [low, ok] = a.finals();
  assert.equal(quote(low!).certain, false); assert.match(quote(low!).caveat!, /peu fiable/);
  assert.equal(quote(ok!).certain, true);
});

test('budgets de latence : dépassements signalés et comptés', () => {
  const a = new TranscriptAssembler({ roster: ROSTER, source_kind: 'rtms' });
  a.ingest(ev({ kind: 'hypothesis', revision: 0, text: 'lent', emitted_utc_ms: T + 3000 }));
  a.ingest(ev({ kind: 'final', revision: 1, text: 'lent et tardif', emitted_utc_ms: T + 4000 + 6000 }));
  assert.equal(a.stats.budget_violations, 2);
  assert.ok(a.finals()[0]!.flags.includes('latency_budget_exceeded'));
  assert.equal(a.finalLatency.percentile(95), 6000);
});

const H = (o: Partial<ProviderHealth> = {}): ProviderHealth => ({ rtms_transcript_available: true, rtms_languages: ['fr', 'en'], rtms_coverage: 0.99, rtms_final_latency_p95_ms: 2000, local_stt_available: true, capture_allowed: true, ...o });
test('choix du moteur : RTMS natif si suffisant, sinon STT audio, hystérésis, interdiction immédiate', () => {
  const s = new ProviderSelector();
  assert.equal(s.evaluate(H()).provider, 'rtms_native');
  assert.equal(s.evaluate(H({ rtms_coverage: 0.8 })).provider, 'rtms_native'); // 1/3
  assert.equal(s.evaluate(H({ rtms_coverage: 0.8 })).provider, 'rtms_native'); // 2/3
  const sw = s.evaluate(H({ rtms_coverage: 0.8 }));
  assert.equal(sw.provider, 'audio_stt'); assert.match(sw.reasons.join(), /couverture/);
  assert.equal(new ProviderSelector().evaluate(H({ rtms_languages: ['en'] })).provider, 'audio_stt');
  assert.equal(new ProviderSelector().evaluate(H({ rtms_transcript_available: false, local_stt_available: false })).provider, 'none');
  const p = s.evaluate(H({ capture_allowed: false }));
  assert.equal(p.provider, 'none'); assert.match(p.reasons[0]!, /aucun contournement/);
});

for (const [name, minutes] of [['30 min', 30], ['3 h', 180]] as const) {
  test(`corpus synthétique ${name} : invariants final/provisoire/speakers`, () => {
    const c = generate(minutes, minutes);
    const a = new TranscriptAssembler({ roster: ROSTER, source_kind: 'rtms' });
    const t0 = Date.now();
    for (const e of c.events) a.ingest(e);
    const orphans = a.close().orphan_provisionals;
    const finals = a.finals();
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(orphans, c.truth.orphans);
    assert.equal(a.stats.final_utterances, c.truth.finals);
    assert.ok(finals.every((s) => s.finality === 'final'));
    assert.ok(!finals.some((s) => /orphelin|tardif/.test(s.text)), 'ni orphelin ni révision tardive dans les finals');
    assert.equal(a.stats.late_after_final, c.truth.lateAfterFinal);
    assert.ok(finals.every((s) => s.speaker_id === null || ROSTER.has(s.speaker_id)));
    assert.ok(!finals.some((s) => s.speaker_id === 'u-ghost'));
    assert.ok(a.stats.speaker_rejected >= c.truth.ghosts);
    assert.equal(finals.filter((s) => s.flags.includes('low_confidence')).length >= 1, c.truth.lowConf > 0);
    assert.ok(finals.filter((s) => s.flags.includes('split:pause')).length >= (c.truth.withPause > 0 ? 1 : 0));
    // aucun provisoire résiduel après clôture, et chaque provisoire cité est incertain
    assert.equal(a.provisionals().length, 0);
    // conversion en evidence : valide, finalité fidèle
    const norm = new SourceNormalizer({ meeting_id: 'M', source_id: 'rtms-1', kind: 'rtms', attested: true, clock: new ClockModel() });
    for (const s of finals.slice(0, 500)) { const e = a.toEvidence(s, norm, s.end_ms + 1000); assert.deepEqual(validateEvidence(e), []); assert.equal(e.finality, 'final'); }
    assert.ok(a.stats.budget_violations >= c.truth.budgetViolations * 0.5);
  });

  test(`corpus synthétique ${name} : source locale → aucun speaker inventé`, () => {
    const c = generate(minutes, minutes + 1, true);
    const a = new TranscriptAssembler({ roster: ROSTER, source_kind: 'mac_local' });
    for (const e of c.events) a.ingest(e);
    a.close();
    assert.ok(a.finals().length > 0);
    assert.ok(a.finals().every((s) => s.speaker_id === null && s.flags.includes('speaker_unknown')));
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from './support/address_harness.ts';
import { HOLDOUT_CASES } from '../corpus/address_holdout.ts';
import { HOLDOUT2_CASES } from '../corpus/address_holdout2.ts';
import { ADDRESS_CASES, type Case } from '../corpus/address_cases.ts';
import { ENGINE_VERSION } from '../src/address/types.ts';

const gated = ADDRESS_CASES.filter((c) => !c.known_limit);
const limits = ADDRESS_CASES.filter((c) => c.known_limit);

test('corpus ≥ 100 cas FR/EN, toutes catégories exigées présentes', () => {
  assert.ok(ADDRESS_CASES.length >= 100, `${ADDRESS_CASES.length}`);
  assert.ok(ADDRESS_CASES.some((c) => c.lang === 'fr') && ADDRESS_CASES.some((c) => c.lang === 'en'));
  const cats = new Set(ADDRESS_CASES.map((c) => c.cat));
  for (const k of ['nom_evoque', 'homophone', 'question_indirecte', 'prenom_absent', 'plusieurs_liam', 'annulee', 'relance']) assert.ok(cats.has(k as never), k);
});

for (const mode of ['final', 'prov+final'] as const) {
  test(`corpus (${mode}) : classe, alertes nettes et urgence conformes sur tous les cas non « limite connue »`, () => {
    const failures: string[] = [];
    for (const c of gated) {
      const r = runCase(c, mode);
      if (r.targetClass !== c.expect.cls) failures.push(`${c.id} classe ${r.targetClass} ≠ ${c.expect.cls} :: ${c.turns.map((x) => x[1]).join(' | ')}`);
      if (r.netAlerts !== c.expect.alerts) failures.push(`${c.id} alertes ${r.netAlerts} ≠ ${c.expect.alerts} :: ${c.turns.map((x) => x[1]).join(' | ')}`);
      if (r.urgent !== c.expect.urgent) failures.push(`${c.id} urgentes ${r.urgent} ≠ ${c.expect.urgent}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('une unique alerte directe par question ; aucune urgence pour une mention (tout le corpus)', () => {
  for (const mode of ['final', 'prov+final'] as const) for (const c of ADDRESS_CASES) {
    const ev = runCase(c, mode).events;
    const ids = ev.filter((e) => e.type === 'alert').map((e) => (e as { question_id: string }).question_id);
    assert.equal(new Set(ids).size, ids.length, `${c.id} (${mode}) : alerte dupliquée pour une même question`);
    if (c.expect.cls === 'MENTION_SIMPLE' && !c.known_limit) assert.equal(ev.filter((e) => e.type === 'alert').length, 0, `${c.id} : alerte sur simple mention`);
    for (const e of ev) if (e.type === 'alert' && e.decision.cls !== 'DIRECT_CERTAIN' && e.decision.cls !== 'DIRECT_PROBABLE') assert.fail(`${c.id} : alerte pour ${e.decision.cls}`);
  }
});

test('limites connues : documentées, étiquetées avec la vérité terrain, et effectivement non détectées (pas de faux « succès »)', () => {
  assert.ok(limits.length >= 2);
  for (const c of limits) {
    const r = runCase(c, 'final');
    const ok = r.targetClass === c.expect.cls && r.netAlerts === c.expect.alerts;
    assert.equal(ok, false, `${c.id} passe maintenant : retirer known_limit (${c.known_limit})`);
  }
});

test('traces d’incertitude et version du moteur sur chaque décision ; garantie explicite', () => {
  const ev = runCase(ADDRESS_CASES.find((c) => c.expect.cls === 'DIRECT_PROBABLE' && c.cat === 'homophone' && !c.known_limit)!, 'final').events;
  const tr = ev.filter((e) => e.type === 'trace');
  assert.ok(tr.length > 0 && tr.every((e) => e.type === 'trace' && e.engine_version === ENGINE_VERSION && e.decision.engine_version === ENGINE_VERSION));
  assert.ok(tr.some((e) => e.type === 'trace' && e.decision.uncertainty.includes('PHONETIC_ONLY')));
  const unnamed = runCase(ADDRESS_CASES.find((c) => c.cat === 'prenom_absent' && c.turns[0]![1] === 'Peux-tu nous expliquer la question 3 ?')!, 'final').events;
  assert.ok(unnamed.some((e) => e.type === 'trace' && e.decision.uncertainty.includes('UNNAMED_SECOND_PERSON')), 'sollicitation non nommée tracée comme incertitude');
});

test('jeux de contrôle 1 et 2 (après réglage : désormais des tests de régression, plus des mesures indépendantes)', () => {
  const bad: string[] = [];
  for (const mode of ['final', 'prov+final'] as const) for (const c of [...HOLDOUT_CASES, ...HOLDOUT2_CASES]) {
    const r = runCase(c, mode);
    if (r.targetClass !== c.expect.cls || r.netAlerts !== c.expect.alerts || r.urgent !== c.expect.urgent) bad.push(`${c.id}(${mode}) ${r.targetClass}/${r.netAlerts}/${r.urgent} :: ${c.turns.map((t) => t[1]).join(' | ')}`);
  }
  assert.deepEqual(bad, []);
});

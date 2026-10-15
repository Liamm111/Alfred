import { HOLDOUT_CASES } from '../corpus/address_holdout.ts';
import { runCase } from '../tests/support/address_harness.ts';

let pass = 0; const fails: string[] = [];
for (const c of HOLDOUT_CASES) {
  const r = runCase(c, 'final');
  const ok = r.targetClass === c.expect.cls && r.netAlerts === c.expect.alerts && r.urgent === c.expect.urgent;
  if (ok) pass++; else fails.push(`${c.id} attendu ${c.expect.cls}/alertes ${c.expect.alerts}/urgentes ${c.expect.urgent} — obtenu ${r.targetClass}/${r.netAlerts}/${r.urgent} :: ${c.turns.map((t) => t[1]).join(' | ')}`);
}
console.log(`holdout: ${pass}/${HOLDOUT_CASES.length}`);
for (const f of fails) console.log('  ÉCHEC ' + f);

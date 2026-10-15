import { AddressEngine } from '../../src/address/engine.ts';
import type { Case } from '../../corpus/address_cases.ts';
import { ALERT_OF, type AddressClass, type EngineEvent, type InSegment, type Participant, type UserProfile } from '../../src/address/types.ts';

export const USER: UserProfile = { id: 'u-liam', first: 'Liam', last: 'Martin', aliases: ['Lyam'] };
const ROSTERS: Record<Case['roster'], Participant[]> = {
  default: [{ id: 'prof', first: 'Prof', last: 'Durand' }, { id: 'alice', first: 'Alice' }, { id: 'bob', first: 'Bob' }, { id: 'carol', first: 'Carol' }, { id: 'u-liam', first: 'Liam', last: 'Martin' }],
  two_liams: [{ id: 'prof', first: 'Prof', last: 'Durand' }, { id: 'alice', first: 'Alice' }, { id: 'u-liam', first: 'Liam', last: 'Martin' }, { id: 'liam2', first: 'Liam', last: 'Dupont' }],
  one_on_one: [{ id: 'prof', first: 'Prof', last: 'Durand' }, { id: 'u-liam', first: 'Liam', last: 'Martin' }],
};
const T0 = 1_800_000_000_000;

export interface RunResult { events: EngineEvent[]; targetClass: AddressClass | null; netAlerts: number; urgent: number }

export function runCase(c: Case, mode: 'final' | 'prov+final'): RunResult {
  const events: EngineEvent[] = [];
  const eng = new AddressEngine({ user: USER, roster: ROSTERS[c.roster], emit: (e) => events.push(e) });
  let t = T0; const target = c.expect.target ?? c.turns.length - 1;
  let targetSeg = '';
  c.turns.forEach(([speaker, text, dt, conf], i) => {
    t += dt ?? 0;
    const base: Omit<InSegment, 'segment_id' | 'text' | 'finality'> = { utterance_id: `u${i}`, evidence_id: `ev${i}`, start_ms: t, end_ms: t + 2500, speaker_id: speaker, confidence: conf ?? 0.95 };
    if (mode === 'prov+final') {
      const w = text.split(' '); const cut = Math.max(1, Math.ceil(w.length * 0.6));
      eng.onSegment({ ...base, segment_id: `s${i}p`, text: w.slice(0, cut).join(' '), finality: 'provisional', confidence: 0.5 });
    }
    eng.onSegment({ ...base, segment_id: `s${i}`, text, finality: 'final' });
    if (i === target) targetSeg = `s${i}`;
    t += 2500;
  });
  const traces = events.filter((e): e is Extract<EngineEvent, { type: 'trace' }> => e.type === 'trace' && e.decision.segment_id === targetSeg && e.finality === 'final');
  const alerts = new Map<string, AddressClass>(); const retracted = new Set<string>();
  for (const e of events) {
    if (e.type === 'alert') alerts.set(e.question_id, e.decision.cls);
    if (e.type === 'update' && (e.what === 'upgraded' || e.what === 'downgraded')) alerts.set(e.question_id, e.decision.cls);
    if (e.type === 'retract') retracted.add(e.question_id);
  }
  const live = [...alerts].filter(([id]) => !retracted.has(id));
  return { events, targetClass: traces[0]?.decision.cls ?? null, netAlerts: live.length, urgent: live.filter(([, c2]) => ALERT_OF[c2] === 'urgent').length };
}


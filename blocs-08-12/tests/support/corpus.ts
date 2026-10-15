// Corpus SYNTHÉTIQUE de flux STT (événements texte) — il ne contient aucun audio.
// Il sert à éprouver les invariants (final vs provisoire, speakers) à 30 min et 3 h, pas la qualité du STT réel.
import type { SttEvent } from '../../src/stt/adapter.ts';

export function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

const FR = ['Liam, peux-tu expliquer la chaîne de Markov ?', 'Aujourd\'hui on voit la convergence des martingales.', 'Le Dr. Martin a montré que la valeur est 3.14 environ.', 'Passons à la diapositive suivante, s\'il vous plaît.', 'Est-ce que tout le monde a compris le théorème ?'];
const EN = ['Can you explain gradient descent to the group?', 'Let us look at the loss function again.', 'The variance decreases when n grows.', 'Please open the notebook and run the first cell.'];
const MIX = ['On va regarder le gradient descent algorithm puis on passe à la suite.', 'Le learning rate doit être plus petit sinon ça diverge.', 'Liam, can you share ton écran please ?'];

export interface Corpus {
  events: SttEvent[];
  truth: { utterances: number; finals: number; orphans: number; lateAfterFinal: number; ghosts: number; lowConf: number; budgetViolations: number; withPause: number };
}

export function generate(minutes: number, seed: number, local = false): Corpus {
  const r = rng(seed);
  const roster = ['prof', 'liam', 'alice'];
  const events: SttEvent[] = [];
  const truth = { utterances: 0, finals: 0, orphans: 0, lateAfterFinal: 0, ghosts: 0, lowConf: 0, budgetViolations: 0, withPause: 0 };
  let t = 1_800_000_000_000; const end = t + minutes * 60_000; let n = 0;
  while (t < end) {
    const id = `u${n++}`; truth.utterances++;
    const pool = r() < 0.55 ? FR : r() < 0.7 ? EN : MIX;
    let text = pool[Math.floor(r() * pool.length)]!;
    const dur = 2000 + Math.floor(r() * 9000);
    const orphan = r() < 0.04;
    if (orphan) { text = `orphelin${n} ${text}`; truth.orphans++; }
    const ghost = r() < 0.03;
    if (ghost) truth.ghosts++;
    const speaker = ghost ? 'u-ghost' : roster[Math.floor(r() * roster.length)]!;
    const cluster = `S${1 + Math.floor(r() * 3)}`;
    const base = { utterance_id: id, speaker_id: speaker, diar_cluster: cluster, lang: 'unknown' as const };
    const words = text.split(' ');
    const revs = 1 + Math.floor(r() * 3);
    for (let k = 0; k < revs; k++) {
      const part = words.slice(0, Math.max(1, Math.ceil((words.length * (k + 1)) / (revs + 1)))).join(' ');
      const slow = k === 0 && r() < 0.03; if (slow) truth.budgetViolations++;
      events.push({ ...base, kind: 'hypothesis', revision: k, start_ms: t, end_ms: t + dur * ((k + 1) / (revs + 1)), text: part, confidence: 0.5, emitted_utc_ms: t + (slow ? 2500 : 300) + k * 400 });
    }
    if (!orphan) {
      truth.finals++;
      const conf = r() < 0.02 ? 0.3 + r() * 0.2 : 0.8 + r() * 0.2; if (conf < 0.6) truth.lowConf++;
      let evWords;
      let fin = text;
      if (r() < 0.05) { // long énoncé avec une pause de 3 s au milieu
        truth.withPause++;
        const half = Math.ceil(words.length / 2); let at = t; evWords = [] as { w: string; start_ms: number; end_ms: number }[];
        words.forEach((w, i) => { if (i === half) at += 3000; evWords!.push({ w, start_ms: at, end_ms: at + 300 }); at += 350; });
        fin = text;
      }
      const slowFinal = r() < 0.02; if (slowFinal) truth.budgetViolations++;
      events.push({ ...base, kind: 'final', revision: revs, start_ms: t, end_ms: t + dur, text: fin, confidence: conf, emitted_utc_ms: t + dur + (slowFinal ? 6000 : 800), ...(evWords ? { words: evWords } : {}) });
      if (r() < 0.03) { truth.lateAfterFinal++; events.push({ ...base, kind: 'hypothesis', revision: revs + 1, start_ms: t, end_ms: t + dur, text: `tardif${n} ${text}`, confidence: 0.4, emitted_utc_ms: t + dur + 900 }); }
    }
    t += dur + 300 + Math.floor(r() * 2500);
  }
  void local; // en mode local les mêmes événements (avec speaker_id) sont rejoués : l'assembleur doit les ignorer
  return { events, truth };
}

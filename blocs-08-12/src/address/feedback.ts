import { ENGINE_VERSION } from './types.ts';

export interface Feedback {
  kind: 'false_positive' | 'missed' | 'correct';
  question_id?: string;
  segment_id?: string;
  /** Texte du segment concerné (utile pour enrichir le corpus et proposer des alias). */
  text?: string;
  note?: string;
  engine_version: string;
  at_ms: number;
}

export class FeedbackStore {
  #rows: Feedback[] = [];
  record(f: Omit<Feedback, 'engine_version'> & { engine_version?: string }): Feedback {
    const row = { ...f, engine_version: f.engine_version ?? ENGINE_VERSION };
    this.#rows.push(row); return row;
  }
  get all(): readonly Feedback[] { return this.#rows; }
  stats(): Record<string, { false_positive: number; missed: number; correct: number }> {
    const out: Record<string, { false_positive: number; missed: number; correct: number }> = {};
    for (const r of this.#rows) { const s = (out[r.engine_version] ??= { false_positive: 0, missed: 0, correct: 0 }); s[r.kind]++; }
    return out;
  }
  /** Export JSONL réinjectable dans le corpus de régression. */
  exportJsonl(): string { return this.#rows.map((r) => JSON.stringify(r)).join('\n'); }
  /** Premiers mots non reconnus des « ratés » : candidats d'alias à valider par l'utilisateur (jamais ajoutés automatiquement). */
  aliasCandidates(): string[] {
    const c = new Map<string, number>();
    for (const r of this.#rows) if (r.kind === 'missed' && r.text) for (const w of r.text.split(/[\s,;:?!]+/).slice(0, 3)) if (w.length >= 3) c.set(w.toLowerCase(), (c.get(w.toLowerCase()) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  }
}

import type { Finality } from '../contracts/evidence.ts';
import type { SourceNormalizer } from '../merge/normalizer.ts';
import type { NormalizedEvidence } from '../contracts/evidence.ts';
import type { SttEvent } from './adapter.ts';
import { Glossary } from './glossary.ts';
import { detectLang, type Lang } from './lang.ts';
import { DEFAULT_BUDGET, LatencyStats, type LatencyBudget } from './latency.ts';
import { segment, type SegmenterConfig } from './segmenter.ts';

export interface Segment {
  segment_id: string;
  utterance_id: string;
  start_ms: number; end_ms: number;
  text: string; raw_text: string;
  lang: Lang;
  finality: Finality;
  confidence: number;
  speaker_id: string | null; // seulement RTMS + roster ; sinon null
  diar_cluster: string | null;
  latency_ms: number | null;
  flags: string[];
}

export const LOW_CONFIDENCE = 0.6;

export interface AssemblerOptions {
  /** Identités autorisées (roster RTMS). Un id absent n'est jamais promu. */
  roster: ReadonlyMap<string, string>;
  source_kind: 'rtms' | 'mac_local';
  glossary?: Glossary;
  budget?: LatencyBudget;
  segmenter?: Partial<SegmenterConfig>;
}

interface Utt { revision: number; final: boolean; provisional: Segment | null; finals: Segment[] }

export class TranscriptAssembler {
  #o: AssemblerOptions;
  #utts = new Map<string, Utt>();
  readonly stats = { stale_revisions: 0, late_after_final: 0, final_utterances: 0, speaker_rejected: 0, budget_violations: 0 };
  readonly finalLatency = new LatencyStats();
  readonly firstLatency = new LatencyStats();
  #budget: LatencyBudget;

  constructor(o: AssemblerOptions) { this.#o = o; this.#budget = o.budget ?? DEFAULT_BUDGET; }

  ingest(ev: SttEvent): void {
    let u = this.#utts.get(ev.utterance_id);
    if (!u) { u = { revision: -1, final: false, provisional: null, finals: [] }; this.#utts.set(ev.utterance_id, u); }
    if (u.final) { this.stats.late_after_final++; return; } // un final n'est jamais rouvert silencieusement
    if (ev.revision <= u.revision && !(ev.kind === 'final' && ev.revision === u.revision)) { this.stats.stale_revisions++; return; }
    u.revision = ev.revision;
    const lat = ev.emitted_utc_ms - (ev.kind === 'final' ? ev.end_ms : ev.start_ms);
    if (ev.kind === 'hypothesis') {
      if (u.provisional === null) this.firstLatency.add(lat);
      const seg = this.#build(ev, ev.text, ev.start_ms, ev.end_ms, 'provisional', 0, lat);
      if (u.provisional === null && lat > this.#budget.first_hypothesis_ms) { seg.flags.push('latency_budget_exceeded'); this.stats.budget_violations++; }
      u.provisional = seg;
      return;
    }
    this.finalLatency.add(lat);
    u.final = true; u.provisional = null; this.stats.final_utterances++;
    const pieces = segment(ev.text, ev.start_ms, ev.end_ms, ev.words, this.#o.segmenter);
    u.finals = pieces.map((p, i) => this.#build(ev, p.text, p.start_ms, p.end_ms, 'final', i, lat, p.reason));
    if (lat > this.#budget.final_ms) { for (const s of u.finals) s.flags.push('latency_budget_exceeded'); this.stats.budget_violations++; }
  }

  #build(ev: SttEvent, text: string, start: number, end: number, fin: Finality, idx: number, lat: number, reason?: string): Segment {
    const flags: string[] = [];
    let speaker: string | null = null;
    if (ev.speaker_id) {
      if (this.#o.source_kind === 'rtms' && this.#o.roster.has(ev.speaker_id)) speaker = ev.speaker_id;
      else { this.stats.speaker_rejected++; flags.push(this.#o.source_kind === 'rtms' ? 'speaker_not_in_roster' : 'speaker_from_local_ignored'); }
    }
    const g = this.#o.glossary?.apply(text);
    const out = g ? g.text : text;
    if (g && g.corrections.length) flags.push(`glossary:${g.corrections.length}`);
    const det = detectLang(out);
    const lang: Lang = ev.lang && ev.lang !== 'unknown' ? ev.lang : det.lang;
    if (reason && reason !== 'whole' && reason !== 'sentence') flags.push(`split:${reason}`);
    if (fin === 'provisional') flags.push('provisional');
    if (fin === 'final' && ev.confidence < LOW_CONFIDENCE) flags.push('low_confidence');
    if (!speaker) flags.push('speaker_unknown');
    return { segment_id: `${ev.utterance_id}#${fin === 'final' ? idx : 'p'}`, utterance_id: ev.utterance_id, start_ms: start, end_ms: end, text: out, raw_text: text, lang, finality: fin, confidence: ev.confidence, speaker_id: speaker, diar_cluster: ev.diar_cluster ?? null, latency_ms: lat, flags };
  }

  /** Seules les phrases finalisées comptent comme transcription. */
  finals(): Segment[] { return [...this.#utts.values()].flatMap((u) => u.finals).sort((a, b) => a.start_ms - b.start_ms || (a.segment_id < b.segment_id ? -1 : 1)); }
  /** Hypothèses en cours : affichage « en direct » uniquement, jamais citable. */
  provisionals(): Segment[] { return [...this.#utts.values()].filter((u) => !u.final && u.provisional).map((u) => u.provisional!); }

  /** Clôture du flux : les énoncés restés provisoires sont abandonnés, jamais promus en final. */
  close(): { orphan_provisionals: number } {
    let n = 0;
    for (const u of this.#utts.values()) if (!u.final && u.provisional) { n++; u.provisional = null; }
    return { orphan_provisionals: n };
  }

  toEvidence(seg: Segment, norm: SourceNormalizer, nowUtcMs: number): NormalizedEvidence {
    const ev = norm.normalize({
      modality: 'transcript', local_start_ms: seg.start_ms, local_end_ms: seg.end_ms, local_now_ms: nowUtcMs, text: seg.text,
      speaker_id: seg.speaker_id, lang: seg.lang, finality: seg.finality, confidence: seg.confidence,
    });
    // L'horloge de la source est déjà UTC ici (RTMS) ou normalisée par ClockModel ; on n'ajoute que des marqueurs.
    ev.flags.push(...seg.flags, ...(seg.diar_cluster ? [`diar_cluster:${seg.diar_cluster}`] : []));
    return ev;
  }
}

export interface Quote { text: string; certain: boolean; caveat: string | null }

/** Seule porte de sortie vers le LLM / l'utilisateur : un provisoire ou un final peu fiable n'est jamais « certain ». */
export function quote(seg: Segment): Quote {
  if (seg.finality === 'provisional') return { text: seg.text, certain: false, caveat: 'transcription partielle non confirmée' };
  if (seg.flags.includes('low_confidence')) return { text: seg.text, certain: false, caveat: `transcription peu fiable (confiance ${seg.confidence.toFixed(2)})` };
  return { text: seg.text, certain: true, caveat: seg.speaker_id ? null : 'intervenant non identifié' };
}

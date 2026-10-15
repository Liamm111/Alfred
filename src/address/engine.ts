import { classify, type RuleOutput } from './rules.ts';
import { buildPrompt, parseVerdict, type LlmAddressClassifier, type LlmContextLine } from './llm.ts';
import { ALERT_OF, ENGINE_VERSION, type AddressClass, type Decision, type EngineEvent, type InSegment, type Participant, type ReasonCode, type Uncertainty, type UserProfile } from './types.ts';

export interface EngineConfig {
  relance_window_ms: number;
  cancel_window_ms: number;
  /** Un autre intervenant qui répète l'appel dans cette fenêtre est traité comme une relance. */
  cross_asker_window_ms: number;
  /** Fenêtre de contexte pour le LLM, bornée à [15 s, 60 s]. */
  context_ms: number;
  llm_timeout_ms: number;
}
export const DEFAULT_ENGINE: EngineConfig = { relance_window_ms: 45_000, cancel_window_ms: 20_000, cross_asker_window_ms: 15_000, context_ms: 30_000, llm_timeout_ms: 2_500 };

interface Question {
  id: string; asker: string | null; last_ms: number; cls: AddressClass; relances: number;
  retracted: boolean; closed: boolean; basis: 'provisional' | 'final'; confirmed: boolean;
}
interface RingLine { speaker: string; text: string; t_ms: number }

const direct = (c: AddressClass) => c === 'DIRECT_CERTAIN' || c === 'DIRECT_PROBABLE';

export class AddressEngine {
  #user: UserProfile;
  #roster: Participant[];
  #emit: (e: EngineEvent) => void;
  #cfg: EngineConfig;
  #llm: LlmAddressClassifier | undefined;
  #q = new Map<string, Question>();
  #utt = new Map<string, string>();
  #ring: RingLine[] = [];
  #n = 0;
  #pending = new Set<Promise<void>>();

  constructor(o: { user: UserProfile; roster: Participant[]; emit: (e: EngineEvent) => void; llm?: LlmAddressClassifier; config?: Partial<EngineConfig> }) {
    this.#user = o.user; this.#roster = o.roster; this.#emit = o.emit; this.#llm = o.llm;
    const c = { ...DEFAULT_ENGINE, ...o.config };
    this.#cfg = { ...c, context_ms: Math.min(60_000, Math.max(15_000, c.context_ms)) };
  }

  setRoster(r: Participant[]): void { this.#roster = r; }
  async flush(): Promise<void> { while (this.#pending.size) await Promise.all([...this.#pending]); }

  /** Synchrone et rapide (règles). L'enrichissement LLM, s'il existe, part en tâche de fond. */
  onSegment(seg: InSegment): void {
    const provisional = seg.finality === 'provisional';
    if (seg.speaker_id !== null && seg.speaker_id === this.#user.id) { this.#self(seg); return; }
    const out = classify(seg.segment_id, seg.text, { user: this.#user, roster: this.#roster, speaker_id: seg.speaker_id, stt_confidence: seg.confidence, provisional });
    const d = out.decision;
    this.#emit({ type: 'trace', decision: d, finality: seg.finality, engine_version: ENGINE_VERSION });
    const qid = this.#utt.get(seg.utterance_id);
    const q = qid ? this.#q.get(qid) : undefined;
    const live = q && !q.retracted && !q.closed ? q : undefined;

    if (provisional) {
      if (d.cls === 'DIRECT_CERTAIN') { if (!live && !q) this.#direct(seg, d, 'provisional'); }
      else if (live && live.basis === 'provisional' && !live.confirmed && !direct(d.cls)) this.#retract(live, this.#whyNot(d), seg.end_ms);
      return;
    }
    this.#ring.push({ speaker: seg.speaker_id ?? 'inconnu', text: seg.text, t_ms: seg.end_ms });
    this.#trimRing(seg.end_ms);

    if (direct(d.cls)) {
      if (live) this.#confirm(live, d, seg);
      else this.#direct(seg, d, 'final');
    } else {
      if (live && live.basis === 'provisional' && !live.confirmed) this.#retract(live, this.#whyNot(d), seg.end_ms);
      else if (out.signals.cancel || out.signals.redirect_other) {
        const open = this.#findOpen(seg.speaker_id, seg.start_ms, this.#cfg.cancel_window_ms);
        if (open) this.#retract(open, out.signals.redirect_other ? 'REDIRECTED' : 'CANCELLED', seg.end_ms);
      } else if (!out.signals.has_user_hit && out.signals.cues) {
        const open = this.#findOpen(seg.speaker_id, seg.start_ms, this.#cfg.relance_window_ms);
        if (open) { open.relances++; open.last_ms = seg.end_ms; this.#utt.set(seg.utterance_id, open.id); this.#emit({ type: 'update', question_id: open.id, what: 'relance', relances: open.relances, decision: { ...d, reasons: [...d.reasons, 'RELANCE'] }, at_ms: seg.end_ms }); }
      }
    }
    if (this.#llm && this.#shouldEnrich(d, out)) this.#startEnrich(seg, d, out);
  }

  // ---- règles ------------------------------------------------------------------------
  #self(seg: InSegment): void {
    this.#emit({ type: 'trace', decision: { segment_id: seg.segment_id, cls: 'HORS_SUJET', score: 1, reasons: ['SELF_SPEAKER'], uncertainty: [], evidence_spans: [], engine_version: ENGINE_VERSION }, finality: seg.finality, engine_version: ENGINE_VERSION });
    if (seg.finality !== 'final' || seg.text.trim() === '') return;
    this.#ring.push({ speaker: 'moi', text: seg.text, t_ms: seg.end_ms });
    for (const q of this.#q.values()) if (!q.closed && !q.retracted) { q.closed = true; this.#emit({ type: 'closed', question_id: q.id, reason: 'answered_by_user', at_ms: seg.end_ms }); }
  }

  #whyNot(d: Decision): ReasonCode { return d.reasons.includes('REDIRECTED') ? 'REDIRECTED' : d.reasons.includes('CANCELLED') ? 'CANCELLED' : 'PROVISIONAL_BASIS'; }

  #findOpen(asker: string | null, t: number, window: number): Question | undefined {
    let best: Question | undefined;
    for (const q of this.#q.values()) {
      if (q.closed || q.retracted || t < q.last_ms - 1) continue;
      const w = q.asker === asker ? window : Math.min(window, this.#cfg.cross_asker_window_ms);
      if (t - q.last_ms <= w && (!best || q.last_ms > best.last_ms)) best = q;
    }
    return best;
  }

  #direct(seg: InSegment, d: Decision, basis: 'provisional' | 'final'): void {
    const open = this.#findOpen(seg.speaker_id, seg.start_ms, this.#cfg.relance_window_ms);
    if (open) {
      open.relances++; open.last_ms = seg.end_ms; this.#utt.set(seg.utterance_id, open.id);
      const upgraded = rank(d.cls) > rank(open.cls);
      if (upgraded) open.cls = d.cls;
      this.#emit({ type: 'update', question_id: open.id, what: upgraded ? 'upgraded' : 'relance', relances: open.relances, decision: { ...d, reasons: [...d.reasons, 'RELANCE'] }, at_ms: seg.end_ms });
      return;
    }
    const q: Question = { id: `q-${++this.#n}`, asker: seg.speaker_id, last_ms: seg.end_ms, cls: d.cls, relances: 0, retracted: false, closed: false, basis, confirmed: basis === 'final' };
    this.#q.set(q.id, q); this.#utt.set(seg.utterance_id, q.id);
    this.#emit({ type: 'alert', question_id: q.id, level: ALERT_OF[d.cls], decision: basis === 'provisional' ? { ...d, reasons: [...d.reasons, 'PROVISIONAL_BASIS'] } : d, basis, evidence_ids: [seg.evidence_id], at_ms: seg.end_ms });
  }

  #confirm(q: Question, d: Decision, seg: InSegment): void {
    q.last_ms = seg.end_ms;
    const wasProvisional = !q.confirmed; q.confirmed = true;
    if (d.cls !== q.cls) { const up = rank(d.cls) > rank(q.cls); q.cls = d.cls; this.#emit({ type: 'update', question_id: q.id, what: up ? 'upgraded' : 'downgraded', relances: q.relances, decision: d, at_ms: seg.end_ms }); }
    else if (wasProvisional) this.#emit({ type: 'update', question_id: q.id, what: 'confirmed', relances: q.relances, decision: d, at_ms: seg.end_ms });
  }

  #retract(q: Question, reason: ReasonCode, at: number): void { q.retracted = true; this.#emit({ type: 'retract', question_id: q.id, reason, at_ms: at }); }

  #trimRing(now: number): void { const keep = this.#cfg.context_ms; while (this.#ring.length && now - this.#ring[0]!.t_ms > keep) this.#ring.shift(); }

  // ---- enrichissement LLM (non bloquant) ------------------------------------------
  #shouldEnrich(d: Decision, out: RuleOutput): boolean {
    if (d.reasons.includes('SELF_SPEAKER')) return false;
    return out.signals.has_user_hit || d.uncertainty.length > 0 || out.signals.cues;
  }

  #startEnrich(seg: InSegment, d: Decision, out: RuleOutput): void {
    const context: LlmContextLine[] = this.#ring.filter((l) => seg.end_ms - l.t_ms <= this.#cfg.context_ms).map((l) => ({ speaker: l.speaker, text: l.text, t_ms: l.t_ms }));
    const contextText = context.map((l) => l.text).join('\n');
    const p = this.#enrich(seg, d, out, context, contextText).catch(() => this.#unc(d, 'LLM_ERROR', seg)).finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }

  #unc(d: Decision, u: Uncertainty, seg: InSegment): void { this.#emit({ type: 'trace', decision: { ...d, uncertainty: [...new Set([...d.uncertainty, u])] }, finality: seg.finality, engine_version: ENGINE_VERSION }); }

  async #enrich(seg: InSegment, d: Decision, out: RuleOutput, context: LlmContextLine[], contextText: string): Promise<void> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => { ac.abort(); res('timeout'); }, this.#cfg.llm_timeout_ms); });
    buildPrompt({ user: this.#user, context, target_segment_id: seg.segment_id, rule_class: d.cls }); // prompt versionné avec le moteur
    const raw = await Promise.race([this.#llm!.classify({ user: this.#user, context, target_segment_id: seg.segment_id, rule_class: d.cls }, ac.signal), timeout]);
    clearTimeout(timer);
    if (raw === 'timeout') { this.#unc(d, 'LLM_TIMEOUT', seg); return; }
    const v = parseVerdict(raw, contextText);
    if (!v) { this.#unc(d, 'LLM_INVALID', seg); return; }
    const qid = this.#utt.get(seg.utterance_id);
    const q = qid ? this.#q.get(qid) : undefined;
    const live = q && !q.retracted && !q.closed ? q : undefined;
    const blocked = d.reasons.includes('CANCELLED') || d.reasons.includes('REDIRECTED');
    if (direct(v.cls)) {
      if (live) { if (v.cls === 'DIRECT_CERTAIN' && v.score >= 0.9 && live.cls === 'DIRECT_PROBABLE') { live.cls = 'DIRECT_CERTAIN'; this.#emit({ type: 'update', question_id: live.id, what: 'upgraded', relances: live.relances, decision: { ...d, cls: 'DIRECT_CERTAIN', score: v.score, reasons: [...d.reasons, 'LLM_UPGRADE'], evidence_spans: v.evidence_spans }, at_ms: seg.end_ms }); } return; }
      if (blocked || v.score < 0.8) return;
      const cls: AddressClass = out.signals.has_user_hit && v.cls === 'DIRECT_CERTAIN' && v.score >= 0.9 ? 'DIRECT_CERTAIN' : 'DIRECT_PROBABLE';
      this.#direct(seg, { ...d, cls, score: v.score, reasons: [...d.reasons, out.signals.has_user_hit ? 'LLM_UPGRADE' : 'LLM_ONLY'], evidence_spans: v.evidence_spans }, 'final');
    } else if (live && live.confirmed) {
      const need = live.cls === 'DIRECT_CERTAIN' ? 0.95 : 0.85;
      if (v.score >= need) this.#retract(live, 'LLM_DOWNGRADE', seg.end_ms);
    }
  }
}

function rank(c: AddressClass): number { return c === 'DIRECT_CERTAIN' ? 2 : c === 'DIRECT_PROBABLE' ? 1 : 0; }

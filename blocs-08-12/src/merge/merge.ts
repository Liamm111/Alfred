import type { GapSegment, Modality, NormalizedEvidence } from '../contracts/evidence.ts';
import { validateEvidence } from '../contracts/evidence.ts';
import { similarity, norm } from './text.ts';

export type RtmsStatus = 'active' | 'unavailable' | 'denied_by_policy';
export interface CapturePolicy { capture_allowed: boolean; reason?: string }

export interface MergeOptions { /** Horloge de confiance (serveur/NTP) : un événement ne peut pas finir dans le futur. */ trusted_now_ms?: () => number }
export interface MergeConfig {
  dup_overlap: number; dup_text_sim: number; audio_dup_overlap: number;
  min_gap_ms: number; future_tolerance_ms: number; drift_tolerance_ms: number; drift_min_pairs: number;
}
export const DEFAULT_MERGE: MergeConfig = { dup_overlap: 0.5, dup_text_sim: 0.8, audio_dup_overlap: 0.8, min_gap_ms: 500, future_tolerance_ms: 15_000, drift_tolerance_ms: 2_000, drift_min_pairs: 3 };

export type RejectReason = 'invalid' | 'wrong_meeting' | 'policy_blocked' | 'rtms_denied_no_fallback' | 'source_bound_elsewhere';
export type IngestResult =
  | { ok: true; status: 'accepted' | 'idempotent' | 'quarantined'; evidence_id: string }
  | { ok: false; reason: RejectReason; evidence_id: string; detail?: string };

export interface Suppressed { evidence_id: string; kept_id: string | null; reason: 'duplicate' | 'superseded_by_final' }
export interface FilledGap extends GapSegment { filled_by: string[] }
export interface SourceSwitch { at_utc_ms: number; from_source: string; to_source: string }
export interface DriftReport { source_id: string; source_epoch: number; median_delta_ms: number; pairs: number }

const rankOf = (e: NormalizedEvidence) => (e.source.kind === 'rtms' ? (e.source.attested ? 0 : 1) : 2);
const MODS_DEDUPED: Modality[] = ['transcript', 'audio'];

function canonicalCmp(a: NormalizedEvidence, b: NormalizedEvidence): number {
  return a.utc_start_ms - b.utc_start_ms || a.utc_end_ms - b.utc_end_ms || rankOf(a) - rankOf(b)
    || (a.source.source_id < b.source.source_id ? -1 : a.source.source_id > b.source.source_id ? 1 : 0)
    || a.source.source_epoch - b.source.source_epoch || a.seq - b.seq
    || (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0);
}

function overlapRatio(a: NormalizedEvidence, b: NormalizedEvidence): number {
  const inter = Math.min(a.utc_end_ms, b.utc_end_ms) - Math.max(a.utc_start_ms, b.utc_start_ms);
  const minDur = Math.min(a.utc_end_ms - a.utc_start_ms, b.utc_end_ms - b.utc_start_ms);
  if (minDur <= 0) return Math.abs(a.utc_start_ms - b.utc_start_ms) <= 1000 ? 1 : 0;
  return Math.max(0, inter) / minDur;
}

function speakerCompatible(a: NormalizedEvidence, b: NormalizedEvidence): boolean {
  if (a.speaker.status === 'verified' && b.speaker.status === 'verified') return a.speaker.speaker_id === b.speaker.speaker_id;
  return true; // inconnu : on ne peut ni confirmer ni infirmer ; texte + recouvrement décident
}

/** Fusion pour UNE réunion. La sélection est une fonction pure de l'ensemble ingéré : indépendante de l'ordre d'arrivée. */
export class MeetingMerger {
  readonly meeting_id: string;
  #cfg: MergeConfig;
  #items = new Map<string, NormalizedEvidence>();
  #quarantine = new Map<string, NormalizedEvidence>();
  #rejections: { evidence_id: string; reason: RejectReason }[] = [];
  #explicitGaps: GapSegment[] = [];
  #rtms: RtmsStatus = 'active';
  #policy: CapturePolicy = { capture_allowed: true };
  #cache: { selected: NormalizedEvidence[]; suppressed: Suppressed[] } | null = null;
  #now: (() => number) | undefined;

  constructor(meeting_id: string, cfg: Partial<MergeConfig> = {}, opts: MergeOptions = {}) { this.meeting_id = meeting_id; this.#cfg = { ...DEFAULT_MERGE, ...cfg }; this.#now = opts.trusted_now_ms; }

  setRtmsStatus(s: RtmsStatus): void { this.#rtms = s; }
  setPolicy(p: CapturePolicy): void { this.#policy = p; }
  get rtmsStatus(): RtmsStatus { return this.#rtms; }
  get rejections() { return this.#rejections as readonly { evidence_id: string; reason: RejectReason }[]; }
  reportGap(g: GapSegment): void { if (g.meeting_id === this.meeting_id) this.#explicitGaps.push(g); }

  #reject(e: NormalizedEvidence, reason: RejectReason, detail?: string): IngestResult {
    this.#rejections.push({ evidence_id: e.evidence_id, reason });
    return { ok: false, reason, evidence_id: e.evidence_id, ...(detail ? { detail } : {}) };
  }

  ingest(e: NormalizedEvidence): IngestResult {
    if (e.meeting_id !== this.meeting_id) return this.#reject(e, 'wrong_meeting', `${e.meeting_id} ≠ ${this.meeting_id}`);
    const errs = validateEvidence(e);
    if (errs.length) return this.#reject(e, 'invalid', errs.join('; '));
    // Interdiction explicite : aucune bascule vers une autre source pour la contourner.
    if (!this.#policy.capture_allowed) { this.#blockedGap(e, 'policy_blocked'); return this.#reject(e, 'policy_blocked', this.#policy.reason); }
    if (this.#rtms === 'denied_by_policy') { this.#blockedGap(e, 'policy_blocked'); return this.#reject(e, 'rtms_denied_no_fallback'); }
    if (this.#items.has(e.evidence_id) || this.#quarantine.has(e.evidence_id)) return { ok: true, status: 'idempotent', evidence_id: e.evidence_id };
    if (this.#timeSuspect(e)) {
      this.#quarantine.set(e.evidence_id, { ...e, flags: [...new Set([...e.flags, 'quarantined_clock'])] });
      return { ok: true, status: 'quarantined', evidence_id: e.evidence_id };
    }
    this.#items.set(e.evidence_id, e); this.#cache = null;
    return { ok: true, status: 'accepted', evidence_id: e.evidence_id };
  }

  #blockedGap(e: NormalizedEvidence, reason: GapSegment['reason']): void {
    this.#explicitGaps.push({ meeting_id: this.meeting_id, modality: e.modality, source_id: e.source.source_id, source_epoch: e.source.source_epoch, utc_start_ms: e.utc_start_ms, utc_end_ms: e.utc_end_ms, reason });
  }

  /** Horloge non fiable : jamais synchronisée, ou événement daté dans le futur de l'horloge de confiance. */
  #timeSuspect(e: NormalizedEvidence): boolean {
    if (e.source.kind === 'rtms') return false;
    if (e.flags.includes('clock_unsynced')) return true;
    return this.#now !== undefined && e.utc_end_ms - this.#now() > this.#cfg.future_tolerance_ms;
  }

  get quarantined(): NormalizedEvidence[] { return [...this.#quarantine.values()].sort(canonicalCmp); }

  /** Décale une source/époque (accepté + quarantaine) puis ré-évalue. Appelé après sync d'horloge ou correction de dérive. */
  rebaseSource(source_id: string, source_epoch: number, deltaMs: number): number {
    let n = 0;
    const shift = (e: NormalizedEvidence): NormalizedEvidence => ({ ...e, utc_start_ms: e.utc_start_ms + deltaMs, utc_end_ms: e.utc_end_ms + deltaMs, received_utc_ms: e.received_utc_ms + deltaMs, clock_offset_ms: e.clock_offset_ms + deltaMs, flags: [...new Set([...e.flags.filter((f) => f !== 'clock_unsynced' && f !== 'quarantined_clock'), 'rebased'])] });
    const match = (e: NormalizedEvidence) => e.source.source_id === source_id && e.source.source_epoch === source_epoch;
    const pendingQ = [...this.#quarantine.values()].filter(match);
    for (const e of [...this.#items.values()].filter(match)) { this.#items.set(e.evidence_id, shift(e)); n++; }
    for (const e of pendingQ) {
      this.#quarantine.delete(e.evidence_id);
      const moved = shift(e);
      if (this.#timeSuspect(moved)) this.#quarantine.set(moved.evidence_id, { ...moved, flags: [...moved.flags, 'quarantined_clock'] });
      else { this.#items.set(moved.evidence_id, moved); n++; }
    }
    this.#cache = null;
    return n;
  }

  /** Dérive résiduelle : paires texte quasi identique entre RTMS attesté et source locale, mais décalées dans le temps. */
  detectDrift(): DriftReport[] {
    const rtms = [...this.#items.values(), ...this.#quarantine.values()].filter((e) => e.modality === 'transcript' && e.source.kind === 'rtms' && e.source.attested && norm(e.text ?? '').length >= 15);
    const byKey = new Map<string, number[]>();
    const locals = [...this.#items.values(), ...this.#quarantine.values()].filter((e) => e.modality === 'transcript' && e.source.kind === 'mac_local' && norm(e.text ?? '').length >= 15);
    for (const l of locals) {
      let best: { d: number; s: number } | null = null;
      for (const h of rtms) {
        if (Math.abs(h.utc_start_ms - l.utc_start_ms) > 180_000) continue;
        const s = similarity(h.text ?? '', l.text ?? '');
        if (s >= 0.9 && (!best || s > best.s || (s === best.s && Math.abs(l.utc_start_ms - h.utc_start_ms) < Math.abs(best.d)))) best = { d: l.utc_start_ms - h.utc_start_ms, s };
      }
      if (best) { const k = `${l.source.source_id}|${l.source.source_epoch}`; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(best.d); }
    }
    const out: DriftReport[] = [];
    for (const [k, ds] of byKey) {
      ds.sort((a, b) => a - b);
      const med = ds[Math.floor(ds.length / 2)]!;
      if (ds.length >= this.#cfg.drift_min_pairs && Math.abs(med) > this.#cfg.drift_tolerance_ms) {
        const [source_id, ep] = k.split('|'); out.push({ source_id: source_id!, source_epoch: Number(ep), median_delta_ms: med, pairs: ds.length });
      }
    }
    return out;
  }

  // ---- sélection ---------------------------------------------------------------
  #compute() {
    if (this.#cache) return this.#cache;
    const all = [...this.#items.values()].sort(canonicalCmp);
    const suppressed: Suppressed[] = [];
    const dead = new Set<string>();
    // 1. provisoire recouvert par un final de la même source
    for (const p of all) {
      if (p.finality !== 'provisional' || p.modality === 'ocr') continue;
      const f = all.find((x) => x.finality === 'final' && x.modality === p.modality && x.source.source_id === p.source.source_id && x.evidence_id !== p.evidence_id && overlapRatio(x, p) >= 0.5);
      if (f) { dead.add(p.evidence_id); suppressed.push({ evidence_id: p.evidence_id, kept_id: f.evidence_id, reason: 'superseded_by_final' }); }
    }
    // 2. doublons inter-sources : le meilleur rang gagne
    const kept: NormalizedEvidence[] = [];
    const byRank = all.filter((e) => !dead.has(e.evidence_id)).sort((a, b) => rankOf(a) - rankOf(b) || canonicalCmp(a, b));
    const fallback = new Set<string>();
    for (const e of byRank) {
      if (!MODS_DEDUPED.includes(e.modality)) { kept.push(e); continue; }
      const hit = kept.find((k) => k.modality === e.modality && rankOf(k) < rankOf(e) && this.#isDuplicate(k, e));
      if (hit) { dead.add(e.evidence_id); suppressed.push({ evidence_id: e.evidence_id, kept_id: hit.evidence_id, reason: 'duplicate' }); }
      else { kept.push(e); if (rankOf(e) > 0 && e.source.kind === 'mac_local') fallback.add(e.evidence_id); }
    }
    const selected = kept.sort(canonicalCmp).map((e) => (fallback.has(e.evidence_id) ? { ...e, flags: [...new Set([...e.flags, 'fallback_local'])] } : e));
    return (this.#cache = { selected, suppressed });
  }

  #isDuplicate(h: NormalizedEvidence, l: NormalizedEvidence): boolean {
    if (!speakerCompatible(h, l)) return false;
    const ov = overlapRatio(h, l);
    if (h.modality === 'audio') return ov >= this.#cfg.audio_dup_overlap && (h.text && l.text ? similarity(h.text, l.text) >= this.#cfg.dup_text_sim : true);
    // Préfiltre temporel avant tout calcul de texte (coût).
    const gap = Math.max(h.utc_start_ms, l.utc_start_ms) - Math.min(h.utc_end_ms, l.utc_end_ms);
    if (ov <= 0 && gap > 1000) return false;
    const sim = similarity(h.text ?? '', l.text ?? '');
    if (ov >= this.#cfg.dup_overlap && sim >= this.#cfg.dup_text_sim) return true;
    // Segmentations différentes d'un même énoncé : recouvrement partiel / quasi contigu mais texte quasi identique.
    return sim >= 0.95;
  }

  timeline(): NormalizedEvidence[] { return this.#compute().selected; }
  get suppressed(): Suppressed[] { return this.#compute().suppressed; }

  // ---- trous ------------------------------------------------------------------
  gaps(): { open: GapSegment[]; filled: FilledGap[] } {
    const raw: GapSegment[] = [...this.#explicitGaps];
    const groups = new Map<string, NormalizedEvidence[]>();
    for (const e of this.#items.values()) { const k = `${e.source.source_id}|${e.modality}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
    for (const items of groups.values()) {
      const byEpoch = new Map<number, NormalizedEvidence[]>();
      for (const e of items) (byEpoch.get(e.source.source_epoch) ?? byEpoch.set(e.source.source_epoch, []).get(e.source.source_epoch)!).push(e);
      const epochs = [...byEpoch.keys()].sort((a, b) => a - b);
      for (let i = 1; i < epochs.length; i++) {
        const prev = byEpoch.get(epochs[i - 1]!)!, next = byEpoch.get(epochs[i]!)!;
        const s = Math.max(...prev.map((e) => e.utc_end_ms)), t = Math.min(...next.map((e) => e.utc_start_ms));
        if (t - s >= this.#cfg.min_gap_ms) raw.push({ meeting_id: this.meeting_id, modality: next[0]!.modality, source_id: next[0]!.source.source_id, source_epoch: epochs[i]!, utc_start_ms: s, utc_end_ms: t, reason: 'reconnect' });
      }
    }
    const sel = this.timeline();
    const open: GapSegment[] = [], filled: FilledGap[] = [];
    for (const g of raw.sort((a, b) => a.utc_start_ms - b.utc_start_ms)) {
      // Une source est « remplacée » seulement par une AUTRE source de même modalité (OCR : jamais comblé).
      const cover = g.modality === 'ocr' ? [] : sel.filter((e) => e.modality === g.modality && e.source.source_id !== g.source_id && e.utc_end_ms > g.utc_start_ms && e.utc_start_ms < g.utc_end_ms);
      if (g.reason === 'policy_blocked') { open.push(g); continue; } // jamais présenté comme comblé
      let cursor = g.utc_start_ms;
      const ivs = cover.map((e) => [Math.max(e.utc_start_ms, g.utc_start_ms), Math.min(e.utc_end_ms, g.utc_end_ms)] as const).sort((a, b) => a[0] - b[0]);
      const filledIvs: [number, number][] = [];
      for (const [s, t] of ivs) {
        if (s - cursor >= this.#cfg.min_gap_ms) open.push({ ...g, utc_start_ms: cursor, utc_end_ms: s });
        if (t > s) filledIvs.push([Math.max(s, cursor), t]);
        cursor = Math.max(cursor, t);
      }
      if (g.utc_end_ms - cursor >= this.#cfg.min_gap_ms) open.push({ ...g, utc_start_ms: cursor, utc_end_ms: g.utc_end_ms });
      for (const [s, t] of filledIvs) if (t > s) filled.push({ ...g, utc_start_ms: s, utc_end_ms: t, filled_by: cover.map((c) => c.evidence_id) });
    }
    return { open, filled };
  }

  /** Fenêtre de lecture (ex. une question de l'intervenant) : items, trous, bascules de source, complétude. */
  window(from: number, to: number) {
    const items = this.timeline().filter((e) => e.modality !== 'ocr' && e.utc_end_ms > from && e.utc_start_ms < to);
    const g = this.gaps();
    const overlaps = (x: GapSegment) => x.utc_end_ms > from && x.utc_start_ms < to;
    const switches: SourceSwitch[] = [];
    for (let i = 1; i < items.length; i++) if (items[i]!.source.source_id !== items[i - 1]!.source.source_id) switches.push({ at_utc_ms: items[i]!.utc_start_ms, from_source: items[i - 1]!.source.source_id, to_source: items[i]!.source.source_id });
    const open = g.open.filter(overlaps);
    // Une evidence en quarantaine n'a pas de position temporelle fiable : elle peut appartenir à n'importe quelle fenêtre.
    const q = this.quarantined.filter((e) => e.modality !== 'ocr').length;
    return { items, open_gaps: open, filled_gaps: g.filled.filter(overlaps), source_switches: switches, quarantined_overlapping: q, complete: open.length === 0 && q === 0 };
  }
}

/** Routage multi-réunions : une réunion = un merger, aucune donnée ne passe de l'un à l'autre. */
export class MergeHub {
  #m = new Map<string, MeetingMerger>();
  #bound = new Map<string, string>();
  #cfg: Partial<MergeConfig>;
  constructor(cfg: Partial<MergeConfig> = {}, opts: MergeOptions = {}) { this.#cfg = cfg; this.#opts = opts; }
  #opts: MergeOptions;

  merger(meeting_id: string): MeetingMerger { return this.#m.get(meeting_id) ?? this.#m.set(meeting_id, new MeetingMerger(meeting_id, this.#cfg, this.#opts)).get(meeting_id)!; }
  bindSource(source_id: string, meeting_id: string): void { this.#bound.set(source_id, meeting_id); }
  close(meeting_id: string): void { this.#m.delete(meeting_id); for (const [s, m] of this.#bound) if (m === meeting_id) this.#bound.delete(s); }

  ingest(e: NormalizedEvidence): IngestResult {
    const b = this.#bound.get(e.source.source_id);
    if (b === undefined) this.#bound.set(e.source.source_id, e.meeting_id);
    else if (b !== e.meeting_id) {
      return { ok: false, reason: 'source_bound_elsewhere', evidence_id: e.evidence_id, detail: `${e.source.source_id} lié à ${b}` };
    }
    return this.merger(e.meeting_id).ingest(e);
  }
}

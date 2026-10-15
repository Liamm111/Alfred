import { evidenceId, type GapSegment, type NormalizedEvidence } from '../contracts/evidence.ts';
import { ClockModel } from '../merge/timebase.ts';
import { fillRect, frameHash, intersect, newGray, type Gray, type Rect } from './image.ts';
import { assessReadability, type OcrEngine } from './ocr.ts';
import { scoreFrame } from './quality.ts';
import { FrameSampler, type SamplerConfig, type SampleDecision } from './sampler.ts';
import { SlideTracker, type SlideAnswer, type SlideConfig, type UnavailableReason } from './slides.ts';
import { FrameStore } from './store.ts';
import { evaluatePick, WindowTracker, ZOOM_BUNDLE_IDS, type PickDecision, type PickedContent, type PickRole, type WindowEvent, type WindowInfo } from './windows.ts';

export type Frame =
  | { kind: 'window'; window_id: number; image: Gray }
  | { kind: 'display'; display_id: number; image: Gray };

export interface FrameResult {
  window_id: number;
  decision: SampleDecision | { action: 'dropped'; reason: UnavailableReason | 'not_selected' };
  evidence?: NormalizedEvidence;
}

export interface VisionOptions {
  meeting_id: string;
  source_id?: string;
  ocr: OcrEngine;
  clock?: ClockModel;
  sampler?: Partial<SamplerConfig>;
  slides?: Partial<SlideConfig>;
  store?: FrameStore;
}

interface Track { role: PickRole; sampler: FrameSampler; slides: SlideTracker; occluded: boolean }

const MAX_OCCLUSION = 0.5;

export class VisionPipeline {
  readonly evidence: NormalizedEvidence[] = [];
  readonly gaps: GapSegment[] = [];
  readonly audit: { rejected_non_zoom: number; ocr_calls: number; frames_seen: number } = { rejected_non_zoom: 0, ocr_calls: 0, frames_seen: 0 };

  #o: VisionOptions;
  #clock: ClockModel;
  #store: FrameStore;
  #tracker = new WindowTracker();
  #tracks = new Map<number, Track>();
  #displayMode: number | null = null;
  #granted = true;
  #epoch = 1;
  #seq = 0;
  #open = new Map<number, { start: number; reason: GapSegment['reason'] }>();

  constructor(o: VisionOptions) {
    this.#o = o;
    this.#clock = o.clock ?? new ClockModel();
    this.#store = o.store ?? new FrameStore();
  }

  get epoch(): number { return this.#epoch; }
  get store(): FrameStore { return this.#store; }

  /** Résultat du SCContentSharingPicker. Le contenu non-Zoom est refusé avant toute capture. */
  applyPick(picked: PickedContent): PickDecision {
    const d = evaluatePick(picked);
    this.audit.rejected_non_zoom += d.rejected.length;
    this.#displayMode = d.display_mode ? picked.display_id : null;
    this.#tracker.select(d.accepted.map((a) => a.window_id));
    for (const a of d.accepted) this.#ensureTrack(a.window_id, a.role);
    return d;
  }

  #ensureTrack(id: number, role: PickRole): Track {
    let t = this.#tracks.get(id);
    if (!t) { t = { role, sampler: new FrameSampler(this.#o.sampler), slides: new SlideTracker(this.#o.slides), occluded: false }; t.slides.block('window_gone'); this.#tracks.set(id, t); }
    return t;
  }

  setPermission(granted: boolean, localMs: number): void {
    if (granted === this.#granted) return;
    this.#granted = granted;
    const utc = this.#clock.toUtc(localMs);
    if (!granted) {
      for (const [id, t] of this.#tracks) { t.slides.block('permission_revoked'); this.#openGap(id, utc, 'permission_revoked'); t.sampler.reset(); }
      this.#store.purgeAll(); // la révocation efface aussi les images conservées
    } else {
      this.#epoch++; this.#seq = 0; // nouvelle époque de source : seq repart de zéro
      for (const [id, t] of this.#tracks) { this.#closeGap(id, utc); t.sampler.forceNext(); if (this.#tracker.stateOf(id) === 'visible') t.slides.unblock(); }
    }
  }

  onWindowSnapshot(windows: WindowInfo[], localMs: number): WindowEvent[] {
    const utc = this.#clock.toUtc(localMs);
    if (this.#displayMode !== null) {
      // Plein écran : toute fenêtre Zoom du display devient suivable ; le non-Zoom n'est jamais suivi.
      const ids = windows.filter((w) => ZOOM_BUNDLE_IDS.has(w.bundle_id) && w.display_id === this.#displayMode).map((w) => w.window_id);
      this.#tracker.select(ids);
      for (const w of windows) if (ids.includes(w.window_id)) this.#ensureTrack(w.window_id, /screen|écran|share|partage/i.test(w.title) ? 'shared_screen' : 'zoom_meeting');
    }
    const events = this.#tracker.update(windows, utc);
    for (const e of events) {
      const t = this.#tracks.get(e.window_id);
      if (!t) continue;
      if (e.type === 'disappeared') { t.slides.block('window_gone'); this.#openGap(e.window_id, utc, 'not_visible'); }
      else if (e.type === 'state_changed') {
        if (e.to === 'visible') { this.#closeGap(e.window_id, utc); t.sampler.forceNext(); if (this.#granted) t.slides.unblock(); }
        else { t.slides.block(e.to === 'minimized' ? 'minimized' : 'other_space'); this.#openGap(e.window_id, utc, 'not_visible'); }
      } else if (e.type === 'appeared') { if (this.#tracker.stateOf(e.window_id) === 'visible' && this.#granted) { t.slides.unblock(); t.sampler.forceNext(); } }
      else if (e.type === 'moved_display') t.sampler.forceNext();
    }
    return events;
  }

  /** Une image livrée par la couche native. Retourne ce qui a été fait ; jamais de rétention hors store. */
  onFrame(frame: Frame, windows: WindowInfo[], localMs: number): FrameResult[] {
    this.audit.frames_seen++;
    if (!this.#granted) return [{ window_id: -1, decision: { action: 'dropped', reason: 'permission_revoked' } }];
    if (frame.kind === 'window') return [this.#processWindow(frame.window_id, frame.image, 0, localMs)];
    if (this.#displayMode !== frame.display_id) return [{ window_id: -1, decision: { action: 'dropped', reason: 'not_selected' } }];
    const results: FrameResult[] = [];
    const zoom = windows.filter((w) => ZOOM_BUNDLE_IDS.has(w.bundle_id) && w.display_id === frame.display_id && this.#tracker.stateOf(w.window_id) === 'visible');
    for (const w of zoom) {
      const occluders = windows.filter((o) => !ZOOM_BUNDLE_IDS.has(o.bundle_id) && o.display_id === w.display_id && o.on_screen && !o.minimized && o.layer > w.layer);
      const { img, masked } = cropMasked(frame.image, w.frame, occluders.map((o) => o.frame));
      results.push(this.#processWindow(w.window_id, img, masked, localMs));
    }
    return results;
  }

  #processWindow(id: number, img: Gray, maskedRatio: number, localMs: number): FrameResult {
    const t = this.#tracks.get(id);
    const utc = this.#clock.toUtc(localMs);
    if (!t || !this.#tracker.selectedIds.includes(id)) return { window_id: id, decision: { action: 'dropped', reason: 'not_selected' } };
    if (this.#tracker.stateOf(id) !== 'visible') return { window_id: id, decision: { action: 'dropped', reason: this.#tracker.stateOf(id) === 'minimized' ? 'minimized' : 'other_space' } };
    if (maskedRatio > MAX_OCCLUSION) { t.occluded = true; t.slides.block('occluded'); return { window_id: id, decision: { action: 'dropped', reason: 'occluded' } }; }
    if (t.occluded) { t.occluded = false; t.slides.unblock(); t.sampler.forceNext(); }

    const decision = t.sampler.decide(img, localMs);
    if (decision.action === 'unchanged') { t.slides.confirm(utc); return { window_id: id, decision }; }
    if (decision.action === 'skip_rate') return { window_id: id, decision };

    const hash = frameHash(img);
    const quality = scoreFrame(img, maskedRatio);
    const lines = this.#o.ocr.recognize(img);
    this.audit.ocr_calls++;
    const rep = assessReadability(lines);
    this.#store.put(hash, img, localMs);

    const text = rep.level === 'illegible' ? '' : rep.usable.map((l) => l.text).join('\n');
    const ev: NormalizedEvidence = {
      evidence_id: evidenceId(this.#o.meeting_id, this.#o.source_id ?? 'mac-vision', this.#epoch, ++this.#seq, 'ocr'),
      meeting_id: this.#o.meeting_id,
      modality: 'ocr',
      source: { kind: 'mac_local', source_id: this.#o.source_id ?? 'mac-vision', source_epoch: this.#epoch, health: 'healthy', freshness_ms: 0, attested: false },
      seq: this.#seq, utc_start_ms: utc, utc_end_ms: utc, media_start_ms: null, media_end_ms: null,
      received_utc_ms: utc, clock_offset_ms: this.#clock.offsetMs,
      speaker: { status: 'unknown' }, text, lang: 'unknown', finality: 'final',
      confidence: rep.level === 'illegible' ? 0 : rep.mean_confidence,
      frame: { frame_hash: hash, quality_score: quality.score, window_id: id },
      flags: [`readability:${rep.level}`, `trigger:${decision.reason}`, ...(rep.dropped_tiny ? [`tiny_lines:${rep.dropped_tiny}`] : []), ...(rep.dropped_low_confidence ? [`low_conf_lines:${rep.dropped_low_confidence}`] : [])],
    };
    this.evidence.push(ev);
    if (rep.level === 'illegible') t.slides.observeIllegible();
    else t.slides.observe(text, rep.level === 'partial', utc, ev.evidence_id);
    return { window_id: id, decision, evidence: ev };
  }

  /** Réponse « quelle diapositive ? » : préfère la fenêtre de partage, sinon fenêtre de réunion. Jamais d'invention. */
  currentSlide(localMs: number): SlideAnswer {
    const utc = this.#clock.toUtc(localMs);
    const order: PickRole[] = ['shared_screen', 'zoom_meeting'];
    let firstUnavailable: SlideAnswer | null = null;
    for (const role of order) {
      for (const t of this.#tracks.values()) {
        if (t.role !== role) continue;
        const a = t.slides.current(utc);
        if (a.status === 'available') return a;
        firstUnavailable ??= a;
      }
    }
    return firstUnavailable ?? { status: 'unavailable', reason: 'no_share', last_slide_id: null, message: 'Diapositive indisponible : aucun écran partagé détecté.' };
  }

  finalize(localMs: number): void {
    const utc = this.#clock.toUtc(localMs);
    for (const id of [...this.#open.keys()]) this.#closeGap(id, utc);
    this.#store.purgeAll();
  }

  #openGap(id: number, utc: number, reason: GapSegment['reason']): void { if (!this.#open.has(id)) this.#open.set(id, { start: utc, reason }); }
  #closeGap(id: number, utc: number): void {
    const g = this.#open.get(id); if (!g) return;
    this.#open.delete(id);
    this.gaps.push({ meeting_id: this.#o.meeting_id, modality: 'ocr', source_id: this.#o.source_id ?? 'mac-vision', source_epoch: this.#epoch, utc_start_ms: g.start, utc_end_ms: utc, reason: g.reason });
  }
}

/** Découpe la fenêtre Zoom dans l'image du display et noircit tout ce qu'un autre processus recouvre. */
export function cropMasked(display: Gray, zoom: Rect, occluders: Rect[]): { img: Gray; masked: number } {
  const out = newGray(zoom.w, zoom.h, 0);
  for (let y = 0; y < zoom.h; y++) for (let x = 0; x < zoom.w; x++) {
    const sx = zoom.x + x, sy = zoom.y + y;
    if (sx >= 0 && sx < display.width && sy >= 0 && sy < display.height) out.data[y * zoom.w + x] = display.data[sy * display.width + sx]!;
  }
  let masked = 0;
  const seen = new Uint8Array(zoom.w * zoom.h);
  for (const o of occluders) {
    const i = intersect(zoom, o);
    if (!i) continue;
    const local = { x: i.x - zoom.x, y: i.y - zoom.y, w: i.w, h: i.h };
    fillRect(out, local, 0);
    for (let y = local.y; y < local.y + local.h; y++) for (let x = local.x; x < local.x + local.w; x++) if (!seen[y * zoom.w + x]) { seen[y * zoom.w + x] = 1; masked++; }
  }
  return { img: out, masked: masked / (zoom.w * zoom.h) };
}

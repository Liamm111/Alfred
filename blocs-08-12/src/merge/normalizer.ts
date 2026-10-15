import { evidenceId, type Finality, type Health, type Modality, type NormalizedEvidence, type SourceKind, type SpeakerRef } from '../contracts/evidence.ts';
import type { ClockModel, MediaTimebase } from './timebase.ts';

export interface RawEvent {
  modality: Modality;
  /** Horloge LOCALE de la source (pas encore UTC). */
  local_start_ms: number;
  local_end_ms: number;
  local_now_ms: number;
  media_start_ms?: number | null;
  media_end_ms?: number | null;
  text?: string | null;
  speaker_id?: string | null;
  lang?: NormalizedEvidence['lang'];
  finality?: Finality;
  confidence?: number;
  frame?: NormalizedEvidence['frame'];
}

/** Adapte une source (RTMS ou Mac) vers le contrat unique. Une instance = une source ; `reconnect()` ouvre une époque. */
export class SourceNormalizer {
  readonly meeting_id: string;
  readonly source_id: string;
  readonly kind: SourceKind;
  readonly attested: boolean;
  #clock: ClockModel;
  #epoch = 1;
  #seq = 0;
  health: Health = 'healthy';
  media: MediaTimebase | null = null;

  constructor(o: { meeting_id: string; source_id: string; kind: SourceKind; attested?: boolean; clock: ClockModel }) {
    this.meeting_id = o.meeting_id; this.source_id = o.source_id; this.kind = o.kind;
    this.attested = o.kind === 'rtms' && (o.attested ?? false); this.#clock = o.clock;
  }

  get epoch(): number { return this.#epoch; }
  reconnect(): void { this.#epoch++; this.#seq = 0; }

  normalize(r: RawEvent): NormalizedEvidence {
    const seq = ++this.#seq;
    const speaker: SpeakerRef = this.kind === 'rtms' && r.speaker_id ? { status: 'verified', speaker_id: r.speaker_id, origin: 'rtms' } : { status: 'unknown' };
    const flags: string[] = [];
    if (!this.#clock.synced) flags.push('clock_unsynced');
    const utcS = this.#clock.toUtc(r.local_start_ms), utcE = this.#clock.toUtc(r.local_end_ms);
    return {
      evidence_id: evidenceId(this.meeting_id, this.source_id, this.#epoch, seq, r.modality),
      meeting_id: this.meeting_id, modality: r.modality,
      source: { kind: this.kind, source_id: this.source_id, source_epoch: this.#epoch, health: this.health, freshness_ms: Math.max(0, r.local_now_ms - r.local_end_ms), attested: this.attested },
      seq,
      utc_start_ms: utcS, utc_end_ms: utcE,
      media_start_ms: r.media_start_ms ?? (this.media ? this.media.toMedia(utcS) : null), media_end_ms: r.media_end_ms ?? (this.media ? this.media.toMedia(utcE) : null),
      received_utc_ms: this.#clock.toUtc(r.local_now_ms), clock_offset_ms: this.#clock.offsetMs,
      speaker, text: r.text ?? (r.modality === 'audio' ? null : ''), lang: r.lang ?? 'unknown',
      finality: r.finality ?? 'final', confidence: r.confidence ?? 1, ...(r.frame ? { frame: r.frame } : {}), flags,
    };
  }
}

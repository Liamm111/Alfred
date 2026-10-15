// Contrat unique audio / transcript / OCR (BLOC 09). Toute source (RTMS, Mac local)
// doit produire des NormalizedEvidence ; rien d'autre n'entre dans la fusion.

export type Modality = 'audio' | 'transcript' | 'ocr';
export type SourceKind = 'rtms' | 'mac_local';
export type Health = 'healthy' | 'degraded' | 'down';
export type Finality = 'provisional' | 'final';

export interface SourceInfo {
  kind: SourceKind;
  source_id: string;
  /** Incrémenté à chaque (re)connexion de la source : seq n'est unique qu'au sein d'une époque. */
  source_epoch: number;
  health: Health;
  /** Âge (ms) de la dernière donnée au moment de l'émission. */
  freshness_ms: number;
  /** RTMS : flux attesté (signature / handshake vérifié). Toujours false pour mac_local. */
  attested: boolean;
}

export type SpeakerRef =
  | { status: 'verified'; speaker_id: string; origin: 'rtms' }
  | { status: 'unknown' };

export interface NormalizedEvidence {
  evidence_id: string;
  meeting_id: string;
  modality: Modality;
  source: SourceInfo;
  seq: number;
  /** Temps événement normalisé en UTC (ms epoch), après correction d'horloge. */
  utc_start_ms: number;
  utc_end_ms: number;
  /** Timebase média de la réunion (ms depuis le début de la réunion), si connue. */
  media_start_ms: number | null;
  media_end_ms: number | null;
  received_utc_ms: number;
  /** Décalage appliqué à l'horloge de la source pour obtenir l'UTC (traçabilité). */
  clock_offset_ms: number;
  speaker: SpeakerRef;
  text: string | null;
  lang: 'fr' | 'en' | 'mixed' | 'unknown';
  finality: Finality;
  confidence: number;
  /** OCR / frame uniquement. */
  frame?: { frame_hash: string; quality_score: number; window_id: number };
  /** Marqueurs de fusion : fallback local utilisé à la place d'un trou RTMS, horloge suspecte, etc. */
  flags: string[];
}

export interface GapSegment {
  meeting_id: string;
  modality: Modality;
  source_id: string;
  source_epoch: number;
  utc_start_ms: number;
  utc_end_ms: number;
  reason: 'reconnect' | 'source_down' | 'dropped_by_buffer' | 'not_visible' | 'permission_revoked' | 'policy_blocked';
}

export function evidenceId(meeting: string, sourceId: string, epoch: number, seq: number, modality: Modality): string {
  return `${meeting}:${sourceId}:${epoch}:${modality}:${seq}`;
}

export function validateEvidence(e: NormalizedEvidence): string[] {
  const errs: string[] = [];
  if (!e.meeting_id) errs.push('meeting_id manquant');
  if (!(e.utc_end_ms >= e.utc_start_ms)) errs.push('utc_end < utc_start');
  if (!(e.confidence >= 0 && e.confidence <= 1)) errs.push('confidence hors [0,1]');
  if (e.source.kind === 'mac_local' && e.source.attested) errs.push('mac_local ne peut pas être attesté');
  if (e.speaker.status === 'verified' && e.source.kind !== 'rtms') errs.push('speaker vérifié sans source RTMS');
  if (e.modality !== 'audio' && e.text === null) errs.push('texte requis pour transcript/ocr');
  if (e.modality === 'ocr' && !e.frame) errs.push('frame requis pour ocr');
  return errs;
}

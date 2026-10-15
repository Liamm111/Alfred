export const ENGINE_VERSION = '11.0.0';
export const ENGINE_GUARANTEE = 'Meilleur effort : aucune garantie de détecter toutes les sollicitations ; chaque décision porte sa trace d\'incertitude.';

export type AddressClass = 'DIRECT_CERTAIN' | 'DIRECT_PROBABLE' | 'MENTION_SIMPLE' | 'GROUPE' | 'HORS_SUJET';
export type AlertLevel = 'urgent' | 'normal' | 'none';

export const ALERT_OF: Record<AddressClass, AlertLevel> = { DIRECT_CERTAIN: 'urgent', DIRECT_PROBABLE: 'normal', MENTION_SIMPLE: 'none', GROUPE: 'none', HORS_SUJET: 'none' };

export interface Participant { id: string; first: string; last?: string }

export interface UserProfile {
  id: string;
  first: string;
  last?: string;
  /** Variantes de graphie/prononciation connues (« Lyam »). */
  aliases: string[];
}

export interface InSegment {
  segment_id: string;
  utterance_id: string;
  evidence_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker_id: string | null;
  finality: 'provisional' | 'final';
  confidence: number;
}

export type ReasonCode =
  | 'VOCATIVE' | 'IMPERATIVE_OR_QUESTION' | 'SECOND_PERSON' | 'QUESTION_MARK' | 'NAME_EXACT' | 'NAME_ALIAS' | 'NAME_PHONETIC'
  | 'THIRD_PERSON_MENTION' | 'POSSESSIVE_MENTION' | 'PREPOSITION_MENTION' | 'INDIRECT_REQUEST' | 'GROUP_MARKER' | 'MULTI_ADDRESSEE'
  | 'AMBIGUOUS_NAME' | 'OTHER_PARTICIPANT_NAMED' | 'CANCELLED' | 'REDIRECTED' | 'SELF_SPEAKER' | 'NO_NAME' | 'RELANCE'
  | 'LOW_STT_CONFIDENCE' | 'PROVISIONAL_BASIS' | 'UNCLASSIFIED_MENTION' | 'GRATITUDE' | 'GREETING' | 'REPORTED_SPEECH' | 'HANDOVER' | 'LLM_UPGRADE' | 'LLM_DOWNGRADE' | 'LLM_ONLY';

export type Uncertainty = 'PHONETIC_ONLY' | 'AMBIGUOUS_NAME' | 'LOW_STT_CONFIDENCE' | 'PROVISIONAL_TEXT' | 'UNNAMED_SECOND_PERSON' | 'UNCLASSIFIED_MENTION' | 'GRATITUDE' | 'GREETING' | 'REPORTED_SPEECH' | 'HANDOVER' | 'LLM_TIMEOUT' | 'LLM_INVALID' | 'LLM_ERROR';

export interface Decision {
  segment_id: string;
  cls: AddressClass;
  score: number;
  reasons: ReasonCode[];
  uncertainty: Uncertainty[];
  /** Extraits exacts du texte qui justifient la décision. */
  evidence_spans: string[];
  engine_version: string;
}

export type EngineEvent =
  | { type: 'alert'; question_id: string; level: AlertLevel; decision: Decision; basis: 'provisional' | 'final'; evidence_ids: string[]; at_ms: number }
  | { type: 'update'; question_id: string; what: 'relance' | 'confirmed' | 'upgraded' | 'downgraded'; relances: number; decision: Decision; at_ms: number }
  | { type: 'retract'; question_id: string; reason: ReasonCode; at_ms: number }
  | { type: 'closed'; question_id: string; reason: 'answered_by_user'; at_ms: number }
  | { type: 'trace'; decision: Decision; finality: 'provisional' | 'final'; engine_version: string };

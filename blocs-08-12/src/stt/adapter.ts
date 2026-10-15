import type { Word } from './segmenter.ts';

/** Événement brut d'un moteur STT (RTMS natif ou STT audio). Tous les moteurs parlent ce même langage. */
export interface SttEvent {
  kind: 'hypothesis' | 'final';
  utterance_id: string;
  /** Croissant au sein d'un énoncé ; un final porte la révision la plus haute. */
  revision: number;
  start_ms: number; // UTC
  end_ms: number;
  text: string;
  words?: Word[];
  lang?: 'fr' | 'en' | 'mixed' | 'unknown';
  confidence: number;
  /** Identité fournie par RTMS uniquement. Un moteur audio local ne peut pas en fournir. */
  speaker_id?: string | null;
  /** Cluster de diarisation locale (S1, S2…) : ce n'est PAS une identité. */
  diar_cluster?: string;
  /** Instant UTC d'émission par le moteur (pour la latence). */
  emitted_utc_ms: number;
}

export interface SttAdapter {
  readonly id: string;
  readonly kind: 'rtms_native' | 'audio_stt';
  readonly languages: readonly string[];
  /** Abonnement aux événements. Retourne la fonction de désabonnement. */
  onEvent(cb: (e: SttEvent) => void): () => void;
}

export interface ProviderHealth {
  rtms_transcript_available: boolean;
  rtms_languages: readonly string[];
  /** Part de la parole détectée couverte par la transcription RTMS (fenêtre récente). */
  rtms_coverage: number;
  rtms_final_latency_p95_ms: number | null;
  local_stt_available: boolean;
  capture_allowed: boolean;
}

export type Provider = 'rtms_native' | 'audio_stt' | 'none';
export interface ProviderDecision { provider: Provider; reasons: string[] }

export const PROVIDER_LIMITS = { min_coverage: 0.95, max_final_latency_ms: 4_000, required_languages: ['fr', 'en'] as const, switch_after: 3 };

/** Choix du moteur : RTMS natif s'il suffit (FR+EN, couverture, latence), sinon STT audio local. Hystérésis anti-bascule. */
export class ProviderSelector {
  #current: Provider = 'none';
  #pending: { to: Provider; n: number } | null = null;

  evaluate(h: ProviderHealth): ProviderDecision {
    const raw = this.#raw(h);
    if (raw.provider === 'none' && !h.capture_allowed) { this.#current = 'none'; this.#pending = null; return raw; } // interdiction : immédiat
    if (this.#current === 'none' && !this.#pending) { this.#current = raw.provider; return raw; }
    if (raw.provider === this.#current) { this.#pending = null; return raw; }
    this.#pending = this.#pending && this.#pending.to === raw.provider ? { to: raw.provider, n: this.#pending.n + 1 } : { to: raw.provider, n: 1 };
    if (this.#pending.n >= PROVIDER_LIMITS.switch_after) { this.#current = raw.provider; this.#pending = null; return raw; }
    return { provider: this.#current, reasons: [...raw.reasons, `bascule vers ${raw.provider} en attente (${this.#pending.n}/${PROVIDER_LIMITS.switch_after})`] };
  }

  #raw(h: ProviderHealth): ProviderDecision {
    const reasons: string[] = [];
    if (!h.capture_allowed) return { provider: 'none', reasons: ['capture interdite : aucune transcription, aucun contournement'] };
    const langOk = PROVIDER_LIMITS.required_languages.every((l) => h.rtms_languages.includes(l));
    if (!h.rtms_transcript_available) reasons.push('transcription RTMS indisponible');
    else {
      if (!langOk) reasons.push('RTMS ne couvre pas FR+EN');
      if (h.rtms_coverage < PROVIDER_LIMITS.min_coverage) reasons.push(`couverture RTMS ${h.rtms_coverage.toFixed(2)} < ${PROVIDER_LIMITS.min_coverage}`);
      if (h.rtms_final_latency_p95_ms !== null && h.rtms_final_latency_p95_ms > PROVIDER_LIMITS.max_final_latency_ms) reasons.push(`latence RTMS p95 ${h.rtms_final_latency_p95_ms} ms > budget`);
    }
    if (h.rtms_transcript_available && reasons.length === 0) return { provider: 'rtms_native', reasons: ['RTMS suffisant'] };
    if (h.local_stt_available) return { provider: 'audio_stt', reasons };
    return { provider: 'none', reasons: [...reasons, 'aucun moteur STT utilisable : transcription indisponible'] };
  }
}

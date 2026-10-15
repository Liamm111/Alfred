import { dHash, hamming, type Gray } from './image.ts';

/** Plafond dur : jamais plus de 2 images/s, quelle que soit la config (pas de vidéo continue). */
export const HARD_MIN_INTERVAL_MS = 500;

export interface SamplerConfig {
  min_interval_ms: number;
  /** Distance de Hamming (sur 64 bits) au-delà de laquelle le contenu est jugé changé. */
  change_threshold: number;
  /** Re-vérification forcée même sans changement (sert de heartbeat de fraîcheur). */
  heartbeat_ms: number;
}

export const DEFAULT_SAMPLER: SamplerConfig = { min_interval_ms: 1_000, change_threshold: 4, heartbeat_ms: 10_000 };

export type SampleDecision =
  | { action: 'process'; reason: 'first' | 'changed' | 'heartbeat' | 'forced'; distance: number }
  | { action: 'skip_rate' }
  | { action: 'unchanged'; distance: number };

export class FrameSampler {
  #cfg: SamplerConfig;
  #lastTick = -Infinity;
  #lastProcessed = -Infinity;
  #lastHash: bigint | null = null;
  #forceNext = false;

  constructor(cfg: Partial<SamplerConfig> = {}) {
    const c = { ...DEFAULT_SAMPLER, ...cfg };
    this.#cfg = { ...c, min_interval_ms: Math.max(HARD_MIN_INTERVAL_MS, c.min_interval_ms) };
  }

  get config(): Readonly<SamplerConfig> { return this.#cfg; }
  /** À appeler après un changement d'état fenêtre / reprise de permission. */
  forceNext(): void { this.#forceNext = true; }
  reset(): void { this.#lastHash = null; this.#lastTick = -Infinity; this.#lastProcessed = -Infinity; }

  decide(img: Gray, nowMs: number): SampleDecision {
    if (nowMs - this.#lastTick < this.#cfg.min_interval_ms) return { action: 'skip_rate' };
    this.#lastTick = nowMs;
    const h = dHash(img);
    if (this.#lastHash === null) return this.#accept(h, nowMs, 'first', 64);
    const distance = hamming(h, this.#lastHash);
    if (this.#forceNext) return this.#accept(h, nowMs, 'forced', distance);
    if (distance >= this.#cfg.change_threshold) return this.#accept(h, nowMs, 'changed', distance);
    if (nowMs - this.#lastProcessed >= this.#cfg.heartbeat_ms) return this.#accept(h, nowMs, 'heartbeat', distance);
    return { action: 'unchanged', distance };
  }

  #accept(h: bigint, nowMs: number, reason: 'first' | 'changed' | 'heartbeat' | 'forced', distance: number): SampleDecision {
    this.#lastHash = h; this.#lastProcessed = nowMs; this.#forceNext = false;
    return { action: 'process', reason, distance };
  }
}

import type { Modality } from "./schemas.js";

export interface ModalityThresholds {
  /** A modality counts as live while `now.mono - last_fresh_packet.received_mono <= fresh_ms`. */
  fresh_ms: number;
  /** A packet older than this when processed (queueing delay on the receiver) cannot prove liveness. */
  max_packet_age_ms: number;
  /** A packet captured longer ago than this (receiver wall - source ts) cannot prove liveness. */
  max_source_lag_ms: number;
}

export interface Thresholds {
  modality: Record<Modality, ModalityThresholds>;
  /** source_ts may not be this far in the future compared with receiver wall clock. */
  max_future_skew_ms: number;
  /** CONNECTING / RECOVERING without media for this long raises connected_without_media if a callback was seen. */
  connect_warn_ms: number;
  /** CONNECTING without media for this long -> FAILED. */
  connect_timeout_ms: number;
  /** DEGRADED for this long -> request_recovery effect. */
  degraded_recovery_after_ms: number;
  /** RECOVERING without media for this long -> FINALIZING(fatal). */
  recovery_timeout_ms: number;
  /** FINALIZING for this long without FINALIZED -> outcome is forced. */
  finalize_timeout_ms: number;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  modality: {
    audio: { fresh_ms: 3_000, max_packet_age_ms: 5_000, max_source_lag_ms: 10_000 },
    video: { fresh_ms: 5_000, max_packet_age_ms: 8_000, max_source_lag_ms: 15_000 },
    transcript: { fresh_ms: 15_000, max_packet_age_ms: 20_000, max_source_lag_ms: 30_000 },
  },
  max_future_skew_ms: 5_000,
  connect_warn_ms: 8_000,
  connect_timeout_ms: 20_000,
  degraded_recovery_after_ms: 10_000,
  recovery_timeout_ms: 30_000,
  finalize_timeout_ms: 30_000,
});

export function isFresh(
  lastFreshMono: number | null,
  nowMono: number,
  modality: Modality,
  t: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  if (lastFreshMono === null) return false;
  const age = nowMono - lastFreshMono;
  // age < 0 means the monotonic clock went backwards or a bogus value was stored: fail closed.
  return age >= 0 && age <= t.modality[modality].fresh_ms;
}

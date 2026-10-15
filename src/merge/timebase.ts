// Modèle d'horloge : convertit l'horloge locale d'une source en UTC serveur.
// Échantillon type NTP : offset = server - (send+recv)/2, on garde le meilleur RTT.

export interface ClockSample { local_send_ms: number; server_ms: number; local_recv_ms: number }

export class ClockModel {
  #best: { offset: number; rtt: number } | null = null;
  #samples: ClockSample[] = [];
  readonly maxSamples: number;
  constructor(maxSamples = 8) { this.maxSamples = maxSamples; }

  addSample(s: ClockSample): void {
    this.#samples.push(s);
    if (this.#samples.length > this.maxSamples) this.#samples.shift();
    let best: { offset: number; rtt: number } | null = null;
    for (const x of this.#samples) {
      const rtt = x.local_recv_ms - x.local_send_ms;
      if (rtt < 0) continue;
      const offset = x.server_ms - (x.local_send_ms + x.local_recv_ms) / 2;
      if (!best || rtt < best.rtt) best = { offset, rtt };
    }
    this.#best = best;
  }

  get synced(): boolean { return this.#best !== null; }
  get offsetMs(): number { return this.#best ? Math.round(this.#best.offset) : 0; }
  /** Incertitude (± ms) : moitié du meilleur RTT ; Infinity si jamais synchronisé. */
  get uncertaintyMs(): number { return this.#best ? this.#best.rtt / 2 : Infinity; }
  toUtc(localMs: number): number { return localMs + this.offsetMs; }
}

/** Un événement dont l'UTC normalisé est trop loin de sa réception trahit une horloge fausse. */
export function clockSkewSuspect(utcEndMs: number, receivedUtcMs: number, toleranceMs = 15_000, maxLatencyMs = 120_000): boolean {
  const lead = utcEndMs - receivedUtcMs; // événement « dans le futur »
  const lag = receivedUtcMs - utcEndMs; // événement très ancien (hors rattrapage connu)
  return lead > toleranceMs || lag > maxLatencyMs;
}

/** Timebase média : ms depuis le début de la réunion, ancrée sur un instant UTC de référence (début RTMS attesté). */
export class MediaTimebase {
  readonly anchorUtcMs: number;
  constructor(anchorUtcMs: number) { this.anchorUtcMs = anchorUtcMs; }
  toMedia(utcMs: number): number { return utcMs - this.anchorUtcMs; }
  toUtc(mediaMs: number): number { return mediaMs + this.anchorUtcMs; }
}

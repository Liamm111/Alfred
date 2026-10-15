export interface LatencyBudget { first_hypothesis_ms: number; final_ms: number }
export const DEFAULT_BUDGET: LatencyBudget = { first_hypothesis_ms: 1_500, final_ms: 4_000 };

export class LatencyStats {
  #v: number[] = [];
  add(ms: number): void { this.#v.push(ms); }
  get count(): number { return this.#v.length; }
  percentile(p: number): number | null {
    if (!this.#v.length) return null;
    const s = [...this.#v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  }
}

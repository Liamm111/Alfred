// Exponential backoff with "full jitter": delay = random(0, min(max, base * factor^attempt)).
export function computeBackoff(attempt, { baseMs = 500, maxMs = 30_000, factor = 2, rng = Math.random } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('attempt must be a non-negative integer');
  const ceiling = Math.min(maxMs, baseMs * factor ** attempt);
  return Math.floor(rng() * ceiling);
}

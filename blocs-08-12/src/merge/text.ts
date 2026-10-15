export function norm(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}

/** Coefficient de Dice sur bigrammes de caractères, tolérant aux petites divergences STT. */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0, sa = 0, sb = 0;
  for (const [g, n] of A) { sa += n; const m = B.get(g); if (m) inter += Math.min(n, m); }
  for (const n of B.values()) sb += n;
  return (2 * inter) / (sa + sb);
}

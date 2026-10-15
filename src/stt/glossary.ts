import { norm } from '../merge/text.ts';

/** Clé phonétique grossière FR/EN : suffisante pour rapprocher « Lyam » de « Liam », pas pour deviner des mots. */
export function phoneticKey(w: string): string {
  let s = norm(w).replace(/\s/g, '');
  s = s.replace(/ph/g, 'f').replace(/qu|ck|k|c(?=[aouàâ])/g, 'k').replace(/v/g, 'f').replace(/y/g, 'i').replace(/ee|ie/g, 'i').replace(/ou|oo/g, 'u').replace(/(.)\1+/g, '$1').replace(/[hrse](?=$)/g, '');
  return s.replace(/[aeiou]+/g, (m) => (m.length > 1 ? m[0]! : m));
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

export interface GlossaryResult { text: string; corrections: { from: string; to: string }[] }

/** Corrige uniquement vers des termes du glossaire (noms de participants, terminologie du cours), jamais ailleurs. */
export class Glossary {
  #terms: { canonical: string; key: string; norm: string }[];
  constructor(terms: string[]) { this.#terms = terms.map((t) => ({ canonical: t, key: phoneticKey(t), norm: norm(t) })); }

  apply(text: string): GlossaryResult {
    const corrections: { from: string; to: string }[] = [];
    const out = text.replace(/[\p{L}\p{N}'’-]+/gu, (tok) => {
      const n = norm(tok);
      if (n.length < 4) return tok;
      for (const t of this.#terms) {
        if (n === t.norm) return tok === t.canonical ? tok : (corrections.push({ from: tok, to: t.canonical }), t.canonical);
        if (phoneticKey(tok) === t.key && lev(n, t.norm) <= 2 && n[0] === t.norm[0]) { corrections.push({ from: tok, to: t.canonical }); return t.canonical; }
      }
      return tok;
    });
    return { text: out, corrections };
  }
}

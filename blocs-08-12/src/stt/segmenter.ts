export interface Word { w: string; start_ms: number; end_ms: number }
export interface Piece { text: string; start_ms: number; end_ms: number; reason: 'sentence' | 'pause' | 'max_len' | 'whole' }

export interface SegmenterConfig { pause_ms: number; max_segment_ms: number; min_words_to_stand_alone: number }
export const DEFAULT_SEG: SegmenterConfig = { pause_ms: 2_000, max_segment_ms: 20_000, min_words_to_stand_alone: 3 };

const ABBR = /(?:\b(?:M|Mme|Mlle|Dr|Pr|Prof|Mr|Mrs|St|etc|cf|vs|env|n°|fig|ex)|\b(?:e\.g|i\.e))\.$/i;

/** Découpe en phrases (FR/EN). Ne coupe pas sur décimales (3.14), abréviations (Dr. Martin), ni sur « ... » interne. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  const t = text.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!; cur += ch;
    if (!'.!?…'.includes(ch)) continue;
    const next = t[i + 1], after = t[i + 2];
    if (next !== undefined && '.!?…'.includes(next)) continue; // ponctuation multiple : couper au dernier
    if (ch === '.' && next !== undefined && /\d/.test(next) && /\d$/.test(cur.slice(0, -1))) continue; // décimale
    if (ch === '.' && ABBR.test(cur)) continue;
    if (next === undefined) { out.push(cur.trim()); cur = ''; continue; }
    if (next === ' ' && after !== undefined && /[\p{Lu}\d«"¿¡(]/u.test(after)) { out.push(cur.trim()); cur = ''; }
    else if (next === ' ' && after !== undefined && ch !== '.') { out.push(cur.trim()); cur = ''; } // ?/! suivi de minuscule : coupe quand même
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Répartit les bornes temporelles : mots horodatés si disponibles, sinon proportion de caractères (approximation signalée). */
export function segment(text: string, start_ms: number, end_ms: number, words?: Word[], cfg: Partial<SegmenterConfig> = {}): Piece[] {
  const c = { ...DEFAULT_SEG, ...cfg };
  if (words && words.length) return segmentByWords(words, c);
  const sents = splitSentences(text);
  const total = sents.reduce((s, x) => s + x.length, 0) || 1;
  let acc = 0; const pieces: Piece[] = [];
  for (const s of sents) {
    const a = start_ms + Math.round(((end_ms - start_ms) * acc) / total); acc += s.length;
    const b = start_ms + Math.round(((end_ms - start_ms) * acc) / total);
    pieces.push({ text: s, start_ms: a, end_ms: b, reason: sents.length === 1 ? 'whole' : 'sentence' });
  }
  return mergeShort(pieces, c);
}

function segmentByWords(words: Word[], c: SegmenterConfig): Piece[] {
  const pieces: Piece[] = [];
  let buf: Word[] = [];
  const flush = (r: Piece['reason']) => {
    if (!buf.length) return;
    pieces.push({ text: buf.map((x) => x.w).join(' ').replace(/\s+([,.;:!?…])/g, '$1'), start_ms: buf[0]!.start_ms, end_ms: buf.at(-1)!.end_ms, reason: r });
    buf = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!, prev = buf.at(-1);
    if (prev && w.start_ms - prev.end_ms >= c.pause_ms) flush('pause');
    else if (prev && w.end_ms - buf[0]!.start_ms > c.max_segment_ms) flush('max_len');
    buf.push(w);
    if (/[.!?…]$/.test(w.w) && !ABBR.test(w.w) && !/\d\.$/.test(w.w) && i < words.length - 1) flush('sentence');
  }
  flush(pieces.length === 0 ? 'whole' : 'sentence');
  return mergeShort(pieces, c);
}

/** Fragments trop courts (« Oui. ») recollés au voisin SEULEMENT si aucune pause longue ne les sépare. */
function mergeShort(p: Piece[], c: SegmenterConfig): Piece[] {
  const out: Piece[] = [];
  for (const x of p) {
    const prev = out.at(-1);
    const short = x.text.split(/\s+/).length < c.min_words_to_stand_alone;
    if (prev && short && x.start_ms - prev.end_ms < c.pause_ms && x.end_ms - prev.start_ms <= c.max_segment_ms && x.reason !== 'pause') {
      prev.text += ' ' + x.text; prev.end_ms = x.end_ms;
    } else out.push({ ...x });
  }
  return out;
}

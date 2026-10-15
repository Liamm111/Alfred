// Police bitmap 5x7 + rendu + OCR « jouet » de test. Ce n'est PAS l'OCR de prod (Apple Vision) :
// il sert à faire réagir flou / texte minuscule / faible contraste à de VRAIS pixels dans les tests.
import { boxBlur, contrast, newGray, type Gray, type Rect } from '../../src/vision/image.ts';
import type { OcrEngine, OcrLine } from '../../src/vision/ocr.ts';

const G: Record<string, string> = {
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#', B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.', D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####', F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.', H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.', J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#', L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#', N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.', P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#', R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.', T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.', V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#', X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..', Z: '#####/....#/...#./..#../.#.../#..../#####',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.', '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####', '3': '####./....#/....#/.###./....#/....#/####.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.', '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.', '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.', '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  ' ': '...../...../...../...../...../...../.....',
};
const GL = Object.entries(G).map(([ch, s]) => ({ ch, bits: s.split('/').join('').split('').map((c) => (c === '#' ? 1 : 0)) }));

export interface DrawnLine { text: string; x: number; y: number; scale: number }

export function renderLines(img: Gray, lines: DrawnLine[], ink = 20): void {
  for (const l of lines) {
    [...l.text.toUpperCase()].forEach((ch, i) => {
      const g = G[ch] ?? G[' ']!;
      g.split('/').forEach((row, r) => [...row].forEach((c, col) => {
        if (c !== '#') return;
        for (let dy = 0; dy < l.scale; dy++) for (let dx = 0; dx < l.scale; dx++) {
          const x = l.x + i * 6 * l.scale + col * l.scale + dx, y = l.y + r * l.scale + dy;
          if (x < img.width && y < img.height) img.data[y * img.width + x] = ink;
        }
      }));
    });
  }
}

export function slideImage(lines: string[], opts: { w?: number; h?: number; scale?: number; bg?: number; ink?: number } = {}): Gray {
  const { w = 640, h = 360, scale = 4, bg = 240, ink = 20 } = opts;
  const img = newGray(w, h, bg);
  renderLines(img, lines.map((t, i) => ({ text: t, x: 16, y: 16 + i * 10 * scale, scale })), ink);
  return img;
}

export const blur = boxBlur;

export class ToyOcr implements OcrEngine {
  recognize(img: Gray): OcrLine[] {
    const c = contrast(img);
    let lo = 255, hi = 0;
    for (const v of img.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 25) return [];
    const thr = (lo + hi) / 2;
    const ink = (x: number, y: number) => img.data[y * img.width + x]! < thr;
    const rowHas = (y: number) => { for (let x = 0; x < img.width; x++) if (ink(x, y)) return true; return false; };
    const out: OcrLine[] = [];
    let y = 0;
    while (y < img.height) {
      if (!rowHas(y)) { y++; continue; }
      let y2 = y; while (y2 < img.height && rowHas(y2)) y2++;
      const hb = y2 - y;
      const s = Math.max(1, Math.round(hb / 7));
      let minX = img.width, maxX = 0;
      for (let yy = y; yy < y2; yy++) for (let x = 0; x < img.width; x++) if (ink(x, yy)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
      let best = { text: '', dist: Infinity, n: 1 };
      for (let off = 0; off <= s; off++) {
        const x0 = Math.max(0, minX - off);
        const n = Math.ceil((maxX - x0 + 1) / (6 * s));
        let text = '', dist = 0;
        for (let i = 0; i < n; i++) {
          const bits: number[] = [];
          for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) {
            const sx = Math.min(img.width - 1, Math.round(x0 + i * 6 * s + (col + 0.5) * s)), sy = Math.min(img.height - 1, Math.round(y + (r + 0.5) * s * (hb / (7 * s))));
            bits.push(ink(sx, sy) ? 1 : 0);
          }
          let bd = 99, bc = ' ';
          for (const g of GL) { let d = 0; for (let k = 0; k < 35; k++) if (g.bits[k] !== bits[k]) d++; if (d < bd) { bd = d; bc = g.ch; } }
          text += bc; dist += bd;
        }
        if (dist / n < best.dist / best.n) best = { text, dist, n };
      }
      const perChar = best.dist / best.n;
      const conf = Math.max(0, 1 - perChar / 6) * Math.min(1, c / 0.5);
      out.push({ text: best.text.trim(), confidence: conf, bbox: { x: minX, y, w: maxX - minX + 1, h: hb } as Rect });
      y = y2;
    }
    return out;
  }
}

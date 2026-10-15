import { createHash } from 'node:crypto';

export interface Gray { width: number; height: number; data: Uint8Array }

export function newGray(width: number, height: number, fill = 255): Gray {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

export function frameHash(img: Gray): string {
  return createHash('sha256').update(`${img.width}x${img.height}:`).update(img.data).digest('hex');
}

/** dHash 64 bits : résiste au bruit de compression, sensible aux changements de contenu. */
export function dHash(img: Gray): bigint {
  const W = 9, H = 8;
  const small = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * img.height) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * img.width) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / W));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += img.data[yy * img.width + xx]!; n++; }
      small[y * W + x] = sum / n;
    }
  }
  let h = 0n;
  for (let y = 0; y < H; y++) for (let x = 0; x < 8; x++) {
    h = (h << 1n) | (small[y * W + x]! > small[y * W + x + 1]! ? 1n : 0n);
  }
  return h;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** Variance du laplacien : proxy de netteté (faible = flou). */
export function laplacianVariance(img: Gray): number {
  const { width: w, height: h, data: d } = img;
  if (w < 3 || h < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = 4 * d[i]! - d[i - 1]! - d[i + 1]! - d[i - w]! - d[i + w]!;
    sum += v; sumSq += v * v; n++;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Étendue de luminance (p99.8 - p0.2) / 255 : le texte est peu dense, il faut des percentiles extrêmes. */
export function contrast(img: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of img.data) hist[v]!++;
  const total = img.data.length;
  const pct = (p: number) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]!; if (acc >= p * total) return i; } return 255; };
  return (pct(0.998) - pct(0.002)) / 255;
}

export function boxBlur(img: Gray, radius: number): Gray {
  const out = newGray(img.width, img.height, 0);
  const { width: w, height: h } = img;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += img.data[yy * w + xx]!; n++; }
    }
    out.data[y * w + x] = Math.round(s / n);
  }
  return out;
}

export interface Rect { x: number; y: number; w: number; h: number }

export function fillRect(img: Gray, r: Rect, value: number): void {
  for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.h); y++)
    for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.w); x++) img.data[y * img.width + x] = value;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

import type { Gray } from './image.ts';
import type { OcrEngine, OcrLine } from './ocr.ts';
import type { WindowInfo } from './windows.ts';

// Protocole NDJSON produit par mac/Sources/AlfredMac (Protocol.swift). Entrée non fiable : on valide tout.
export type NativeMessage =
  | { type: 'permission'; granted: boolean; reason: string }
  | { type: 'snapshot'; local_ms: number; windows: WindowInfo[] }
  | { type: 'frame'; local_ms: number; image: Gray; ocr: OcrLine[] };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const MAX_PIXELS = 8192 * 8192;

export function parseNativeLine(line: string): NativeMessage {
  const m = JSON.parse(line) as Record<string, unknown>;
  if (m.type === 'permission' && typeof m.granted === 'boolean') return { type: 'permission', granted: m.granted, reason: String(m.reason ?? '') };
  if (m.type === 'snapshot' && isNum(m.local_ms) && Array.isArray(m.windows)) return { type: 'snapshot', local_ms: m.local_ms, windows: m.windows as WindowInfo[] };
  if (m.type === 'frame' && isNum(m.local_ms) && isNum(m.width) && isNum(m.height) && typeof m.gray_b64 === 'string' && Array.isArray(m.ocr)) {
    if (m.width <= 0 || m.height <= 0 || m.width * m.height > MAX_PIXELS) throw new Error('dimensions invalides');
    const data = Buffer.from(m.gray_b64, 'base64');
    if (data.length !== m.width * m.height) throw new Error('taille de buffer incohérente');
    return { type: 'frame', local_ms: m.local_ms, image: { width: m.width, height: m.height, data: new Uint8Array(data) }, ocr: m.ocr as OcrLine[] };
  }
  throw new Error('message natif inconnu');
}

/** OCR déjà effectué côté Swift (Vision) : le pipeline TS ne refait pas d'OCR. */
export class PrecomputedOcr implements OcrEngine {
  #next: OcrLine[] = [];
  set(lines: OcrLine[]): void { this.#next = lines; }
  recognize(): OcrLine[] { return this.#next; }
}

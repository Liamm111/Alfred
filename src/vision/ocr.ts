import type { Gray, Rect } from './image.ts';

export interface OcrLine { text: string; confidence: number; bbox: Rect }

/** Adaptateur OCR. Impl. de prod : Apple Vision (mac/VisionOCR.swift). Tests : voir tests/support. */
export interface OcrEngine { recognize(img: Gray): OcrLine[] }

export const MIN_LINE_HEIGHT_PX = 9;
export const MIN_LINE_CONFIDENCE = 0.5;

export type Readability = 'good' | 'partial' | 'illegible';

export interface ReadabilityReport {
  level: Readability;
  usable: OcrLine[];
  dropped_low_confidence: number;
  dropped_tiny: number;
  mean_confidence: number;
}

export function assessReadability(lines: OcrLine[]): ReadabilityReport {
  const usable: OcrLine[] = [];
  let lowConf = 0, tiny = 0;
  for (const l of lines) {
    if (l.text.trim() === '') continue;
    if (l.bbox.h < MIN_LINE_HEIGHT_PX) { tiny++; continue; }
    if (l.confidence < MIN_LINE_CONFIDENCE) { lowConf++; continue; }
    usable.push(l);
  }
  const total = usable.length + lowConf + tiny;
  const mean = usable.length ? usable.reduce((s, l) => s + l.confidence, 0) / usable.length : 0;
  let level: Readability;
  if (total === 0 || usable.length === 0) level = 'illegible';
  else if (usable.length / total >= 0.8 && mean >= 0.7) level = 'good';
  else if (usable.length / total >= 0.4) level = 'partial';
  else level = 'illegible';
  return { level, usable, dropped_low_confidence: lowConf, dropped_tiny: tiny, mean_confidence: mean };
}

export function normalizeText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

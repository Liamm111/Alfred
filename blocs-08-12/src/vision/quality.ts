import { contrast, laplacianVariance, type Gray } from './image.ts';

export interface FrameQuality {
  sharpness: number; // variance laplacien brute
  contrast: number; // 0..1
  masked_ratio: number; // part de pixels exclus (non-Zoom / occultés)
  score: number; // 0..1
}

/** Variance laplacienne à partir de laquelle on considère l'image nette (texte rendu à l'écran). */
const SHARP_REF = 2000;

export function scoreFrame(img: Gray, maskedRatio = 0): FrameQuality {
  const sharpness = laplacianVariance(img);
  const c = contrast(img);
  const sharpNorm = sharpness / (sharpness + SHARP_REF);
  const score = Math.max(0, Math.min(1, (0.55 * sharpNorm * 2 + 0.45 * c) * (1 - maskedRatio)));
  return { sharpness, contrast: c, masked_ratio: maskedRatio, score: Math.min(1, score) };
}

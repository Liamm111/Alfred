import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blur, slideImage, ToyOcr } from './support/font.ts';
import { assessReadability } from '../src/vision/ocr.ts';
import { scoreFrame } from '../src/vision/quality.ts';

const ocr = new ToyOcr();
const LINES = ['PLAN DU COURS', 'ETAPE 1 ANALYSE', 'ETAPE 2 SYNTHESE'];

test('OCR net : texte lisible, qualité élevée', () => {
  const img = slideImage(LINES, { scale: 4 });
  const rep = assessReadability(ocr.recognize(img));
  assert.equal(rep.level, 'good');
  assert.deepEqual(rep.usable.map((l) => l.text), LINES);
  assert.ok(scoreFrame(img).score > 0.6, `score=${scoreFrame(img).score}`);
});

test('texte minuscule (≈7 px de haut) : écarté comme trop petit, jamais inventé', () => {
  const img = slideImage(LINES, { scale: 1 });
  const rep = assessReadability(ocr.recognize(img));
  assert.equal(rep.level, 'illegible');
  assert.equal(rep.usable.length, 0);
  assert.ok(rep.dropped_tiny >= 1);
});

test('flou fort : qualité chute et lecture déclarée illisible/partielle (pas de texte confiant faux)', () => {
  const sharp = slideImage(LINES, { scale: 4 });
  const blurred = blur(sharp, 6);
  assert.ok(scoreFrame(blurred).score < scoreFrame(sharp).score * 0.6);
  const rep = assessReadability(ocr.recognize(blurred));
  assert.notEqual(rep.level, 'good');
  for (const l of rep.usable) assert.ok(LINES.includes(l.text) || l.confidence < 0.8, `ligne fausse confiante: ${l.text}`);
});

test('faible contraste : pas de texte retourné', () => {
  const img = slideImage(LINES, { scale: 4, bg: 128, ink: 120 });
  assert.equal(assessReadability(ocr.recognize(img)).level, 'illegible');
});

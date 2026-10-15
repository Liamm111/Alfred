import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slideImage, ToyOcr, renderLines } from './support/font.ts';
import { VisionPipeline, type Frame } from '../src/vision/pipeline.ts';
import { FrameStore, MAX_FRAME_TTL_MS } from '../src/vision/store.ts';
import { HARD_MIN_INTERVAL_MS, FrameSampler } from '../src/vision/sampler.ts';
import { newGray } from '../src/vision/image.ts';
import { validateEvidence } from '../src/contracts/evidence.ts';
import type { WindowInfo } from '../src/vision/windows.ts';

const Z = 'us.zoom.xos';
const win = (id: number, o: Partial<WindowInfo> = {}): WindowInfo => ({ window_id: id, bundle_id: Z, title: 'Zoom Meeting', display_id: 1, on_screen: true, minimized: false, layer: 1, frame: { x: 0, y: 0, w: 640, h: 360 }, ...o });
const share = (id: number, o: Partial<WindowInfo> = {}) => win(id, { title: "Prof's screen share", ...o });
const mk = (opts: Record<string, unknown> = {}) => new VisionPipeline({ meeting_id: 'm1', ocr: new ToyOcr(), ...opts } as never);
const wf = (id: number, lines: string[]): Frame => ({ kind: 'window', window_id: id, image: slideImage(lines) });

const S1 = ['INTRODUCTION', 'OBJECTIFS DU COURS'];
const S2 = ['CHAPITRE 2', 'EXEMPLES ET CAS PRATIQUES'];

function start(p: VisionPipeline, w = share(10)) {
  p.applyPick({ windows: [w], display_id: null });
  p.onWindowSnapshot([w], 0);
}

test('slides avec changements : détecte chaque changement, ignore les frames identiques', () => {
  const p = mk(); start(p);
  const ws = [share(10)];
  let r = p.onFrame(wf(10, S1), ws, 0)[0]!;
  assert.equal(r.decision.action, 'process');
  assert.equal(p.currentSlide(500).status, 'available');
  r = p.onFrame(wf(10, S1), ws, 1500)[0]!;
  assert.equal(r.decision.action, 'unchanged'); // pas d'OCR inutile
  assert.equal(p.audit.ocr_calls, 1);
  r = p.onFrame(wf(10, S2), ws, 3000)[0]!;
  assert.equal(r.decision.action, 'process');
  const a = p.currentSlide(3100);
  assert.equal(a.status, 'available');
  if (a.status === 'available') { assert.match(a.text, /CHAPITRE 2/); assert.equal(a.slide_id, 'slide-2'); }
  assert.equal(p.evidence.length, 2);
  for (const e of p.evidence) assert.deepEqual(validateEvidence(e), []);
});

test('Zoom minimisé → « indisponible », jamais l’ancienne diapo ; retour visible → recapture forcée', () => {
  const p = mk(); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  p.onWindowSnapshot([share(10, { minimized: true })], 5000);
  const a = p.currentSlide(5100);
  assert.equal(a.status, 'unavailable');
  if (a.status === 'unavailable') { assert.equal(a.reason, 'minimized'); assert.match(a.message, /indisponible/); }
  const dropped = p.onFrame(wf(10, S1), [share(10, { minimized: true })], 6000)[0]!;
  assert.equal(dropped.decision.action, 'dropped');
  p.onWindowSnapshot([share(10)], 9000);
  assert.equal(p.currentSlide(9100).status, 'unavailable'); // pas encore revu → pas de supposition
  p.onFrame(wf(10, S2), [share(10)], 9500);
  assert.equal(p.currentSlide(9600).status, 'available');
  assert.equal(p.gaps.length, 1);
  assert.equal(p.gaps[0]!.reason, 'not_visible');
  assert.equal(p.gaps[0]!.utc_end_ms - p.gaps[0]!.utc_start_ms, 4000);
});

test('Zoom caché / autre Space → indisponible', () => {
  const p = mk(); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  p.onWindowSnapshot([share(10, { on_screen: false })], 3000);
  const a = p.currentSlide(3100);
  assert.ok(a.status === 'unavailable' && a.reason === 'other_space');
});

test('fenêtre disparue puis réapparue : événements + indisponible entre-temps', () => {
  const p = mk(); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  const ev1 = p.onWindowSnapshot([], 2000);
  assert.deepEqual(ev1.map((e) => e.type), ['disappeared']);
  assert.ok(p.currentSlide(2100).status === 'unavailable');
  const ev2 = p.onWindowSnapshot([share(10)], 4000);
  assert.deepEqual(ev2.map((e) => e.type), ['appeared']);
});

test('deuxième écran : déplacement détecté, capture continue après recapture forcée', () => {
  const p = mk(); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  const ev = p.onWindowSnapshot([share(10, { display_id: 2 })], 2000);
  assert.deepEqual(ev.map((e) => e.type), ['moved_display']);
  const r = p.onFrame(wf(10, S1), [share(10, { display_id: 2 })], 3000)[0]!;
  assert.equal(r.decision.action, 'process'); // forcée malgré contenu identique
  assert.equal(p.currentSlide(3100).status, 'available');
});

test('multi-fenêtre : la fenêtre de partage fait foi ; si elle disparaît, on retombe sur la fenêtre de réunion', () => {
  const p = mk();
  const meet = win(11), sh = share(10);
  p.applyPick({ windows: [meet, sh], display_id: null });
  p.onWindowSnapshot([meet, sh], 0);
  p.onFrame(wf(11, ['VUE REUNION GALERIE']), [meet, sh], 0);
  p.onFrame(wf(10, S1), [meet, sh], 0);
  const a = p.currentSlide(100);
  assert.ok(a.status === 'available' && /INTRODUCTION/.test(a.text));
  p.onWindowSnapshot([meet], 2000);
  const b = p.currentSlide(2100);
  assert.ok(b.status === 'available' && /GALERIE/.test(b.text)); // contenu de la vue réunion, signalé par son slide_id distinct
});

test('contenu non-Zoom exclu : sélection refusée avant capture', () => {
  const p = mk();
  const d = p.applyPick({ windows: [win(20, { bundle_id: 'com.apple.Safari', title: 'Banque' }), share(10)], display_id: null });
  assert.deepEqual(d.rejected, [{ window_id: 20, reason: 'not_zoom' }]);
  assert.equal(d.accepted.length, 1);
  p.onWindowSnapshot([share(10)], 0);
  const r = p.onFrame({ kind: 'window', window_id: 20, image: slideImage(['MOT DE PASSE 1234']) }, [], 0)[0]!;
  assert.equal(r.decision.action, 'dropped');
  assert.equal(p.audit.ocr_calls, 0);
  assert.ok(!JSON.stringify(p.evidence).includes('MOT DE PASSE'));
});

test('partage plein écran : seuls les pixels Zoom sont OCRisés, le non-Zoom qui recouvre est noirci', () => {
  const p = mk();
  p.applyPick({ windows: [], display_id: 1 });
  const zoom = share(10, { frame: { x: 0, y: 0, w: 640, h: 360 }, layer: 1 });
  const secret = win(30, { bundle_id: 'com.apple.mail', title: 'Mail', layer: 5, frame: { x: 0, y: 200, w: 640, h: 160 } });
  const ws = [zoom, secret];
  p.onWindowSnapshot(ws, 0);
  const screen = newGray(1280, 720, 240);
  renderLines(screen, [{ text: 'DIAPO PUBLIQUE', x: 16, y: 16, scale: 4 }, { text: 'SECRET PERSO', x: 16, y: 230, scale: 4 }]);
  const r = p.onFrame({ kind: 'display', display_id: 1, image: screen }, ws, 0);
  assert.equal(r.length, 1);
  const text = p.evidence.map((e) => e.text).join('\n');
  assert.match(text, /DIAPO PUBLIQUE/);
  assert.ok(!text.includes('SECRET'), 'le contenu non-Zoom ne doit jamais apparaître');
  // Fenêtre non-Zoom seule sur le display (Zoom absent) : rien n'est capturé.
  const p2 = mk(); p2.applyPick({ windows: [], display_id: 1 });
  p2.onWindowSnapshot([secret], 0);
  assert.equal(p2.onFrame({ kind: 'display', display_id: 1, image: screen }, [secret], 0).length, 0);
  assert.equal(p2.audit.ocr_calls, 0);
});

test('plein écran : Zoom presque entièrement recouvert → occluded, indisponible', () => {
  const p = mk();
  p.applyPick({ windows: [], display_id: 1 });
  const zoom = share(10), cover = win(31, { bundle_id: 'com.apple.Terminal', layer: 9, frame: { x: 0, y: 0, w: 640, h: 300 } });
  p.onWindowSnapshot([zoom, cover], 0);
  const screen = newGray(1280, 720, 240);
  renderLines(screen, [{ text: 'TOP SECRET', x: 16, y: 16, scale: 4 }]);
  p.onFrame({ kind: 'display', display_id: 1, image: screen }, [zoom, cover], 0);
  const a = p.currentSlide(100);
  assert.ok(a.status === 'unavailable' && a.reason === 'occluded');
  assert.equal(p.audit.ocr_calls, 0);
});

test('permission retirée : arrêt immédiat, images purgées, trou tracé, frames natives ignorées, reprise = nouvelle époque', () => {
  const store = new FrameStore({ enabled: true, ttl_ms: 60_000 });
  const p = mk({ store }); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  assert.equal(store.count, 1);
  p.setPermission(false, 4000);
  assert.equal(store.count, 0);
  const a = p.currentSlide(4100);
  assert.ok(a.status === 'unavailable' && a.reason === 'permission_revoked');
  const r = p.onFrame(wf(10, S2), [share(10)], 5000)[0]!;
  assert.equal(r.decision.action, 'dropped');
  assert.equal(p.audit.ocr_calls, 1);
  p.setPermission(true, 8000);
  assert.equal(p.epoch, 2);
  assert.equal(p.currentSlide(8100).status, 'unavailable'); // pas de reprise implicite de l'ancienne diapo
  p.onFrame(wf(10, S2), [share(10)], 8500);
  assert.equal(p.evidence.at(-1)!.source.source_epoch, 2);
  assert.equal(p.evidence.at(-1)!.seq, 1);
  const g = p.gaps.find((x) => x.reason === 'permission_revoked')!;
  assert.equal(g.utc_end_ms - g.utc_start_ms, 4000);
});

test('texte illisible après une diapo lisible : on ne ressert pas l’ancien contenu', () => {
  const p = mk(); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  p.onFrame({ kind: 'window', window_id: 10, image: slideImage(S2, { scale: 1 }) }, [share(10)], 3000);
  const a = p.currentSlide(3100);
  assert.ok(a.status === 'unavailable' && a.reason === 'illegible');
});

test('fraîcheur : sans confirmation récente → stale ; heartbeat sur frame inchangée maintient disponible', () => {
  const p = mk({ slides: { stale_after_ms: 20_000 } }); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  for (let t = 2000; t <= 30_000; t += 2000) p.onFrame(wf(10, S1), [share(10)], t);
  assert.equal(p.currentSlide(30_500).status, 'available');
  assert.ok(p.audit.ocr_calls < 6, `OCR appelé ${p.audit.ocr_calls} fois sur 15 frames identiques`);
  const a = p.currentSlide(80_000);
  assert.ok(a.status === 'unavailable' && a.reason === 'stale');
});

test('pas de vidéo continue : cadence plafonnée et aucune image conservée par défaut', () => {
  const s = new FrameSampler({ min_interval_ms: 10 });
  assert.equal(s.config.min_interval_ms, HARD_MIN_INTERVAL_MS);
  const img = slideImage(S1); let processed = 0;
  for (let t = 0; t < 10_000; t += 33) if (s.decide(img, t).action === 'process') processed++; // 30 fps offert
  assert.ok(processed <= 2, `traité ${processed}`);
  const p = mk(); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  assert.equal(p.store.count, 0);
  assert.equal(p.store.enabled, false);
});

test('persistance facultative : TTL court appliqué, plafond refusé, fichiers réellement supprimés', () => {
  assert.throws(() => new FrameStore({ enabled: true, ttl_ms: MAX_FRAME_TTL_MS + 1 }));
  const dir = mkdtempSync(join(tmpdir(), 'frames-'));
  const store = new FrameStore({ enabled: true, ttl_ms: 5_000, dir });
  const p = mk({ store }); start(p);
  p.onFrame(wf(10, S1), [share(10)], 0);
  assert.equal(readdirSync(dir).length, 1);
  p.onFrame(wf(10, S2), [share(10)], 3000);
  assert.equal(readdirSync(dir).length, 2);
  assert.equal(store.purgeExpired(5_500), 1);
  assert.equal(readdirSync(dir).length, 1);
  p.finalize(6000);
  assert.equal(readdirSync(dir).length, 0);
});

import { parseNativeLine, PrecomputedOcr } from '../src/vision/native_bridge.ts';
test('pont natif : messages valides parsés, entrées malformées rejetées', () => {
  const img = Buffer.alloc(6 * 4, 7).toString('base64');
  const m = parseNativeLine(JSON.stringify({ type: 'frame', local_ms: 1, width: 6, height: 4, gray_b64: img, ocr: [{ text: 'A', confidence: 0.9, bbox: { x: 0, y: 0, w: 5, h: 12 } }] }));
  assert.equal(m.type, 'frame');
  assert.throws(() => parseNativeLine(JSON.stringify({ type: 'frame', local_ms: 1, width: 6, height: 5, gray_b64: img, ocr: [] })));
  assert.throws(() => parseNativeLine(JSON.stringify({ type: 'frame', local_ms: 1, width: 99999, height: 99999, gray_b64: '', ocr: [] })));
  assert.throws(() => parseNativeLine('{"type":"x"}'));
  assert.deepEqual(parseNativeLine('{"type":"permission","granted":false,"reason":"stream_stopped"}'), { type: 'permission', granted: false, reason: 'stream_stopped' });
  const o = new PrecomputedOcr(); o.set([]); assert.deepEqual(o.recognize(), []);
});

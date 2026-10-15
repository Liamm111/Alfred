import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { extname, join } from 'node:path';
import { ProcessMacBridge } from '../src/outbox/process_bridge.ts';
import { MacPermissionDenied } from '../src/outbox/mac_bridge.ts';
import { buildPayload, ZOOM_URL } from '../src/outbox/payload.ts';
import type { EngineEvent } from '../src/address/types.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Corps de la fonction Swift dont la signature contient `needle` (appariement d'accolades). */
function swiftBody(src: string, needle: string): string {
  const i = src.indexOf(needle); if (i < 0) throw new Error(`introuvable: ${needle}`);
  const start = src.indexOf('{', src.indexOf(')', i)); let depth = 0;
  for (let k = start; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(start, k + 1); }
  throw new Error('accolades non appariées');
}

test('« Ouvrir Zoom » (Mac) : NSWorkspace / activate() n’existent que dans didReceive, derrière le test de l’identifiant d’action', () => {
  const src = read('mac/Sources/AlfredMac/Notifier.swift');
  const body = swiftBody(src, 'didReceive response');
  const without = src.replace(body, '');
  assert.ok(!/NSWorkspace|\.activate\(|launchApplication/.test(without), 'Zoom ouvert ailleurs que dans didReceive');
  assert.ok(/guard response\.actionIdentifier == Self\.openZoomAction/.test(body));
  assert.ok(body.indexOf('guard response.actionIdentifier') < body.indexOf('NSWorkspace'));
  assert.ok(!/UNNotificationAction\([^)]*\.foreground/.test(src), 'l’action ne doit pas avoir l’option .foreground');
  assert.ok(!/NSWorkspace|activate\(/.test(read('mac/Sources/AlfredMac/main.swift') + read('mac/Sources/AlfredMac/SharePicker.swift')));
});

test('service worker : n’ouvre que des pages de même origine ; aucune URL Zoom ouverte par le SW', () => {
  const sw = read('web/sw.js');
  const opens = [...sw.matchAll(/openWindow\(([^)]*)\)/g)].map((m) => m[1]!);
  assert.equal(opens.length, 1);
  assert.match(opens[0]!, /^'\/\?'/);
  assert.ok(!/zoom\.us|zoommtg/.test(sw.replace(/d\.zoom|open_url|zoom:/g, '')), 'pas d’URL Zoom dans le service worker');
  assert.ok(/showNotification/.test(sw), 'chaque push affiche une notification (exigence iOS)');
});

test('PWA : les URL Zoom passent par une liste blanche stricte (serveur et client)', () => {
  assert.ok(ZOOM_URL.test('https://us02web.zoom.us/j/12345678901?pwd=abcDEF'));
  for (const bad of ['http://zoom.us/j/123456', 'https://evil.com/j/123456', 'https://zoom.us.evil.com/j/123456', 'javascript:alert(1)', 'zoommtg://zoom.us/join?confno=1', 'https://zoom.us/j/12']) assert.equal(ZOOM_URL.test(bad), false, bad);
  const ev: EngineEvent = { type: 'alert', question_id: 'q', level: 'urgent', basis: 'final', evidence_ids: [], at_ms: 0, decision: { segment_id: 's', cls: 'DIRECT_CERTAIN', score: 1, reasons: [], uncertainty: [], evidence_spans: [], engine_version: 'x' } };
  assert.equal(buildPayload(ev, { join_url: 'https://evil.com/j/123456' }, 0)!.payload.open_url, undefined);
  assert.equal(buildPayload(ev, { join_url: 'https://zoom.us/j/123456789' }, 0)!.payload.open_url, 'https://zoom.us/j/123456789');
  assert.match(read('web/app.js'), /zoom\\\.us/);
});

test('pont Mac (NDJSON) : added → accepté ; denied → MacPermissionDenied ; silence → timeout ; delivered/clicked relayés', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const got: string[] = [];
  const bridge = new ProcessMacBridge({ stdin, stdout }, { delivered: (t) => got.push('d:' + t), clicked: (t) => got.push('c:' + t) }, 80);
  let written = ''; stdin.on('data', (c) => { written += c.toString(); });
  const n = (token: string) => ({ token, title: 't', body: 'b', tag: 'q', level: 'urgent' as const, kind: 'alert' });
  const p1 = bridge.notify(n('A')); stdout.write('{"type":"notify_result","token":"A","status":"added"}\n');
  assert.equal(await p1, 'added');
  const p2 = bridge.notify(n('B')); stdout.write('log de debug du helper\n{"type":"notify_result","token":"B","status":"denied"}\n');
  await assert.rejects(p2, MacPermissionDenied);
  await assert.rejects(bridge.notify(n('C')), /mac_helper_timeout/);
  stdout.write('{"type":"delivered","token":"A"}\n{"type":"clicked","to'); stdout.write('ken":"A"}\n');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, ['d:A', 'c:A']);
  assert.equal(written.trim().split('\n').length, 3);
});

// ---- comportement réel de la PWA dans Chromium (Playwright) --------------------------------------------------
const require = createRequire(import.meta.url);
const pwPath = '/opt/node22/lib/node_modules/playwright';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chromium: any = existsSync('/opt/pw-browsers/chromium') && existsSync(pwPath) ? require(pwPath).chromium : null;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function staticServer(): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!; hits.push(`${req.method} ${path}`);
    if (path === '/api/vapid-public-key') { res.setHeader('content-type', 'application/json'); return void res.end('{"key":"BAAA"}'); }
    if (path.startsWith('/api/')) { res.statusCode = 201; res.setHeader('content-type', 'application/json'); return void res.end('{"id":"x"}'); }
    const f = join('web', path === '/' ? 'index.html' : path);
    if (!existsSync(f)) { res.statusCode = 404; return void res.end(); }
    res.setHeader('content-type', MIME[extname(f)] ?? 'application/octet-stream'); res.end(readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits })));
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

test('onboarding iPhone (Chromium, UA iPhone) : non installé → instructions + bouton désactivé, aucune permission demandée', { skip: chromium ? false : 'Playwright/Chromium indisponible' }, async () => {
  const { server, base } = await staticServer();
  const browser = await chromium!.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const ctx = await browser.newContext({ userAgent: IPHONE_UA });
    await ctx.addInitScript(() => { (window as unknown as { __perm: number }).__perm = 0; Object.defineProperty(Notification, 'requestPermission', { value: () => { (window as unknown as { __perm: number }).__perm++; return Promise.resolve('granted'); } }); });
    const page = await ctx.newPage();
    await page.goto(`${base}/#pair=tok123`);
    assert.equal(await page.isVisible('#ios-install'), true);
    assert.equal(await page.isDisabled('#enable-btn'), true);
    assert.match(await page.textContent('#enable-msg') ?? '', /écran d'accueil/);
    assert.equal(await page.evaluate(() => (window as unknown as { __perm: number }).__perm), 0);
    assert.equal(new URL(page.url()).hash, '', 'jeton d’appairage retiré de l’URL');
  } finally { await browser.close(); server.close(); }
});

test('onboarding (Chromium, app « installée ») : 0 demande au chargement ; permission + abonnement seulement après le clic', { skip: chromium ? false : 'Playwright/Chromium indisponible' }, async () => {
  const { server, base, hits } = await staticServer();
  const browser = await chromium!.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const ctx = await browser.newContext({ userAgent: IPHONE_UA });
    await ctx.addInitScript(() => {
      const w = window as unknown as { __log: string[] };
      w.__log = [];
      Object.defineProperty(navigator, 'standalone', { value: true });
      Object.defineProperty(Notification, 'requestPermission', { value: () => { w.__log.push('requestPermission'); return Promise.resolve('granted'); } });
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
      const reg = { pushManager: { subscribe: (o: { userVisibleOnly: boolean }) => { w.__log.push('subscribe:' + o.userVisibleOnly); return Promise.resolve({ toJSON: () => ({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'a', auth: 'b' } }) }); } } };
      Object.defineProperty(navigator, 'serviceWorker', { value: { register: () => { w.__log.push('register'); return Promise.resolve(reg); }, ready: Promise.resolve(reg) } });
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/#pair=tok123`);
    const log = () => page.evaluate(() => (window as unknown as { __log: string[] }).__log);
    assert.deepEqual(await log(), [], 'rien avant le geste');
    assert.equal(await page.isVisible('#ios-install'), false);
    assert.equal(await page.isDisabled('#enable-btn'), false);
    assert.ok(!hits.some((h) => h.startsWith('POST /api/subscribe')));
    await page.click('#enable-btn');
    await page.waitForFunction(() => document.getElementById('enable-msg')!.textContent!.includes('activées'));
    assert.deepEqual(await log(), ['requestPermission', 'register', 'subscribe:true']);
    assert.ok(hits.includes('POST /api/subscribe'));
  } finally { await browser.close(); server.close(); }
});

test('page ouverte depuis une notification : « Ouvrir Zoom » est un lien à toucher (aucune navigation automatique), URL non-Zoom ignorée', { skip: chromium ? false : 'Playwright/Chromium indisponible' }, async () => {
  const { server, base, hits } = await staticServer();
  const browser = await chromium!.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${base}/?t=TOK&title=Sollicit%C3%A9&body=Prof&zoom=${encodeURIComponent('https://zoom.us/j/123456789')}`);
    await page.waitForFunction(() => !document.getElementById('alert')!.hidden);
    assert.equal(page.url().startsWith(base), true, 'pas de navigation sortante spontanée');
    assert.equal(await page.getAttribute('#open-zoom', 'href'), 'https://zoom.us/j/123456789');
    assert.ok(hits.includes('POST /api/seen'));
    await page.goto(`${base}/?t=TOK&zoom=${encodeURIComponent('https://evil.com/j/123456789')}`);
    await page.waitForFunction(() => !document.getElementById('alert')!.hidden);
    assert.equal(await page.isVisible('#open-zoom'), false);
  } finally { await browser.close(); server.close(); }
});

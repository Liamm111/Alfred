import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { OutboxStore } from './store.ts';

export interface ServerOptions { store: OutboxStore; vapidPublicKey: string; pairingToken: string; now: () => number; maxBody?: number }

function safeEq(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw Object.assign(new Error('too_large'), { status: 413 }); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}

/** API minimale de la PWA : clé VAPID publique, abonnement, ack appareil, « vu ». Appairage par jeton (usage mono-utilisateur V0). */
export function createApi(o: ServerOptions): Server {
  const max = o.maxBody ?? 8192;
  const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/vapid-public-key') return send(res, 200, { key: o.vapidPublicKey });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
      const body = (await readJson(req, max)) as Record<string, unknown>;
      if (url.pathname === '/api/subscribe') {
        if (!safeEq(bearer, o.pairingToken)) return send(res, 401, { error: 'unauthorized' });
        const sub = body.subscription as { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null } | undefined;
        if (!sub) return send(res, 400, { error: 'missing_subscription' });
        try { const s = o.store.subs.add(sub, o.now()); return send(res, 201, { id: s.id }); } catch (e) { return send(res, 422, { error: (e as Error).message }); }
      }
      // ack / seen : authentifiés par le jeton de livraison unique (reçu dans le push chiffré), pas par le jeton d'appairage.
      if (url.pathname === '/api/ack' || url.pathname === '/api/seen') {
        const tok = typeof body.token === 'string' ? body.token : '';
        const ok = url.pathname === '/api/ack' ? o.store.ack(tok, o.now()) : o.store.seen(tok, o.now());
        return send(res, ok ? 200 : 404, { ok });
      }
      return send(res, 404, { error: 'not_found' });
    } catch (e) { const st = (e as { status?: number }).status ?? 500; send(res, st, { error: (e as Error).message }); }
  });
}

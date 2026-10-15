import http from 'node:http';
import { verifyWebhook, urlValidationResponse, ReplayCache } from './webhook.js';

const MAX_BODY = 1_000_000;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ secret, manager, association, logger, replayCache = new ReplayCache(), now = Date.now }) {
  return http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body ?? {})); };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true, active: manager.active().length });
      let raw;
      try { raw = await readRaw(req); } catch { return send(413, { error: 'too_large' }); }

      if (req.method === 'POST' && req.url === '/zoom/webhook') {
        const v = verifyWebhook({ rawBody: raw, headers: req.headers, secret, now: now(), replayCache });
        if (!v.ok) { logger.warn('webhook_rejected', { reason: v.reason }); return send(v.reason === 'replay' ? 409 : 401, { error: v.reason }); }
        if (v.event.event === 'endpoint.url_validation') return send(200, urlValidationResponse(secret, v.event.payload?.plainToken ?? ''));
        send(200, { ok: true }); // ack fast, process after
        const r = manager.onWebhook(v.event);
        logger.info('webhook', { event: v.event.event, ...r });
        return;
      }

      // Zoom App -> backend: ONLY {nonce, meetingUUID}. No tokens, no Zoom secrets.
      if (req.method === 'POST' && req.url === '/v1/association') {
        let body; try { body = JSON.parse(raw); } catch { return send(400, { error: 'bad_json' }); }
        const keys = Object.keys(body ?? {});
        if (keys.some((k) => !['nonce', 'meetingUUID', 'rtmsStatus'].includes(k))) return send(400, { error: 'unexpected_fields' });
        const r = association.redeem(String(body.nonce ?? '').toUpperCase(), body.meetingUUID);
        return send(r.ok ? 200 : 403, r.ok ? { receipt: r.receipt } : { error: r.reason });
      }
      send(404, { error: 'not_found' });
    } catch (e) {
      logger.error('server_error', { error: String(e?.message) });
      send(500, { error: 'internal' });
    }
  });
}

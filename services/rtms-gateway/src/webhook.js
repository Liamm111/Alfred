// Zoom webhook verification. Done on the RAW body, BEFORE any JSON parsing or processing.
// Note: @zoom/rtms' rtms.onWebhookEvent() does not validate signatures, so we never use it.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOLERANCE_MS = 5 * 60 * 1000;

export class ReplayCache {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 10_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.now = now; this.map = new Map();
  }
  /** returns true if already seen; records it otherwise */
  seen(key) {
    const t = this.now();
    for (const [k, exp] of this.map) { if (exp <= t) this.map.delete(k); else break; }
    if (this.map.has(key)) return true;
    if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value);
    this.map.set(key, t + this.ttlMs);
    return false;
  }
}

export function sign(secret, timestamp, rawBody) {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @returns {{ok:true, event:object}|{ok:false, reason:string}}
 * reasons: missing_headers | bad_timestamp | stale_timestamp | bad_signature | replay | bad_json
 */
export function verifyWebhook({ rawBody, headers, secret, now = Date.now(), replayCache, toleranceMs = TOLERANCE_MS }) {
  const sig = headers['x-zm-signature'];
  const ts = headers['x-zm-request-timestamp'];
  if (!sig || !ts || !secret) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{10,13}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' };
  const tsMs = ts.length > 10 ? Number(ts) : Number(ts) * 1000;
  if (Math.abs(now - tsMs) > toleranceMs) return { ok: false, reason: 'stale_timestamp' };
  if (!safeEqual(sig, sign(secret, ts, rawBody))) return { ok: false, reason: 'bad_signature' };
  // Replay check only after authentication, so attackers cannot poison the cache.
  if (replayCache && replayCache.seen(sig)) return { ok: false, reason: 'replay' };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { ok: false, reason: 'bad_json' }; }
  if (!event || typeof event !== 'object' || typeof event.event !== 'string') return { ok: false, reason: 'bad_json' };
  return { ok: true, event };
}

export function urlValidationResponse(secret, plainToken) {
  return { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex') };
}

// Log redaction: secrets are removed, identifiers are hashed (stable, non-reversible),
// personal text is never logged.
import { createHash } from 'node:crypto';

const SECRET_KEYS = /(secret|signature|token|authorization|password|nonce|key|cookie|server_urls)/i;
const ID_KEYS = /(uuid|stream_?id|meeting_?id|session_?id|user_?id|account_?id)/i;
const TEXT_KEYS = /^(text|transcript|message|userName|user_name|name|displayName|email|buffer|data)$/;

export function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth]';
  if (Buffer.isBuffer(value)) return `[bytes:${value.length}]`;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
      else if (TEXT_KEYS.test(k)) out[k] = typeof v === 'string' ? `[text:${v.length}]` : '[redacted]';
      else if (ID_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = `#${shortHash(v)}`;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/v0=[0-9a-f]{16,}/gi, 'v0=[redacted]')
      .replace(/wss?:\/\/[^\s"']+/gi, '[url]');
  }
  return value;
}

export function createLogger(write = (line) => process.stdout.write(line + '\n'), now = () => new Date().toISOString()) {
  const log = (level) => (event, fields = {}) =>
    write(JSON.stringify({ t: now(), level, event, ...redact(fields) }));
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

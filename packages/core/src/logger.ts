import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Keys whose values must never reach logs (PRD Q03/§15: no transcript text, no plain email, no secrets).
 * Matching is case-insensitive on the key name, at any depth.
 */
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|password|passwd|secret|token|apikey|api_key|access_token|refresh_token|session|sessiontoken|email|text|transcript|verbatim|utterance|body|endpoint|p256dh|auth|keys|zoomurl|zoom_url|meeting_url|url|payload|textciphertext|summary|question)$/i;
const SENSITIVE_SUFFIX_RE = /(secret|token|password|ciphertext|cookie)$/i;

export const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) || SENSITIVE_SUFFIX_RE.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      base: null,
      formatters: { log: (o) => redact(o) as Record<string, unknown> },
      serializers: {
        // Error messages can embed user content; keep type + stack-free message only.
        err: (e: unknown) => (e instanceof Error ? { type: e.name, message: e.name === 'AppError' ? e.message : 'error' } : { type: 'unknown' }),
      },
    },
    opts.destination,
  );
}

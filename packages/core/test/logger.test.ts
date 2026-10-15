import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redact, REDACTED } from '../src/logger';
import { resolveRequestId } from '../src/ids';
import { AppError, errorResponseSchema } from '../src/errors';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, stream };
}

describe('redacting logger', () => {
  it('never emits transcript text, emails, secrets or urls', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });
    log.info(
      {
        requestId: 'req-12345678',
        text: 'Liam, peux-tu expliquer ta réponse ?',
        user: { email: 'liam@example.test', id: 'u1' },
        headers: { authorization: 'Bearer abc', cookie: 'sid=1' },
        nested: { deeper: [{ transcript: 'secret words', apiKey: 'k' }] },
        DEEPGRAM_API_TOKEN: 'zzz',
        zoomUrl: 'https://zoom.us/j/123?pwd=abc',
      },
      'event',
    );
    const out = lines.join('');
    for (const leak of ['peux-tu', 'liam@example.test', 'Bearer abc', 'sid=1', 'secret words', 'zzz', 'pwd=abc']) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('req-12345678');
    expect(out).toContain('"id":"u1"');
  });
  it('redacts error objects to type only unless AppError', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream });
    log.error({ err: new Error('contains user text hello') }, 'x');
    expect(lines.join('')).not.toContain('hello');
  });
  it('redact is depth-bounded and does not mutate input', () => {
    const input = { a: { text: 'x' } };
    expect(redact(input)).toEqual({ a: { text: REDACTED } });
    expect(input.a.text).toBe('x');
  });
});

describe('request ids & errors', () => {
  it('accepts safe ids, replaces unsafe ones', () => {
    expect(resolveRequestId('abc-12345678')).toBe('abc-12345678');
    expect(resolveRequestId('bad\nid with spaces')).not.toContain('\n');
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId('x'.repeat(200))).toHaveLength(36);
  });
  it('AppError maps to status and standard shape', () => {
    const e = new AppError('not_found', 'nope');
    expect(e.status).toBe(404);
    expect(errorResponseSchema.parse({ code: e.code, message: e.message, requestId: 'r' })).toBeTruthy();
  });
});

import { randomUUID } from 'node:crypto';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export const newId = (): string => randomUUID();

/** Accept a caller-provided request id only if it is short and charset-safe (no log injection); else generate. */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  return candidate && REQUEST_ID_RE.test(candidate) ? candidate : randomUUID();
}

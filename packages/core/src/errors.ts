import { z } from 'zod';

export const ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'not_ready',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  not_ready: 503,
  internal_error: 500,
};

/** Standard API error body (PRD §14): {code, message, requestId}. Never leaks internals. */
export const errorResponseSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  requestId: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export class AppError extends Error {
  readonly status: number;
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = HTTP_STATUS[code];
  }
}

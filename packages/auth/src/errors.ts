export type AuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "reuse_detected"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "insecure_transport"
  | "upstream_error";

const STATUS: Record<AuthErrorCode, number> = {
  invalid_request: 400,
  invalid_client: 401,
  invalid_grant: 400,
  reuse_detected: 400,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  insecure_transport: 426,
  upstream_error: 502,
};

/** `detail` is for logs only; clients only ever receive `code`. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
  get status() {
    return STATUS[this.code];
  }
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

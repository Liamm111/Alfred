import { createHash, randomBytes } from "node:crypto";
import { safeEqual } from "./crypto.js";

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636 §4.1
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(sha256) = 43 chars

export const generateVerifier = () => randomBytes(48).toString("base64url"); // 64 chars
export const challengeS256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const isValidVerifier = (v: unknown): v is string => typeof v === "string" && VERIFIER_RE.test(v);
export const isValidChallenge = (c: unknown): c is string => typeof c === "string" && CHALLENGE_RE.test(c);

/** Only S256 exists: `plain` offers no protection against code interception and is refused. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  return isValidVerifier(verifier) && safeEqual(challengeS256(verifier), challenge);
}

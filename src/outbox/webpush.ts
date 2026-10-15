import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

// ---- VAPID (RFC 8292) -------------------------------------------------------------------------

export interface VapidKeys { publicKey: string; privateKey: string } // base64url : public = point non compressé (65 o), private = scalaire (32 o)

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(keys: VapidKeys) {
  const pub = unb64u(keys.publicKey);
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

export const VAPID_MAX_EXP_S = 24 * 3600;

export function vapidJwt(keys: VapidKeys, endpoint: string, subject: string, nowMs: number, ttlS = 12 * 3600): { jwt: string; exp: number } {
  if (ttlS > VAPID_MAX_EXP_S) throw new Error('exp VAPID > 24 h interdit (RFC 8292)');
  const exp = Math.floor(nowMs / 1000) + ttlS;
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp, sub: subject })));
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return { jwt: `${head}.${body}.${b64u(sig)}`, exp };
}

/** Cache de JWT par origine : régénéré dès qu'il reste moins de 10 min de validité (jeton « expiré » impossible côté émetteur). */
export class VapidSigner {
  #keys: VapidKeys; #subject: string; #cache = new Map<string, { jwt: string; exp: number }>();
  constructor(keys: VapidKeys, subject: string) { this.#keys = keys; this.#subject = subject; }
  get publicKey(): string { return this.#keys.publicKey; }
  header(endpoint: string, nowMs: number): string {
    const origin = new URL(endpoint).origin;
    let c = this.#cache.get(origin);
    if (!c || c.exp * 1000 - nowMs < 10 * 60_000) { c = vapidJwt(this.#keys, endpoint, this.#subject, nowMs); this.#cache.set(origin, c); }
    return `vapid t=${c.jwt}, k=${this.#keys.publicKey}`;
  }
}

// ---- chiffrement du message (RFC 8291, aes128gcm RFC 8188) -----------------------------------

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const out: Buffer[] = []; let prev: Buffer = Buffer.alloc(0); let i = 1;
  while (Buffer.concat(out).length < len) { prev = createHmac('sha256', prk).update(Buffer.concat([prev, info, Buffer.from([i++])])).digest(); out.push(prev); }
  return Buffer.concat(out).subarray(0, len);
}

export interface EncryptOptions { salt?: Buffer; senderKey?: { publicKey: Buffer; privateKey: Buffer }; recordSize?: number }

export function encryptPayload(plaintext: Buffer, uaPublicB64: string, authB64: string, opts: EncryptOptions = {}): Buffer {
  const uaPublic = unb64u(uaPublicB64), auth = unb64u(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh invalide');
  if (auth.length !== 16) throw new Error('auth invalide');
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length > rs - 18) throw new Error('payload trop grand pour un enregistrement'); // 4096 - 16 (tag) - 1 (délimiteur) - 1
  let asPub: Buffer, asPriv: Buffer;
  if (opts.senderKey) { asPub = opts.senderKey.publicKey; asPriv = opts.senderKey.privateKey; }
  else { const e = createECDH('prime256v1'); e.generateKeys(); asPub = e.getPublicKey(); asPriv = e.getPrivateKey(); }
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(asPriv);
  const secret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + asPub.length);
  salt.copy(header, 0); header.writeUInt32BE(rs, 16); header[20] = asPub.length; asPub.copy(header, 21);
  return Buffer.concat([header, ct]);
}

// ---- transport + classification ---------------------------------------------------------------

export interface PushRequest { endpoint: string; headers: Record<string, string>; body: Buffer; timeout_ms: number }
export interface PushResponse { status: number; retry_after?: string | null }
export interface PushTransport { post(req: PushRequest): Promise<PushResponse> }

/** Transport réel (fetch). Non exercé contre APNs/FCM dans ce dépôt. */
export class FetchTransport implements PushTransport {
  async post(req: PushRequest): Promise<PushResponse> {
    const r = await fetch(req.endpoint, { method: 'POST', headers: req.headers, body: new Uint8Array(req.body), signal: AbortSignal.timeout(req.timeout_ms), redirect: 'error' });
    return { status: r.status, retry_after: r.headers.get('retry-after') };
  }
}

export type SendOutcome =
  | { kind: 'accepted'; http: number }
  | { kind: 'rate_limited'; http: number; retry_after_ms: number | null }
  | { kind: 'transient'; http?: number; error: string }
  | { kind: 'gone'; http: number }
  | { kind: 'auth'; http: number }
  | { kind: 'invalid'; http: number };

export function parseRetryAfter(v: string | null | undefined, nowMs: number): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

export function classify(res: PushResponse, nowMs: number): SendOutcome {
  const s = res.status;
  if (s === 201 || s === 200 || s === 202) return { kind: 'accepted', http: s }; // ≠ lu : le service push a seulement pris en charge
  if (s === 404 || s === 410) return { kind: 'gone', http: s };
  if (s === 429) return { kind: 'rate_limited', http: s, retry_after_ms: parseRetryAfter(res.retry_after, nowMs) };
  if (s === 401 || s === 403) return { kind: 'auth', http: s };
  if (s === 400 || s === 413) return { kind: 'invalid', http: s };
  if (s >= 500 || s === 408) return { kind: 'transient', http: s, error: `http_${s}` };
  return { kind: 'invalid', http: s };
}

/** En-tête Topic (≤ 32 car. base64url) : le service push remplace un message en attente de même sujet → pas de doublon si on réessaie. */
export function topicFor(addressEventId: string): string { return createHash('sha256').update(addressEventId).digest('base64url').slice(0, 32); }

export function buildPushRequest(o: { endpoint: string; p256dh: string; auth: string; payload: object; address_event_id: string; urgency: 'urgent' | 'normal'; ttl_s: number; vapid: VapidSigner; nowMs: number }): PushRequest {
  const body = encryptPayload(Buffer.from(JSON.stringify(o.payload)), o.p256dh, o.auth);
  return {
    endpoint: o.endpoint, body, timeout_ms: 10_000,
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': String(body.length),
      TTL: String(Math.max(0, Math.floor(o.ttl_s))), Urgency: o.urgency === 'urgent' ? 'high' : 'normal', Topic: topicFor(o.address_event_id),
      Authorization: o.vapid.header(o.endpoint, o.nowMs),
    },
  };
}

export { generateKeyPairSync };

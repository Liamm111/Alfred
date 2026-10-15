import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Constant-time string comparison that does not leak length through an early return. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export interface Sealed {
  key_id: string;
  nonce: Buffer;
  /** ciphertext || 16-byte GCM tag */
  ciphertext: Buffer;
}

/**
 * AES-256-GCM envelope with a key ring (rotation: add a key, make it current; old keys keep
 * decrypting). The AAD (owner + purpose) binds a ciphertext to its row: a blob copied to
 * another user or purpose fails authentication.
 */
export class SecretBox {
  constructor(
    private readonly keys: Record<string, Buffer>,
    readonly currentKeyId: string,
  ) {
    for (const [id, k] of Object.entries(keys)) if (k.length !== 32) throw new Error(`key ${id} must be 32 bytes`);
    if (!keys[currentKeyId]) throw new Error("current key missing");
  }
  seal(plain: string, aad: string): Sealed {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.keys[this.currentKeyId]!, nonce);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
    return { key_id: this.currentKeyId, nonce, ciphertext: ct };
  }
  open(s: Sealed, aad: string): string {
    const key = this.keys[s.key_id];
    if (!key) throw new Error("unknown key id");
    const d = createDecipheriv("aes-256-gcm", key, s.nonce);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(s.ciphertext.subarray(s.ciphertext.length - 16));
    return Buffer.concat([d.update(s.ciphertext.subarray(0, s.ciphertext.length - 16)), d.final()]).toString("utf8");
  }
  needsRotation(s: Sealed) {
    return s.key_id !== this.currentKeyId;
  }
}

/** HMAC-SHA256 signer with a key ring; token = base64url(json).base64url(mac) with the key id inside the payload. */
export class Signer {
  constructor(
    private readonly keys: Record<string, Buffer>,
    private readonly currentKeyId: string,
  ) {}
  sign(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify({ ...payload, kid: this.currentKeyId })).toString("base64url");
    return `${body}.${this.mac(this.currentKeyId, body)}`;
  }
  /** Returns the payload only if the signature is valid. Expiry / semantics are the caller's job. */
  verify(token: string): Record<string, unknown> | null {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const kid = payload.kid;
    if (typeof kid !== "string" || !this.keys[kid]) return null;
    return safeEqual(mac, this.mac(kid, body)) ? payload : null;
  }
  private mac(kid: string, body: string) {
    return createHmac("sha256", this.keys[kid]!).update(body).digest("base64url");
  }
}

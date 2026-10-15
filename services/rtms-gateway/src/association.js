// Session association between the Mac companion (profile), the Zoom App (meeting) and the gateway.
// Flow: companion asks for a short single-use nonce -> user's Zoom App posts {nonce, meetingUUID}
// -> gateway binds profile<->meeting. Webhooks for unbound meetings are NOT joined.
// The Zoom App never sees any secret: only the nonce (short TTL, single use).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { shortHash } from './redact.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars

export class AssociationStore {
  constructor({ secret, ttlMs = 120_000, bindingTtlMs = 6 * 3600_000, now = Date.now, maxPending = 100 } = {}) {
    if (!secret) throw new Error('association secret required');
    Object.assign(this, { secret, ttlMs, bindingTtlMs, now, maxPending });
    this.pending = new Map();  // nonce -> {profileId, exp}
    this.bindings = new Map(); // meetingUuid -> {profileId, exp}
  }
  issueNonce(profileId) {
    const t = this.now();
    for (const [n, v] of this.pending) if (v.exp <= t) this.pending.delete(n);
    if (this.pending.size >= this.maxPending) throw new Error('too_many_pending_nonces');
    const bytes = randomBytes(8);
    let nonce = ''; for (const b of bytes) nonce += ALPHABET[b % ALPHABET.length];
    this.pending.set(nonce, { profileId, exp: t + this.ttlMs });
    return { nonce, expiresAt: t + this.ttlMs };
  }
  /** @returns {{ok:true, receipt:string}|{ok:false, reason:string}} */
  redeem(nonce, meetingUuid) {
    const p = this.pending.get(nonce);
    if (!p) return { ok: false, reason: 'unknown_nonce' };
    this.pending.delete(nonce); // single use, even on failure paths below
    if (p.exp <= this.now()) return { ok: false, reason: 'expired_nonce' };
    if (typeof meetingUuid !== 'string' || meetingUuid.length < 8 || meetingUuid.length > 256) return { ok: false, reason: 'bad_meeting' };
    const exp = this.now() + this.bindingTtlMs;
    this.bindings.set(meetingUuid, { profileId: p.profileId, exp });
    return { ok: true, receipt: this.receipt(p.profileId, meetingUuid, exp), meetingRef: shortHash(meetingUuid) };
  }
  receipt(profileId, meetingUuid, exp) {
    const mac = createHmac('sha256', this.secret).update(`${profileId}|${meetingUuid}|${exp}`).digest('base64url');
    return `${exp}.${mac}`;
  }
  verifyReceipt(profileId, meetingUuid, receipt) {
    const [exp, mac] = String(receipt).split('.');
    if (!exp || !mac || Number(exp) < this.now()) return false;
    const expected = this.receipt(profileId, meetingUuid, Number(exp)).split('.')[1];
    const a = Buffer.from(mac), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  profileFor(meetingUuid) {
    const b = this.bindings.get(meetingUuid);
    if (!b) return null;
    if (b.exp <= this.now()) { this.bindings.delete(meetingUuid); return null; }
    return b.profileId;
  }
  revoke(meetingUuid) { this.bindings.delete(meetingUuid); }
}

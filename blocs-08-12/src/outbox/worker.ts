import type { ClaimedRow, OutboxStore } from './store.ts';
import { buildPushRequest, classify, type PushTransport, type SendOutcome, type VapidSigner } from './webpush.ts';

export interface ChannelSender { send(row: ClaimedRow, now: number): Promise<SendOutcome> }

export interface RetryPolicy { max_attempts: number; base_ms: number; cap_ms: number }
export const DEFAULT_RETRY: RetryPolicy = { max_attempts: 6, base_ms: 2_000, cap_ms: 60_000 };

export class WebPushSender implements ChannelSender {
  #store: OutboxStore; #transport: PushTransport; #vapid: VapidSigner;
  constructor(store: OutboxStore, transport: PushTransport, vapid: VapidSigner) { this.#store = store; this.#transport = transport; this.#vapid = vapid; }

  async send(row: ClaimedRow, now: number): Promise<SendOutcome> {
    const sub = this.#store.subs.get(row.channel.slice('webpush:'.length));
    if (!sub || sub.status !== 'active') return { kind: 'gone', http: 410 };
    if (sub.expiration_time !== null && sub.expiration_time <= now) return { kind: 'gone', http: 410 };
    const ttl_s = Math.max(0, Math.floor((row.expires_at - now) / 1000));
    const req = buildPushRequest({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, payload: { ...row.payload, delivery_token: row.delivery_token }, address_event_id: row.address_event_id, urgency: row.level, ttl_s, vapid: this.#vapid, nowMs: now });
    try { return classify(await this.#transport.post(req), now); }
    catch (e) { return { kind: 'transient', error: e instanceof Error ? e.message : 'network' }; }
  }
}

export class OutboxWorker {
  #store: OutboxStore; #owner: string; #senders: Map<string, ChannelSender>; #retry: RetryPolicy; #rng: () => number;
  constructor(o: { store: OutboxStore; owner: string; senders: Record<string, ChannelSender>; retry?: Partial<RetryPolicy>; rng?: () => number }) {
    this.#store = o.store; this.#owner = o.owner; this.#senders = new Map(Object.entries(o.senders)); this.#retry = { ...DEFAULT_RETRY, ...o.retry }; this.#rng = o.rng ?? Math.random;
  }

  #sender(channel: string): ChannelSender | undefined { return this.#senders.get(channel.startsWith('webpush:') ? 'webpush' : channel); }

  backoff(attempt: number): number {
    const raw = Math.min(this.#retry.cap_ms, this.#retry.base_ms * 2 ** (attempt - 1));
    return Math.round(raw * (0.5 + this.#rng() * 0.5)); // gigue 50–100 %
  }

  /** Un passage : réclame, envoie, règle. Retourne le nombre de lignes traitées. */
  async tick(now: number, limit = 10): Promise<number> {
    const rows = this.#store.claim(this.#owner, now, { limit });
    await Promise.all(rows.map((r) => this.#process(r, now)));
    return rows.length;
  }

  async #process(row: ClaimedRow, now: number): Promise<void> {
    const sender = this.#sender(row.channel);
    if (!sender) { this.#store.settle(row, now, { kind: 'dead', error: 'no_sender' }); return; }
    const o = await sender.send(row, now);
    const sub = row.channel.startsWith('webpush:') ? row.channel.slice('webpush:'.length) : null;
    switch (o.kind) {
      case 'accepted': this.#store.settle(row, now, { kind: 'accepted', http: o.http }); if (sub) this.#store.subs.recordAccepted(sub, now); return;
      case 'gone': this.#store.settle(row, now, { kind: 'dead', error: 'subscription_gone', http: o.http }); if (sub) this.#store.subs.expire(sub, `http_${o.http}`, now); return;
      case 'auth': {
        this.#store.settle(row, now, { kind: 'dead', error: 'auth_rejected', http: o.http });
        if (sub) this.#store.subs.recordAuthFailure(sub, now);
        return;
      }
      case 'invalid': this.#store.settle(row, now, { kind: 'dead', error: `invalid_${o.http}`, http: o.http }); return;
      case 'rate_limited':
      case 'transient': {
        const http = o.http;
        const err = o.kind === 'rate_limited' ? 'rate_limited' : o.error;
        if (row.attempts >= this.#retry.max_attempts) { this.#store.settle(row, now, { kind: 'dead', error: `max_attempts:${err}`, ...(http !== undefined ? { http } : {}) }); return; }
        const wait = Math.max(this.backoff(row.attempts), o.kind === 'rate_limited' ? o.retry_after_ms ?? 0 : 0);
        // Une alerte périmée est pire qu'inutile : si le prochain essai tombe après l'expiration, on abandonne proprement.
        if (now + wait >= row.expires_at) { this.#store.settle(row, now, { kind: 'expired', error: `would_expire_before_retry:${err}`, ...(http !== undefined ? { http } : {}) }); return; }
        this.#store.settle(row, now, { kind: 'retry', at: now + wait, error: err, ...(http !== undefined ? { http } : {}) });
        return;
      }
    }
  }
}

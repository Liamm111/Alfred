import type { ChannelSender } from './worker.ts';
import type { ClaimedRow, OutboxStore } from './store.ts';
import type { SendOutcome } from './webpush.ts';

/** Pont vers l'app Mac (UNUserNotificationCenter, mac/Sources/AlfredMac/Notifier.swift). */
export interface MacBridge {
  /** Ajoute la notification locale. Rejette si la permission est refusée ou l'app Mac injoignable. */
  notify(n: { token: string; title: string; body: string; tag: string; level: 'urgent' | 'normal'; kind: string; join_url?: string }): Promise<'added'>;
}

export class MacPermissionDenied extends Error {}

export class MacSender implements ChannelSender {
  #bridge: MacBridge;
  constructor(bridge: MacBridge) { this.#bridge = bridge; }
  async send(row: ClaimedRow): Promise<SendOutcome> {
    try {
      await this.#bridge.notify({ token: row.delivery_token, title: row.payload.title, body: row.payload.body, tag: row.payload.tag, level: row.level, kind: row.kind, ...(row.payload.open_url ? { join_url: row.payload.open_url } : {}) });
      return { kind: 'accepted', http: 200 }; // « ajoutée au centre de notifications » ≠ vue
    } catch (e) {
      if (e instanceof MacPermissionDenied) return { kind: 'invalid', http: 403 };
      return { kind: 'transient', error: e instanceof Error ? e.message : 'mac_bridge' };
    }
  }
}

/** Retours de l'app Mac : `delivered` (notification affichée) → device_ack, `clicked` → seen. */
export function wireMacCallbacks(store: OutboxStore, now: () => number) {
  return { delivered: (token: string) => store.ack(token, now()), clicked: (token: string) => store.seen(token, now()) };
}

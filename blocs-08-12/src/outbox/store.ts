import { randomBytes } from 'node:crypto';
import type { EngineEvent } from '../address/types.ts';
import type { Db } from './db.ts';
import { tx } from './db.ts';
import { buildPayload, type AlertContext, type PushPayload } from './payload.ts';
import { SubscriptionStore } from './subscriptions.ts';

/** V0 : pas d'email. Seuls ces canaux existent. */
export const SUPPORTED_CHANNEL = /^(mac|webpush:[\w-]+)$/;

export type OutboxStatus = 'pending' | 'sending' | 'accepted' | 'dead' | 'cancelled' | 'expired';

export interface ClaimedRow {
  id: number; address_event_id: string; channel: string; attempts: number;
  kind: PushPayload['kind']; level: 'urgent' | 'normal'; payload: PushPayload; expires_at: number; delivery_token: string; lease_owner: string;
}

export type DeliveryStage = 'created' | 'sent' | 'accepted' | 'device_ack' | 'seen';
export interface ChannelReport { channel: string; status: OutboxStatus; attempts: number; last_error: string | null; stages: Partial<Record<DeliveryStage, number>>; proof: DeliveryStage; unconfirmed: boolean }

const ORDER: DeliveryStage[] = ['created', 'sent', 'accepted', 'device_ack', 'seen'];

export class OutboxStore {
  readonly db: Db;
  readonly subs: SubscriptionStore;
  #failAfterRows: number | null = null;
  constructor(db: Db) { this.db = db; this.subs = new SubscriptionStore(db); }

  /** Test uniquement : fait échouer l'écriture après N lignes pour prouver l'atomicité. */
  injectFailureAfter(n: number | null): void { this.#failAfterRows = n; }

  /**
   * Écrit l'événement ET ses lignes d'outbox dans UNE transaction. Idempotent par (address_event_id, canal).
   * Retourne null si l'événement n'appelle aucune notification.
   */
  enqueue(ev: EngineEvent, ctx: AlertContext, now: number, extraChannels: string[] = []): { address_event_id: string; created: string[]; existing: string[] } | null {
    const built = buildPayload(ev, ctx, now);
    if (!built) return null;
    const channels = ['mac', ...this.subs.active(now).map((s) => `webpush:${s.id}`), ...extraChannels];
    for (const c of channels) if (!SUPPORTED_CHANNEL.test(c)) throw new Error(`channel_not_supported_v0: ${c}`);
    return tx(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO address_events(address_event_id,question_id,kind,level,payload,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .run(built.id, built.payload.question_id, built.payload.kind, built.payload.level, JSON.stringify(built.payload), now, now + built.ttl_ms);
      const created: string[] = [], existing: string[] = [];
      let n = 0;
      for (const ch of channels) {
        if (this.#failAfterRows !== null && n++ >= this.#failAfterRows) throw new Error('injected failure');
        const r = this.db.prepare('INSERT OR IGNORE INTO outbox(address_event_id,channel,status,next_attempt_at,delivery_token) VALUES (?,?,?,?,?)').run(built.id, ch, 'pending', now, randomBytes(18).toString('base64url'));
        if (Number(r.changes) === 1) {
          created.push(ch);
          this.db.prepare('INSERT INTO delivery_state(outbox_id,created_at) VALUES (?,?)').run(Number(r.lastInsertRowid), now);
        } else existing.push(ch);
      }
      // Une rétractation annule les envois pas encore partis de la même question.
      if (built.payload.kind === 'retract') {
        this.db.prepare(`UPDATE outbox SET status='cancelled', last_error='retracted' WHERE status='pending' AND address_event_id IN (SELECT address_event_id FROM address_events WHERE question_id=? AND kind IN ('alert','upgrade'))`).run(built.payload.question_id);
      }
      return { address_event_id: built.id, created, existing };
    });
  }

  /** Réclame des lignes dues avec un bail (fencing par lease_owner). Les baux expirés (worker mort) redeviennent réclamables. */
  claim(owner: string, now: number, opts: { limit?: number; lease_ms?: number } = {}): ClaimedRow[] {
    const limit = opts.limit ?? 10, lease = opts.lease_ms ?? 30_000;
    return tx(this.db, () => {
      this.db.prepare(`UPDATE outbox SET status='expired', last_error='ttl' WHERE status IN ('pending','sending') AND (lease_until IS NULL OR lease_until <= ?) AND address_event_id IN (SELECT address_event_id FROM address_events WHERE expires_at <= ?)`).run(now, now);
      const due = this.db.prepare(`SELECT o.id, o.address_event_id, o.channel, o.attempts, o.delivery_token, e.kind, e.level, e.payload, e.expires_at
        FROM outbox o JOIN address_events e USING(address_event_id)
        WHERE (o.status='pending' AND o.next_attempt_at <= ?) OR (o.status='sending' AND o.lease_until <= ?)
        ORDER BY o.next_attempt_at, o.id LIMIT ?`).all(now, now, limit) as unknown as { id: number; address_event_id: string; channel: string; attempts: number; delivery_token: string; kind: PushPayload['kind']; level: 'urgent' | 'normal'; payload: string; expires_at: number }[];
      const out: ClaimedRow[] = [];
      for (const r of due) {
        this.db.prepare("UPDATE outbox SET status='sending', attempts=attempts+1, lease_owner=?, lease_until=? WHERE id=?").run(owner, now + lease, r.id);
        this.db.prepare('UPDATE delivery_state SET sent_at=COALESCE(sent_at,?) WHERE outbox_id=?').run(now, r.id);
        out.push({ ...r, attempts: r.attempts + 1, payload: JSON.parse(r.payload) as PushPayload, lease_owner: owner });
      }
      return out;
    });
  }

  /** Règle le résultat d'un envoi. Retourne false si le bail a été perdu (un autre worker a repris la ligne). */
  settle(row: ClaimedRow, now: number, o: { kind: 'accepted'; http?: number } | { kind: 'retry'; at: number; error: string; http?: number } | { kind: 'dead' | 'expired'; error: string; http?: number }): boolean {
    return tx(this.db, () => {
      if (o.http !== undefined) this.db.prepare('UPDATE delivery_state SET gateway_status=? WHERE outbox_id=?').run(o.http, row.id);
      if (o.kind === 'accepted') this.db.prepare('UPDATE delivery_state SET accepted_at=COALESCE(accepted_at,?) WHERE outbox_id=?').run(now, row.id); // vrai même si le bail est perdu
      const own = "WHERE id=? AND lease_owner=? AND status='sending'";
      let r;
      if (o.kind === 'accepted') r = this.db.prepare(`UPDATE outbox SET status='accepted', lease_owner=NULL, lease_until=NULL, last_error=NULL ${own}`).run(row.id, row.lease_owner);
      else if (o.kind === 'retry') r = this.db.prepare(`UPDATE outbox SET status='pending', next_attempt_at=?, lease_owner=NULL, lease_until=NULL, last_error=? ${own}`).run(o.at, o.error, row.id, row.lease_owner);
      else r = this.db.prepare(`UPDATE outbox SET status=?, lease_owner=NULL, lease_until=NULL, last_error=? ${own}`).run(o.kind, o.error, row.id, row.lease_owner);
      return Number(r.changes) === 1;
    });
  }

  expiresAt(address_event_id: string): number | null {
    const r = this.db.prepare('SELECT expires_at FROM address_events WHERE address_event_id=?').get(address_event_id) as { expires_at: number } | undefined;
    return r?.expires_at ?? null;
  }

  /** Ack côté appareil (le service worker a reçu le push). N'implique PAS que l'utilisateur l'ait vu. */
  ack(token: string, now: number): boolean {
    return tx(this.db, () => {
      const o = this.db.prepare('SELECT id, channel FROM outbox WHERE delivery_token=?').get(token) as { id: number; channel: string } | undefined;
      if (!o) return false;
      this.db.prepare('UPDATE delivery_state SET accepted_at=COALESCE(accepted_at,?), device_ack_at=COALESCE(device_ack_at,?), unconfirmed_at=NULL WHERE outbox_id=?').run(now, now, o.id);
      this.db.prepare("UPDATE outbox SET status='accepted', lease_owner=NULL, lease_until=NULL WHERE id=? AND status IN ('sending','pending')").run(o.id);
      if (o.channel.startsWith('webpush:')) this.subs.recordAck(o.channel.slice('webpush:'.length), now);
      return true;
    });
  }

  /** « Vu » : clic sur la notification ou ouverture de l'app. Seul état qui prouve une attention humaine. */
  seen(token: string, now: number): boolean {
    if (!this.ack(token, now)) return false;
    this.db.prepare('UPDATE delivery_state SET seen_at=COALESCE(seen_at,?) WHERE outbox_id=(SELECT id FROM outbox WHERE delivery_token=?)').run(now, token);
    return true;
  }

  /** Push accepté mais jamais confirmé par l'appareil au-delà du délai (écran verrouillé/Focus/hors-ligne) : à escalader. */
  sweepUnconfirmed(now: number, deadline_ms: number): ChannelReport[] {
    const rows = this.db.prepare(`SELECT o.id, o.address_event_id FROM outbox o JOIN delivery_state d ON d.outbox_id=o.id
      WHERE o.status='accepted' AND o.channel LIKE 'webpush:%' AND d.device_ack_at IS NULL AND d.unconfirmed_at IS NULL AND d.accepted_at <= ?`).all(now - deadline_ms) as { id: number; address_event_id: string }[];
    const out: ChannelReport[] = [];
    for (const r of rows) { this.db.prepare('UPDATE delivery_state SET unconfirmed_at=? WHERE outbox_id=?').run(now, r.id); }
    for (const r of rows) out.push(...this.report(r.address_event_id).filter((c) => c.unconfirmed));
    return out;
  }

  report(address_event_id: string): ChannelReport[] {
    const rows = this.db.prepare(`SELECT o.channel, o.status, o.attempts, o.last_error, d.created_at, d.sent_at, d.accepted_at, d.device_ack_at, d.seen_at, d.unconfirmed_at
      FROM outbox o JOIN delivery_state d ON d.outbox_id=o.id WHERE o.address_event_id=? ORDER BY o.id`).all(address_event_id) as unknown as
      { channel: string; status: OutboxStatus; attempts: number; last_error: string | null; created_at: number; sent_at: number | null; accepted_at: number | null; device_ack_at: number | null; seen_at: number | null; unconfirmed_at: number | null }[];
    return rows.map((r) => {
      const stages: Partial<Record<DeliveryStage, number>> = { created: r.created_at };
      if (r.sent_at !== null) stages.sent = r.sent_at;
      if (r.accepted_at !== null) stages.accepted = r.accepted_at;
      if (r.device_ack_at !== null) stages.device_ack = r.device_ack_at;
      if (r.seen_at !== null) stages.seen = r.seen_at;
      const proof = [...ORDER].reverse().find((s) => stages[s] !== undefined)!;
      return { channel: r.channel, status: r.status, attempts: r.attempts, last_error: r.last_error, stages, proof, unconfirmed: r.unconfirmed_at !== null && r.device_ack_at === null };
    });
  }
}

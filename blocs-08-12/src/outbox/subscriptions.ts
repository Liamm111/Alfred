import type { Db } from './db.ts';
import { tx } from './db.ts';

/** Services Web Push connus. L'endpoint vient du navigateur de l'utilisateur : on refuse tout autre hôte (SSRF). */
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export interface SubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null }
export interface Subscription { id: string; endpoint: string; p256dh: string; auth: string; expiration_time: number | null; status: 'active' | 'expired' | 'rejected'; failure_count: number }

const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function validateSubscription(s: SubscriptionInput): string[] {
  const errs: string[] = [];
  let u: URL | null = null;
  try { u = new URL(s.endpoint); } catch { errs.push('endpoint invalide'); }
  if (u) {
    if (u.protocol !== 'https:') errs.push('endpoint non https');
    if (u.username || u.password || (u.port && u.port !== '443')) errs.push('endpoint avec identifiants/port');
    if (!PUSH_HOSTS.some((re) => re.test(u!.hostname))) errs.push(`hôte push non autorisé: ${u.hostname}`);
  }
  const p = b64u(s.keys.p256dh ?? ''), a = b64u(s.keys.auth ?? '');
  if (p.length !== 65 || p[0] !== 0x04) errs.push('p256dh invalide');
  if (a.length !== 16) errs.push('auth invalide');
  return errs;
}

export class SubscriptionStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  add(s: SubscriptionInput, now: number): Subscription {
    const errs = validateSubscription(s);
    if (errs.length) throw new Error(`subscription refusée: ${errs.join('; ')}`);
    return tx(this.#db, () => {
      const existing = this.#db.prepare('SELECT id FROM subscriptions WHERE endpoint=?').get(s.endpoint) as { id: string } | undefined;
      const id = existing?.id ?? `sub-${Buffer.from(s.endpoint).toString('base64url').slice(-12)}-${now.toString(36)}`;
      if (existing) this.#db.prepare("UPDATE subscriptions SET p256dh=?, auth=?, expiration_time=?, status='active', failure_count=0, status_reason=NULL, status_changed_at=? WHERE id=?").run(s.keys.p256dh, s.keys.auth, s.expirationTime ?? null, now, id);
      else this.#db.prepare('INSERT INTO subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,status_changed_at) VALUES (?,?,?,?,?,?,?)').run(id, s.endpoint, s.keys.p256dh, s.keys.auth, s.expirationTime ?? null, now, now);
      return this.get(id)!;
    });
  }

  get(id: string): Subscription | undefined { return this.#db.prepare('SELECT id,endpoint,p256dh,auth,expiration_time,status,failure_count FROM subscriptions WHERE id=?').get(id) as Subscription | undefined; }

  active(now: number): Subscription[] {
    return this.#db.prepare("SELECT id,endpoint,p256dh,auth,expiration_time,status,failure_count FROM subscriptions WHERE status='active' AND (expiration_time IS NULL OR expiration_time > ?) ORDER BY id").all(now) as unknown as Subscription[];
  }

  expire(id: string, reason: string, now: number): void { this.#db.prepare("UPDATE subscriptions SET status='expired', status_reason=?, status_changed_at=? WHERE id=?").run(reason, now, id); }

  /** 401/403 : à partir de 3 échecs consécutifs la souscription est écartée (évite de marteler le service push). */
  recordAuthFailure(id: string, now: number, limit = 3): boolean {
    this.#db.prepare('UPDATE subscriptions SET failure_count = failure_count + 1 WHERE id=?').run(id);
    const s = this.get(id);
    if (s && s.failure_count >= limit) { this.#db.prepare("UPDATE subscriptions SET status='rejected', status_reason='auth_failures', status_changed_at=? WHERE id=?").run(now, id); return true; }
    return false;
  }

  recordAccepted(id: string, now: number): void { this.#db.prepare('UPDATE subscriptions SET last_accepted_at=?, failure_count=0 WHERE id=?').run(now, id); }
  recordAck(id: string, now: number): void { this.#db.prepare('UPDATE subscriptions SET last_ack_at=? WHERE id=?').run(now, id); }

  /** Supprime les souscriptions expirées/rejetées depuis plus de `retentionMs`, et les actives dont l'expirationTime est dépassé. */
  purgeExpired(now: number, retentionMs = 7 * 86_400_000): number {
    this.#db.prepare("UPDATE subscriptions SET status='expired', status_reason='expirationTime', status_changed_at=? WHERE status='active' AND expiration_time IS NOT NULL AND expiration_time <= ?").run(now, now);
    const r = this.#db.prepare("DELETE FROM subscriptions WHERE status IN ('expired','rejected') AND status_changed_at <= ?").run(now - retentionMs);
    return Number(r.changes);
  }
}

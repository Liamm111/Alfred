import type { EngineEvent } from '../address/types.ts';

export type Preview = 'none' | 'speaker' | 'full';
export interface AlertContext { asker_name?: string; meeting_label?: string; preview?: Preview; ttl_ms?: number; join_url?: string }

export const ZOOM_URL = /^https:\/\/([\w-]+\.)?zoom\.us\/j\/\d{6,}(\?pwd=[\w.-]+)?$/;

export interface PushPayload {
  v: 1;
  kind: 'alert' | 'upgrade' | 'retract';
  level: 'urgent' | 'normal';
  tag: string; // = question_id : une notification par question, remplacée plutôt qu'empilée
  title: string;
  body: string;
  question_id: string;
  address_event_id: string;
  ts: number;
  /** Lien de réunion Zoom (https://*.zoom.us/j/…), affiché comme bouton « Ouvrir Zoom » — jamais ouvert automatiquement. */
  open_url?: string;
}

export const DEFAULT_TTL_MS = { urgent: 120_000, normal: 300_000 } as const;

/** Un push doit TOUJOURS afficher une notification (iOS révoque l'abonnement sinon) : la rétractation est donc visible. */
export function buildPayload(ev: EngineEvent, ctx: AlertContext, now: number): { id: string; payload: PushPayload; ttl_ms: number } | null {
  const preview = ctx.preview ?? 'speaker';
  const open = ctx.join_url && ZOOM_URL.test(ctx.join_url) ? { open_url: ctx.join_url } : {};
  const who = ctx.asker_name ?? 'Un participant';
  if (ev.type === 'alert' && ev.level !== 'none') {
    const id = `${ev.question_id}:alert`;
    const span = ev.decision.evidence_spans[0] ?? '';
    const body = preview === 'none' ? 'Ouvrez pour voir' : preview === 'speaker' ? `${who} s'adresse à vous` : `${who} : « ${span.slice(0, 120)} »`;
    return { id, ttl_ms: ctx.ttl_ms ?? DEFAULT_TTL_MS[ev.level], payload: { v: 1, kind: 'alert', level: ev.level, tag: ev.question_id, title: ev.level === 'urgent' ? 'Vous êtes sollicité sur Zoom' : 'Sollicitation possible sur Zoom', body, question_id: ev.question_id, address_event_id: id, ts: now, ...open } };
  }
  if (ev.type === 'update' && ev.what === 'upgraded' && ev.decision.cls === 'DIRECT_CERTAIN') {
    const id = `${ev.question_id}:upgrade:urgent`;
    return { id, ttl_ms: ctx.ttl_ms ?? DEFAULT_TTL_MS.urgent, payload: { v: 1, kind: 'upgrade', level: 'urgent', tag: ev.question_id, title: 'Vous êtes sollicité sur Zoom', body: preview === 'none' ? 'Ouvrez pour voir' : `${who} s'adresse à vous`, question_id: ev.question_id, address_event_id: id, ts: now, ...open } };
  }
  if (ev.type === 'retract') {
    const id = `${ev.question_id}:retract`;
    return { id, ttl_ms: ctx.ttl_ms ?? DEFAULT_TTL_MS.normal, payload: { v: 1, kind: 'retract', level: 'normal', tag: ev.question_id, title: 'Sollicitation annulée', body: 'La demande précédente a été annulée.', question_id: ev.question_id, address_event_id: id, ts: now } };
  }
  return null; // trace, closed, relance, confirmed… : aucune notification
}

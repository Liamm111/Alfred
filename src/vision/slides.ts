import { normalizeText } from './ocr.ts';

export type UnavailableReason =
  | 'no_share' | 'minimized' | 'other_space' | 'window_gone' | 'permission_revoked'
  | 'occluded' | 'illegible' | 'stale' | 'not_started';

export type SlideAnswer =
  | { status: 'available'; slide_id: string; text: string; partial: boolean; since_utc_ms: number; confirmed_utc_ms: number; evidence_ids: string[] }
  | { status: 'unavailable'; reason: UnavailableReason; last_slide_id: string | null; message: string };

const MESSAGES: Record<UnavailableReason, string> = {
  not_started: 'Diapositive indisponible : aucune capture démarrée.',
  no_share: 'Diapositive indisponible : aucun écran partagé détecté.',
  minimized: 'Diapositive indisponible : la fenêtre Zoom est réduite.',
  other_space: 'Diapositive indisponible : la fenêtre Zoom est sur un autre Space / masquée.',
  window_gone: 'Diapositive indisponible : la fenêtre sélectionnée a disparu.',
  permission_revoked: 'Diapositive indisponible : la permission de capture a été retirée.',
  occluded: 'Diapositive indisponible : le contenu est masqué ou non-Zoom.',
  illegible: 'Diapositive indisponible : texte illisible (flou ou trop petit).',
  stale: 'Diapositive indisponible : aucune confirmation récente du contenu.',
};

export function jaccard(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(' ').filter(Boolean)), B = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface SlideConfig { same_slide_similarity: number; stale_after_ms: number }
export const DEFAULT_SLIDE: SlideConfig = { same_slide_similarity: 0.6, stale_after_ms: 30_000 };

/**
 * Agrège les OCR en « diapositive courante ». Règle de sécurité : on ne renvoie jamais un texte
 * si la source est invisible, illisible ou périmée — on renvoie `unavailable`, jamais une supposition.
 */
export class SlideTracker {
  #cfg: SlideConfig;
  #n = 0;
  #cur: { id: string; text: string; partial: boolean; since: number; confirmed: number; evidence: string[] } | null = null;
  #blocked: UnavailableReason | null = 'not_started';
  #illegible = false;
  /** Après un blocage, l'ancien contenu n'est plus affirmable tant qu'une nouvelle observation ne l'a pas reconfirmé. */
  #needsObservation = false;

  constructor(cfg: Partial<SlideConfig> = {}) { this.#cfg = { ...DEFAULT_SLIDE, ...cfg }; }

  /** Source invisible/arrêtée : le contenu précédent n'est plus affirmable. */
  block(reason: UnavailableReason): void { this.#blocked = reason; this.#needsObservation = true; }
  unblock(): void { this.#blocked = null; }

  /** Frame inchangée vérifiée : rafraîchit la fraîcheur sans nouvel OCR. */
  confirm(utcMs: number): void { if (this.#cur && !this.#blocked && !this.#illegible && !this.#needsObservation) this.#cur.confirmed = utcMs; }

  observe(text: string, partial: boolean, utcMs: number, evidenceId: string): { changed: boolean; slide_id: string } {
    this.#illegible = false;
    this.#needsObservation = false;
    if (this.#cur && jaccard(this.#cur.text, text) >= this.#cfg.same_slide_similarity) {
      // Même diapositive (build d'animation, curseur) : on garde la version la plus complète.
      if (normalizeText(text).length >= normalizeText(this.#cur.text).length) { this.#cur.text = text; this.#cur.partial = partial; }
      this.#cur.confirmed = utcMs; this.#cur.evidence.push(evidenceId);
      return { changed: false, slide_id: this.#cur.id };
    }
    this.#cur = { id: `slide-${++this.#n}`, text, partial, since: utcMs, confirmed: utcMs, evidence: [evidenceId] };
    return { changed: true, slide_id: this.#cur.id };
  }

  /** Frame analysée mais illisible : l'ancien contenu n'est PLUS valable (la diapo a pu changer). */
  observeIllegible(): void { this.#illegible = true; }

  current(nowMs: number): SlideAnswer {
    const last = this.#cur?.id ?? null;
    const un = (reason: UnavailableReason): SlideAnswer => ({ status: 'unavailable', reason, last_slide_id: last, message: MESSAGES[reason] });
    if (this.#blocked) return un(this.#blocked);
    if (this.#illegible) return un('illegible');
    if (!this.#cur) return un('not_started');
    if (this.#needsObservation) return un('stale');
    if (nowMs - this.#cur.confirmed > this.#cfg.stale_after_ms) return un('stale');
    const c = this.#cur;
    return { status: 'available', slide_id: c.id, text: c.text, partial: c.partial, since_utc_ms: c.since, confirmed_utc_ms: c.confirmed, evidence_ids: [...c.evidence] };
  }
}

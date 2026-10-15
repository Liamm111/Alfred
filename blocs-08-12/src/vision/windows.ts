import type { Rect } from './image.ts';

/** Seules ces applications peuvent être capturées. Tout le reste est exclu, y compris en plein écran. */
export const ZOOM_BUNDLE_IDS: ReadonlySet<string> = new Set(['us.zoom.xos']);

export interface WindowInfo {
  window_id: number;
  bundle_id: string;
  title: string;
  display_id: number;
  /** false si fenêtre sur un autre Space ou masquée (SCWindow.isOnScreen). */
  on_screen: boolean;
  minimized: boolean;
  /** Ordre z : plus grand = plus en avant. */
  layer: number;
  frame: Rect;
}

export type PickRole = 'zoom_meeting' | 'shared_screen' | 'display';

export interface PickedContent { windows: WindowInfo[]; display_id: number | null }

export interface PickDecision {
  accepted: { window_id: number; role: PickRole }[];
  rejected: { window_id: number; reason: 'not_zoom' }[];
  /** Un display complet est accepté, mais ses pixels non-Zoom seront masqués à la capture. */
  display_mode: boolean;
}

/** Titres de fenêtres Zoom qui montrent le contenu partagé par l'intervenant. */
const SHARE_TITLE = /(screen|écran|share|partage|présentation|presentation)/i;

export function evaluatePick(picked: PickedContent): PickDecision {
  const d: PickDecision = { accepted: [], rejected: [], display_mode: picked.display_id !== null };
  for (const w of picked.windows) {
    if (!ZOOM_BUNDLE_IDS.has(w.bundle_id)) { d.rejected.push({ window_id: w.window_id, reason: 'not_zoom' }); continue; }
    d.accepted.push({ window_id: w.window_id, role: SHARE_TITLE.test(w.title) ? 'shared_screen' : 'zoom_meeting' });
  }
  return d;
}

export type WindowState = 'visible' | 'minimized' | 'other_space' | 'gone';

export function windowState(w: WindowInfo | undefined): WindowState {
  if (!w) return 'gone';
  if (w.minimized) return 'minimized';
  if (!w.on_screen) return 'other_space';
  return 'visible';
}

export type WindowEvent =
  | { type: 'appeared'; window_id: number; utc_ms: number }
  | { type: 'disappeared'; window_id: number; utc_ms: number }
  | { type: 'state_changed'; window_id: number; from: WindowState; to: WindowState; utc_ms: number }
  | { type: 'moved_display'; window_id: number; from: number; to: number; utc_ms: number };

/** Suit les fenêtres sélectionnées à partir de snapshots successifs de l'énumération système. */
export class WindowTracker {
  #tracked = new Map<number, { state: WindowState; display: number }>();
  #selected = new Set<number>();

  select(ids: number[]): void { this.#selected = new Set(ids); }
  get selectedIds(): number[] { return [...this.#selected]; }

  stateOf(id: number): WindowState { return this.#tracked.get(id)?.state ?? 'gone'; }

  update(snapshot: WindowInfo[], utc_ms: number): WindowEvent[] {
    const events: WindowEvent[] = [];
    const byId = new Map(snapshot.filter((w) => ZOOM_BUNDLE_IDS.has(w.bundle_id)).map((w) => [w.window_id, w]));
    for (const id of this.#selected) {
      const w = byId.get(id);
      const prev = this.#tracked.get(id);
      const state = windowState(w);
      if (!prev) {
        if (w) { events.push({ type: 'appeared', window_id: id, utc_ms }); this.#tracked.set(id, { state, display: w.display_id });
          if (state !== 'visible') events.push({ type: 'state_changed', window_id: id, from: 'gone', to: state, utc_ms }); }
        continue;
      }
      if (state === 'gone') { events.push({ type: 'disappeared', window_id: id, utc_ms }); this.#tracked.delete(id); continue; }
      if (prev.state !== state) { events.push({ type: 'state_changed', window_id: id, from: prev.state, to: state, utc_ms }); prev.state = state; }
      if (w && prev.display !== w.display_id) { events.push({ type: 'moved_display', window_id: id, from: prev.display, to: w.display_id, utc_ms }); prev.display = w.display_id; }
    }
    return events;
  }
}

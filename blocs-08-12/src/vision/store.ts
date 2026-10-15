import { mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Gray } from './image.ts';

/** TTL max autorisé pour une image persistée (5 min) : pas d'archive vidéo. */
export const MAX_FRAME_TTL_MS = 300_000;

export interface FrameStoreConfig { enabled: boolean; ttl_ms: number; dir?: string; max_frames?: number }

/** Persistance facultative d'images, désactivée par défaut, TTL court, bornée. */
export class FrameStore {
  readonly enabled: boolean;
  readonly ttlMs: number;
  #dir: string | undefined;
  #max: number;
  #items = new Map<string, { expires: number; bytes?: Gray; path?: string }>();

  constructor(cfg: FrameStoreConfig = { enabled: false, ttl_ms: 60_000 }) {
    if (cfg.ttl_ms > MAX_FRAME_TTL_MS || cfg.ttl_ms <= 0) throw new Error(`ttl_ms doit être dans ]0, ${MAX_FRAME_TTL_MS}]`);
    this.enabled = cfg.enabled; this.ttlMs = cfg.ttl_ms; this.#dir = cfg.dir; this.#max = cfg.max_frames ?? 30;
    if (this.enabled && this.#dir) mkdirSync(this.#dir, { recursive: true });
  }

  get count(): number { return this.#items.size; }

  put(frameHash: string, img: Gray, nowMs: number): boolean {
    if (!this.enabled) return false;
    this.purgeExpired(nowMs);
    while (this.#items.size >= this.#max) this.#evict(this.#items.keys().next().value as string);
    if (this.#dir) {
      const path = join(this.#dir, `${frameHash}.gray`);
      writeFileSync(path, img.data);
      this.#items.set(frameHash, { expires: nowMs + this.ttlMs, path });
    } else this.#items.set(frameHash, { expires: nowMs + this.ttlMs, bytes: img });
    return true;
  }

  has(frameHash: string, nowMs: number): boolean {
    this.purgeExpired(nowMs);
    return this.#items.has(frameHash);
  }

  purgeExpired(nowMs: number): number {
    let n = 0;
    for (const [k, v] of this.#items) if (v.expires <= nowMs) { this.#evict(k); n++; }
    return n;
  }

  /** Permission retirée / fin de réunion : tout effacer immédiatement. */
  purgeAll(): void { for (const k of [...this.#items.keys()]) this.#evict(k); }

  #evict(k: string): void {
    const v = this.#items.get(k);
    if (v?.path) rmSync(v.path, { force: true });
    this.#items.delete(k);
  }

  /** Vérification externe : fichiers réellement présents sur disque. */
  filesOnDisk(): number { return this.#dir ? readdirSync(this.#dir).filter((f) => statSync(join(this.#dir!, f)).isFile()).length : 0; }
}

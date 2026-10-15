import { DatabaseSync } from 'node:sqlite';
import type { GapSegment, NormalizedEvidence } from '../contracts/evidence.ts';

export interface ReplayConfig { max_items: number; max_bytes: number; path?: string }

/**
 * Cache local borné pour les périodes réseau coupé. Débordement = on perd les plus anciens ET on le dit
 * (GapSegment `dropped_by_buffer`) ; jamais de perte silencieuse. Isolé par réunion.
 */
export class ReplayBuffer {
  #db: DatabaseSync;
  #cfg: ReplayConfig;
  #dropped: GapSegment[] = [];

  constructor(cfg: ReplayConfig) {
    this.#cfg = cfg;
    this.#db = new DatabaseSync(cfg.path ?? ':memory:');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS replay (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, utc_start INTEGER NOT NULL, utc_end INTEGER NOT NULL,
      modality TEXT NOT NULL, source_id TEXT NOT NULL, source_epoch INTEGER NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS replay_m ON replay(meeting_id, utc_start);`);
  }

  get droppedGaps(): readonly GapSegment[] { return this.#dropped; }
  count(meeting_id?: string): number {
    const r = meeting_id ? this.#db.prepare('SELECT COUNT(*) c FROM replay WHERE meeting_id=?').get(meeting_id) : this.#db.prepare('SELECT COUNT(*) c FROM replay').get();
    return Number((r as { c: number }).c);
  }
  bytes(): number { return Number((this.#db.prepare('SELECT COALESCE(SUM(bytes),0) b FROM replay').get() as { b: number }).b); }

  push(e: NormalizedEvidence): void {
    const body = JSON.stringify(e);
    const size = Buffer.byteLength(body);
    this.#db.prepare('INSERT OR IGNORE INTO replay VALUES (?,?,?,?,?,?,?,?,?)').run(e.evidence_id, e.meeting_id, e.utc_start_ms, e.utc_end_ms, e.modality, e.source.source_id, e.source.source_epoch, size, body);
    while (this.count() > this.#cfg.max_items || this.bytes() > this.#cfg.max_bytes) {
      const old = this.#db.prepare('SELECT id, meeting_id, utc_start, utc_end, modality, source_id, source_epoch FROM replay ORDER BY utc_start ASC, id ASC LIMIT 1').get() as
        { id: string; meeting_id: string; utc_start: number; utc_end: number; modality: GapSegment['modality']; source_id: string; source_epoch: number } | undefined;
      if (!old) break;
      this.#db.prepare('DELETE FROM replay WHERE id=?').run(old.id);
      this.#dropped.push({ meeting_id: old.meeting_id, modality: old.modality, source_id: old.source_id, source_epoch: old.source_epoch, utc_start_ms: old.utc_start, utc_end_ms: old.utc_end, reason: 'dropped_by_buffer' });
    }
  }

  /** Rejoue UNIQUEMENT la réunion demandée, dans l'ordre canonique ; une entrée n'est supprimée qu'après succès du sink. */
  drain(meeting_id: string, sink: (e: NormalizedEvidence) => boolean): { delivered: number; remaining: number } {
    const rows = this.#db.prepare('SELECT id, body FROM replay WHERE meeting_id=? ORDER BY utc_start ASC, utc_end ASC, id ASC').all(meeting_id) as { id: string; body: string }[];
    let delivered = 0;
    for (const r of rows) {
      if (!sink(JSON.parse(r.body) as NormalizedEvidence)) break; // réseau retombé : on garde le reste
      this.#db.prepare('DELETE FROM replay WHERE id=?').run(r.id); delivered++;
    }
    return { delivered, remaining: this.count(meeting_id) };
  }

  close(): void { this.#db.close(); }
}

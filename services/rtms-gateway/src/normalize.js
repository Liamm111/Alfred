// Normalisation of RTMS media into one internal envelope.
// Audio is configured as L16 / 16 kHz / mono / per-participant streams (AUDIO_MULTI_STREAMS),
// so every audio item is PCM s16le 16000 Hz mono. Anything else is rejected (dead-letter).
//
// Provenance: RTMS only carries what Zoom shares with the app (participant audio, transcript,
// *shared* screen content). It is NOT a capture of the user's personal screen. Every item says so,
// and share frames outside an announced sharing window are refused.
import { shortHash } from './redact.js';

export const AUDIO_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 });
const BYTES_PER_MS = (AUDIO_FORMAT.sampleRate * 2 * AUDIO_FORMAT.channels) / 1000; // 32
export const GAP_TOLERANCE_MS = 60;

export class RejectedItem extends Error {
  constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; }
}

export class Normalizer {
  /** @param {{streamId:string, epoch:number, now?:()=>number, onGap?:(g:object)=>void}} o */
  constructor({ streamId, getEpoch, now = Date.now, onGap = () => {} }) {
    this.streamRef = shortHash(streamId); this.getEpoch = getEpoch; this.now = now; this.onGap = onGap;
    this.last = new Map();     // sourceId -> {endTs, ts, epoch}
    this.sharing = null;       // {userId, since} while Zoom announces sharing
    this.seq = 0;
  }

  sourceId(kind, userId) { return `rtms:${this.streamRef}:${kind}:${userId ?? 'mixed'}`; }

  envelope(kind, userId, tsMs, extra) {
    return {
      v: 1, kind, seq: ++this.seq,
      source_id: this.sourceId(kind, userId),
      source_epoch: this.getEpoch(),
      ts_ms: tsMs, received_ms: this.now(),
      provenance: { origin: 'zoom_rtms', scope: kind === 'share' ? 'shared_content_only' : 'meeting_stream', personal_screen_capture: false },
      ...extra,
    };
  }

  audio(buffer, size, timestamp, metadata) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new RejectedItem('audio_empty');
    if (size !== buffer.length) throw new RejectedItem('audio_size_mismatch', { size, len: buffer.length });
    if (buffer.length % 2 !== 0) throw new RejectedItem('audio_incompatible_format', { len: buffer.length });
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new RejectedItem('audio_bad_timestamp');
    const userId = metadata?.userId;
    if (!Number.isInteger(userId)) throw new RejectedItem('audio_no_source_id');
    const durationMs = buffer.length / BYTES_PER_MS;
    const item = this.envelope('audio', userId, timestamp, { duration_ms: durationMs, format: AUDIO_FORMAT, pcm: buffer, speaker: { id: userId } });
    this.trace(item.source_id, timestamp, durationMs);
    return item;
  }

  /** Gap / reordering tracing per source; a new epoch resets continuity. */
  trace(sourceId, ts, durationMs) {
    const epoch = this.getEpoch();
    const prev = this.last.get(sourceId);
    if (prev && prev.epoch === epoch) {
      if (ts < prev.ts) throw new RejectedItem('out_of_order', { by_ms: prev.ts - ts });
      const gap = ts - prev.endTs;
      if (gap > GAP_TOLERANCE_MS) this.onGap({ source_id: sourceId, source_epoch: epoch, gap_ms: gap, from_ts: prev.endTs, to_ts: ts });
    }
    this.last.set(sourceId, { ts, endTs: ts + durationMs, epoch });
  }

  transcript(buffer, size, timestamp, metadata) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || size !== buffer.length) throw new RejectedItem('transcript_empty');
    const text = buffer.toString('utf8');
    if (text.includes('�')) throw new RejectedItem('transcript_bad_encoding');
    if (!Number.isInteger(metadata?.userId)) throw new RejectedItem('transcript_no_source_id');
    return this.envelope('transcript', metadata.userId, timestamp, { text, speaker: { id: metadata.userId } });
  }

  chat({ userId, timestamp, text }) {
    if (typeof text !== 'string' || !text) throw new RejectedItem('chat_empty');
    return this.envelope('chat', userId, timestamp, { text, speaker: { id: userId } });
  }

  sharingEvent(event, timestamp, userId) {
    if (event === 'start') this.sharing = { userId, since: timestamp };
    else this.sharing = null;
  }

  share(buffer, size, timestamp, metadata) {
    if (!this.sharing) throw new RejectedItem('unshared_content_rejected');
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || size !== buffer.length) throw new RejectedItem('share_empty');
    return this.envelope('share', metadata?.userId ?? this.sharing.userId, timestamp, { bytes: buffer.length, frame: buffer });
  }
}

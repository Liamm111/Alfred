import { computeBackoff } from './backoff.js';
import { classifyStop } from './stop-reasons.js';
import { Normalizer, RejectedItem } from './normalize.js';
import { shortHash } from './redact.js';

/**
 * Lifecycle of one RTMS stream:
 *   joining -> active -> (reconnecting -> joining ...) -> stopped | failed
 * Webhook `rtms_stopped` and terminal leave reasons (host stop, app disabled, meeting ended...) are final:
 * the manager never reconnects after them.
 *
 * adapterFactory(payload) must return { connect(handlers), leave() } -- see rtms-adapter.js.
 */
export class SessionManager {
  constructor({
    adapterFactory, sink, deadLetter, logger, authorize = () => true,
    maxConcurrent = 5, maxReconnect = 6, joinTimeoutMs = 15_000, noMediaTimeoutMs = 20_000, livenessTimeoutMs = 30_000,
    tombstoneTtlMs = 10 * 60_000, backoff = {}, rng = Math.random, now = Date.now,
    timers = { setTimeout, clearTimeout },
  }) {
    Object.assign(this, { adapterFactory, sink, deadLetter, logger, authorize, maxConcurrent, maxReconnect, joinTimeoutMs,
      noMediaTimeoutMs, livenessTimeoutMs, tombstoneTtlMs, backoff, rng, now, timers });
    this.sessions = new Map();   // streamId -> session
    this.tombstones = new Map(); // streamId -> expiresAt (stopped/seen-stop; defeats out-of-order `started`)
    this.metrics = { started: 0, stopped: 0, failed: 0, items: 0, rejected: 0, gaps: 0, reconnects: 0 };
  }

  active() { return [...this.sessions.values()].filter((s) => ['joining', 'active', 'reconnecting'].includes(s.state)); }

  /** Entry point for *verified* webhook events only. */
  onWebhook(evt) {
    const payload = evt?.payload ?? {};
    const streamId = payload.rtms_stream_id;
    if (evt.event === 'meeting.rtms_started') return this.#start(payload, streamId);
    if (evt.event === 'meeting.rtms_stopped') return this.#stopFromWebhook(streamId);
    return { handled: false, reason: 'ignored_event' };
  }

  #start(payload, streamId) {
    if (typeof streamId !== 'string' || !payload.meeting_uuid || !payload.server_urls) {
      this.deadLetter.push('malformed_started', { payload });
      return { handled: false, reason: 'malformed' };
    }
    this.#gcTombstones();
    if (this.tombstones.has(streamId)) return { handled: false, reason: 'out_of_order_after_stop' };
    if (this.sessions.has(streamId)) return { handled: false, reason: 'duplicate' };
    if (!this.authorize(payload.meeting_uuid)) {
      this.deadLetter.push('unassociated_meeting', { meeting_uuid: payload.meeting_uuid });
      return { handled: false, reason: 'unassociated_meeting' };
    }
    if (this.active().length >= this.maxConcurrent) {
      this.deadLetter.push('quota_exceeded', { rtms_stream_id: streamId, max: this.maxConcurrent });
      this.logger.warn('quota_exceeded', { rtms_stream_id: streamId });
      return { handled: false, reason: 'quota_exceeded' };
    }
    const s = {
      streamId, payload, state: 'joining', epoch: 1, attempts: 0, adapter: null, timers: {},
      firstMediaAt: null, lastActivityAt: null, noMediaAlerted: false, stopRequested: false,
      startedAt: this.now(), stats: { audio: 0, transcript: 0, share: 0 },
    };
    s.normalizer = new Normalizer({
      streamId, getEpoch: () => s.epoch, now: this.now,
      onGap: (g) => { this.metrics.gaps++; this.sink({ kind: 'gap', ...g }); this.logger.warn('gap', g); },
    });
    this.sessions.set(streamId, s);
    this.metrics.started++;
    this.#connect(s);
    return { handled: true, reason: 'started' };
  }

  #stopFromWebhook(streamId) {
    if (typeof streamId !== 'string') return { handled: false, reason: 'malformed' };
    this.tombstones.set(streamId, this.now() + this.tombstoneTtlMs);
    const s = this.sessions.get(streamId);
    if (!s) return { handled: false, reason: 'stop_without_session' };
    this.#finish(s, 'stopped', 'webhook_stopped');
    return { handled: true, reason: 'stopped' };
  }

  #gcTombstones() { const t = this.now(); for (const [k, exp] of this.tombstones) if (exp <= t) this.tombstones.delete(k); }

  #clear(s, name) { if (s.timers[name]) { this.timers.clearTimeout(s.timers[name]); delete s.timers[name]; } }
  #set(s, name, ms, fn) { this.#clear(s, name); s.timers[name] = this.timers.setTimeout(fn, ms); }

  #connect(s) {
    s.state = 'joining';
    const epoch = s.epoch;
    const live = () => this.sessions.get(s.streamId) === s && s.epoch === epoch && !s.stopRequested;
    try {
      s.adapter = this.adapterFactory(s.payload);
      this.#set(s, 'join', this.joinTimeoutMs, () => live() && this.#onFailure(s, 'join_timeout'));
      s.adapter.connect({
        onJoin: (ok, reason) => { if (live()) this.#onJoin(s, ok, reason); },
        onAudio: (...a) => live() && this.#media(s, 'audio', a),
        onTranscript: (...a) => live() && this.#media(s, 'transcript', a),
        onShare: (...a) => live() && this.#media(s, 'share', a),
        onSharingEvent: (e, ts, uid) => { if (live()) { s.normalizer.sharingEvent(e, ts, uid); this.#touch(s); } },
        onActivity: () => live() && this.#touch(s),
        onLeave: (reasonName) => { if (live()) this.#onLeave(s, reasonName); },
      });
    } catch (err) {
      this.logger.error('connect_threw', { rtms_stream_id: s.streamId, error: String(err?.message ?? err) });
      this.#onFailure(s, 'connect_threw');
    }
  }

  #onJoin(s, ok, reason) {
    this.#clear(s, 'join');
    if (!ok) return this.#onLeave(s, reason ?? 'JOIN_REFUSED');
    s.state = 'active';
    this.logger.info('joined', { rtms_stream_id: s.streamId, epoch: s.epoch });
    if (s.firstMediaAt === null || s.epoch > 1) {
      this.#set(s, 'noMedia', this.noMediaTimeoutMs, () => {
        if (s.state === 'active' && !s.mediaThisEpoch && !s.noMediaAlerted) {
          s.noMediaAlerted = true;
          this.deadLetter.push('started_without_media', { rtms_stream_id: s.streamId, epoch: s.epoch });
          this.logger.warn('no_media', { rtms_stream_id: s.streamId, epoch: s.epoch });
          this.sink({ kind: 'health', status: 'no_media', source_epoch: s.epoch });
        }
      });
    }
    s.mediaThisEpoch = false;
  }

  #touch(s) {
    s.lastActivityAt = this.now();
    if (s.mediaThisEpoch) this.#armLiveness(s);
  }

  #armLiveness(s) {
    this.#set(s, 'liveness', this.livenessTimeoutMs, () => {
      if (s.state === 'active') this.#onFailure(s, 'liveness_timeout');
    });
  }

  #media(s, kind, args) {
    if (s.state !== 'active') { this.deadLetter.push('media_before_join', { kind }); return; }
    try {
      const item = s.normalizer[kind](...args);
      s.stats[kind]++;
      if (!s.mediaThisEpoch) {
        s.mediaThisEpoch = true; s.firstMediaAt ??= this.now();
        this.#clear(s, 'noMedia'); s.noMediaAlerted = false;
        s.attempts = 0; // a connection that delivers media is a healthy one
      }
      this.#touch(s);
      this.#armLiveness(s);
      this.metrics.items++;
      try { this.sink(item); } catch (e) { this.deadLetter.push('sink_error', { kind, error: String(e?.message) }); }
    } catch (e) {
      if (!(e instanceof RejectedItem)) throw e;
      this.metrics.rejected++;
      this.deadLetter.push(e.reason, { kind, rtms_stream_id: s.streamId, ...(e.detail ?? {}) });
    }
  }

  #onLeave(s, reasonName) {
    const cls = classifyStop(reasonName);
    this.logger.info('left', { rtms_stream_id: s.streamId, reason: reasonName, cls });
    if (cls === 'terminal') {
      this.tombstones.set(s.streamId, this.now() + this.tombstoneTtlMs);
      return this.#finish(s, 'stopped', reasonName);
    }
    if (cls === 'fatal') { this.deadLetter.push('fatal_leave', { reason: reasonName, rtms_stream_id: s.streamId }); return this.#finish(s, 'failed', reasonName); }
    this.#onFailure(s, reasonName);
  }

  #onFailure(s, why) {
    if (s.stopRequested || ['stopped', 'failed'].includes(s.state)) return;
    this.#clear(s, 'join'); this.#clear(s, 'liveness'); this.#clear(s, 'noMedia');
    try { s.adapter?.leave(); } catch { /* best effort */ }
    s.attempts++;
    if (s.attempts > this.maxReconnect) {
      this.deadLetter.push('reconnect_exhausted', { rtms_stream_id: s.streamId, why });
      return this.#finish(s, 'failed', 'reconnect_exhausted');
    }
    const delay = computeBackoff(s.attempts - 1, { ...this.backoff, rng: this.rng });
    s.state = 'reconnecting'; s.epoch++; this.metrics.reconnects++;
    this.sink({ kind: 'health', status: 'reconnecting', why, attempt: s.attempts, delay_ms: delay, source_epoch: s.epoch });
    this.logger.warn('reconnecting', { rtms_stream_id: s.streamId, why, attempt: s.attempts, delay_ms: delay });
    this.#set(s, 'reconnect', delay, () => { if (!s.stopRequested && s.state === 'reconnecting') this.#connect(s); });
  }

  #finish(s, state, reason) {
    if (['stopped', 'failed'].includes(s.state)) return;
    s.stopRequested = true; s.state = state; s.endReason = reason;
    for (const n of Object.keys(s.timers)) this.#clear(s, n);
    try { s.adapter?.leave(); } catch { /* best effort */ }
    this.metrics[state === 'stopped' ? 'stopped' : 'failed']++;
    this.sink({ kind: 'health', status: state, reason, source_epoch: s.epoch });
    this.logger.info('session_end', { rtms_stream_id: s.streamId, state, reason });
  }

  /** Cross-check webhook state vs connection state. Returns anomalies found (and heals what it can). */
  reconcile() {
    const out = [];
    const t = this.now();
    for (const s of this.sessions.values()) {
      if (s.state === 'joining' && t - s.startedAt > this.joinTimeoutMs * 2 && s.epoch === 1) out.push({ stream: shortHash(s.streamId), anomaly: 'webhook_without_connection' });
      if (this.tombstones.has(s.streamId) && ['joining', 'active', 'reconnecting'].includes(s.state)) {
        out.push({ stream: shortHash(s.streamId), anomaly: 'connection_after_stop' });
        this.#finish(s, 'stopped', 'reconcile_forced');
      }
    }
    return out;
  }

  /** Global stop: leave everything, never reconnect. */
  stopAll(reason = 'stop_all') {
    for (const s of this.sessions.values()) this.#finish(s, 'stopped', reason);
  }
}

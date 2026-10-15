import { SessionManager } from '../src/session-manager.js';
import { DeadLetter } from '../src/dead-letter.js';

export function fakeClock() {
  let t = 1_700_000_000_000; let id = 0; const q = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { q.set(++id, { fn, at: t + ms }); return id; },
      clearTimeout: (i) => q.delete(i),
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [i, v] of q) if (v.at <= end && (!next || v.at < next.v.at)) next = { i, v };
        if (!next) break;
        q.delete(next.i); t = Math.max(t, next.v.at); next.v.fn();
      }
      t = end;
    },
    pending: () => q.size,
  };
}

export function fakeAdapters() {
  const made = [];
  const factory = (payload) => {
    const a = { payload, left: 0, h: null, connect(h) { a.h = h; }, leave() { a.left++; } };
    made.push(a); return a;
  };
  return { factory, made, last: () => made[made.length - 1] };
}

export const silentLogger = { info() {}, warn() {}, error() {} };

export function setup(opts = {}) {
  const clock = fakeClock(); const ad = fakeAdapters(); const items = []; const dl = new DeadLetter({ now: clock.now });
  const mgr = new SessionManager({
    adapterFactory: ad.factory, sink: (i) => items.push(i), deadLetter: dl, logger: silentLogger,
    now: clock.now, timers: clock.timers, rng: () => 0.5, ...opts,
  });
  return { clock, ad, items, dl, mgr };
}

export const started = (id = 'stream-1', meeting = 'meeting-uuid-1') => ({
  event: 'meeting.rtms_started', event_ts: 1,
  payload: { meeting_uuid: meeting, rtms_stream_id: id, server_urls: 'wss://rtms.example.invalid' },
});
export const stopped = (id = 'stream-1') => ({ event: 'meeting.rtms_stopped', payload: { rtms_stream_id: id, meeting_uuid: 'meeting-uuid-1' } });

export const pcm = (ms, fill = 1) => { const b = Buffer.alloc(ms * 32); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(fill, i); return b; };
export const audio = (a, ts, ms = 20, userId = 7) => a.h.onAudio(pcm(ms), ms * 32, ts, { userId, userName: 'Alice' });

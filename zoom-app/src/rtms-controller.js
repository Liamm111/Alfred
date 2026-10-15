import { compareParticipantLists } from './participants.js';

export const MIN_CLIENT_VERSION = '6.4.10'; // startRTMS: @zoomDesktopClientVersion 6.4.10 (appssdk 0.16.42 typings)
export const CAPABILITIES = ['startRTMS', 'stopRTMS', 'pauseRTMS', 'resumeRTMS', 'getRTMSStatus', 'onRTMSStatusChange',
  'getMeetingUUID', 'getMeetingParticipants', 'getRunningContext'];

/**
 * States:
 *  unavailable       Zoom Apps SDK missing (opened outside Zoom) or config() failed
 *  guest             running as guest / not signed in (Zoom Apps do not support guest mode for RTMS)
 *  not_in_meeting    runningContext is not inMeeting/inWebinar
 *  unsupported       client too old or startRTMS not in the supported API list
 *  ready             can request RTMS (nothing has been requested)
 *  associating       sending nonce + meeting UUID to backend
 *  awaiting_host     startRTMS called; host approval pending
 *  started | paused  RTMS active
 *  denied            host/participant refused (rejection or status "stopped" before "started")
 *  disabled          RTMS disabled by account / host / admin
 *  timeout           no approval answer in time
 *  association_failed backend refused the nonce -> startRTMS is NOT called
 *  stopped           stopped by user or host after start
 *  error
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** Error shapes are not documented as a stable contract: classify on code/message, never expose raw text. */
export function classifyError(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? err ?? ''}`.toLowerCase();
  if (/guest/.test(text)) return 'guest';
  if (/den(y|ied)|reject|declin|refus|not approved|10017/.test(text)) return 'denied';
  if (/disabled|not enabled|not allowed|forbidden|permission|unsupported|not support/.test(text)) return 'disabled';
  return 'error';
}

export class RtmsController {
  constructor({ zoomSdk, association, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, approvalTimeoutMs = 60_000, onChange = () => {} }) {
    Object.assign(this, { zoomSdk, association, setTimeoutFn, clearTimeoutFn, approvalTimeoutMs, onChange });
    this.state = zoomSdk ? 'initializing' : 'unavailable';
    this.detail = {};
    this.participantsBefore = null; this.participantsAfter = null;
    this.timer = null;
  }

  #set(state, detail = {}) { this.state = state; this.detail = detail; this.onChange(state, detail); }

  async init() {
    const sdk = this.zoomSdk;
    if (!sdk) return this.#set('unavailable', { why: 'sdk_missing' });
    let cfg;
    try { cfg = await sdk.config({ capabilities: CAPABILITIES, version: '0.16' }); }
    catch (e) { const c = classifyError(e); return this.#set(c === 'guest' ? 'guest' : 'unavailable', { why: 'config_failed' }); }
    if (!['inMeeting', 'inWebinar'].includes(cfg.runningContext)) return this.#set('not_in_meeting', { context: cfg.runningContext });
    if (compareVersions(cfg.clientVersion ?? '0', MIN_CLIENT_VERSION) < 0) return this.#set('unsupported', { why: 'client_version', clientVersion: cfg.clientVersion });
    if ((cfg.unsupportedApis ?? []).includes('startRTMS')) return this.#set('unsupported', { why: 'api_unsupported' });
    sdk.onRTMSStatusChange?.((e) => this.#onStatus(e));
    try {
      const st = await sdk.getRTMSStatus?.();
      const live = st?.rtmsStatus?.find((s) => ['started', 'paused', 'connecting'].includes(s.status));
      if (live) return this.#set(live.status === 'paused' ? 'paused' : live.status === 'started' ? 'started' : 'awaiting_host');
    } catch { /* status is optional */ }
    this.#set('ready'); // NOTE: nothing is started automatically; only requestStart() (user click) starts RTMS.
  }

  async #snapshot() { try { return (await this.zoomSdk.getMeetingParticipants()).participants; } catch { return null; } }

  /** Must be called from an explicit click handler. */
  async requestStart({ nonce }) {
    if (this.state !== 'ready' && this.state !== 'stopped' && this.state !== 'denied' && this.state !== 'timeout' && this.state !== 'association_failed') return;
    const sdk = this.zoomSdk;
    this.#set('associating');
    let meetingUUID;
    try { meetingUUID = (await sdk.getMeetingUUID()).meetingUUID; } catch { return this.#set('error', { why: 'no_meeting_uuid' }); }
    const a = await this.association.associate({ nonce, meetingUUID });
    if (!a.ok) return this.#set('association_failed', { why: a.reason });
    this.participantsBefore = await this.#snapshot();
    this.#set('awaiting_host');
    this.timer = this.setTimeoutFn(() => { if (this.state === 'awaiting_host') this.#set('timeout'); }, this.approvalTimeoutMs);
    this.timer?.unref?.(); // never keep a Node process alive (tests); no-op in browsers
    try { await sdk.startRTMS(); }
    catch (e) { this.#clearTimer(); const c = classifyError(e); return this.#set(c === 'error' ? 'error' : c, { why: 'startRTMS_rejected' }); }
  }

  #clearTimer() { if (this.timer) { this.clearTimeoutFn(this.timer); this.timer = null; } }

  async #onStatus(e) {
    const s = e?.status;
    if (s === 'started' || s === 'resumed') {
      this.#clearTimer(); this.#set('started');
      this.participantsAfter = await this.#snapshot();
    } else if (s === 'paused') this.#set('paused');
    else if (s === 'stopped') {
      this.#clearTimer();
      this.#set(this.state === 'awaiting_host' ? 'denied' : 'stopped');
    }
  }

  participantsUnchanged() {
    if (!this.participantsBefore || !this.participantsAfter) return null;
    return compareParticipantLists(this.participantsBefore, this.participantsAfter);
  }

  async stop() { this.#clearTimer(); try { await this.zoomSdk.stopRTMS(); } catch (e) { return this.#set('error', { why: 'stopRTMS_rejected' }); } this.#set('stopped'); }
  async pause() { await this.zoomSdk.pauseRTMS(); }
  async resume() { await this.zoomSdk.resumeRTMS(); }
}

/**
 * Session state machine (BLOC 01). Pure and synchronous: `step(ctx, event, now)`
 * returns a new context plus effects; it never performs I/O.
 *
 * FAIL-SAFE INVARIANT: a LIVE_* state can ONLY be entered from an accepted,
 * fresh, non-empty audio/video PACKET. Started / connected callbacks (CONNECTED)
 * never change the state; they are recorded and may raise a
 * `connected_without_media` alert. `presentState` additionally downgrades a
 * stored LIVE_* state whose freshness has lapsed, so a stale LIVE can never be shown.
 */
import { DEFAULT_THRESHOLDS, isFresh, type Thresholds } from "./freshness.js";
import {
  MEDIA_MODALITIES,
  MODALITIES,
  type AlertCode,
  type GapReason,
  type Modality,
  type Packet,
  type SessionOutcome,
  type SessionState,
} from "./schemas.js";

export interface Clock {
  wall_ms: number;
  mono_ms: number;
}

export const TERMINAL_STATES = ["COMPLETED", "PARTIAL", "FAILED"] as const satisfies readonly SessionState[];
export const LIVE_STATES = ["LIVE_AUDIO", "LIVE_VIDEO", "LIVE_AV"] as const satisfies readonly SessionState[];
export const isTerminal = (s: SessionState) => (TERMINAL_STATES as readonly string[]).includes(s);
export const isLive = (s: SessionState) => (LIVE_STATES as readonly string[]).includes(s);
/** Holds capture resources (sources, buffers) and so blocks a second session and is hit by stop-all. */
export const isActive = (s: SessionState) => s !== "IDLE" && !isTerminal(s);

export type MachineEvent =
  | { type: "DETECT"; meeting_uuid: string }
  | { type: "REQUEST_PERMISSION" }
  | { type: "PERMISSION_GRANTED"; source_epoch: number; stream_id?: string | null }
  | { type: "PERMISSION_DENIED" }
  | { type: "CANCEL" }
  | { type: "CONNECTED" }
  | { type: "PACKET"; packet: Packet }
  | { type: "TICK" }
  | { type: "SOURCE_LOST" }
  | { type: "PAUSE" }
  | { type: "RESUME"; source_epoch: number }
  | { type: "RECOVERY_STARTED"; source_epoch: number }
  | { type: "RECOVERY_FAILED" }
  | { type: "STOP" }
  | { type: "FATAL"; reason: string }
  | { type: "FINALIZED" };
export type MachineEventType = MachineEvent["type"];
export const EVENT_TYPES_ALL: readonly MachineEventType[] = [
  "DETECT",
  "REQUEST_PERMISSION",
  "PERMISSION_GRANTED",
  "PERMISSION_DENIED",
  "CANCEL",
  "CONNECTED",
  "PACKET",
  "TICK",
  "SOURCE_LOST",
  "PAUSE",
  "RESUME",
  "RECOVERY_STARTED",
  "RECOVERY_FAILED",
  "STOP",
  "FATAL",
  "FINALIZED",
];

export const ALL_STATES: readonly SessionState[] = [
  "IDLE",
  "DETECTED",
  "PERMISSION",
  "CONNECTING",
  "LIVE_AUDIO",
  "LIVE_VIDEO",
  "LIVE_AV",
  "DEGRADED",
  "PAUSED",
  "RECOVERING",
  "FINALIZING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
];

const L = LIVE_STATES as readonly SessionState[];
/**
 * Authoritative table: which events are legal in which state. Anything absent is an
 * INVALID_TRANSITION. (TICK and STOP are legal everywhere: heartbeat / idempotent stop.)
 */
export const ALLOWED: Record<MachineEventType, readonly SessionState[]> = {
  DETECT: ["IDLE"],
  REQUEST_PERMISSION: ["DETECTED"],
  PERMISSION_GRANTED: ["PERMISSION"],
  PERMISSION_DENIED: ["PERMISSION"],
  CANCEL: ["DETECTED", "PERMISSION"],
  CONNECTED: ["CONNECTING", "RECOVERING"],
  PACKET: ["CONNECTING", ...L, "DEGRADED", "PAUSED", "RECOVERING", "FINALIZING"],
  TICK: ALL_STATES,
  SOURCE_LOST: ["CONNECTING", ...L, "RECOVERING"],
  PAUSE: [...L, "DEGRADED"],
  RESUME: ["PAUSED"],
  RECOVERY_STARTED: ["DEGRADED"],
  RECOVERY_FAILED: ["RECOVERING"],
  STOP: ALL_STATES,
  FATAL: ["DETECTED", "PERMISSION", "CONNECTING", ...L, "DEGRADED", "PAUSED", "RECOVERING", "FINALIZING"],
  FINALIZED: ["FINALIZING"],
};

export type RejectReason =
  | "wrong_session"
  | "stale_epoch"
  | "unknown_epoch"
  | "clock_skew_future"
  | "expired"
  | "duplicate"
  | "out_of_order"
  | "empty_payload"
  | "paused";

export type Effect =
  | { kind: "state_changed"; from: SessionState; to: SessionState; reason: string }
  | { kind: "packet_accepted"; packet_id: string; modality: Modality; late: boolean }
  | { kind: "packet_rejected"; packet_id: string; reason: RejectReason }
  | { kind: "gap_opened"; modality: Modality; reason: GapReason; at_wall_ms: number }
  | { kind: "gap_closed"; modality: Modality; at_wall_ms: number }
  | { kind: "alert_raised"; code: AlertCode; severity: "info" | "warning" | "critical" }
  | { kind: "alert_resolved"; code: AlertCode }
  | { kind: "stop_sources"; reason: string }
  | { kind: "request_recovery" }
  | { kind: "noop"; reason: string };

export interface OpenGap {
  since_wall_ms: number;
  reason: GapReason;
}

export interface SessionContext {
  session_id: string;
  owner_id: string;
  state: SessionState;
  source_epoch: number;
  meeting_uuid: string | null;
  stream_id: string | null;
  /** Bumped on every effective change; maps to the DB optimistic-concurrency column. */
  version: number;
  entered_state_mono_ms: number;
  connected_callback_mono_ms: number | null;
  /** Receiver-monotonic time of the last ACCEPTED fresh packet, per modality. */
  last_fresh_mono: Record<Modality, number | null>;
  last_fresh_wall: Record<Modality, number | null>;
  /** Highest accepted seq per `${epoch}:${modality}`. */
  last_seq: Record<string, number>;
  verified_packets: number;
  open_gaps: Record<Modality, OpenGap | null>;
  gaps_total: number;
  /** Modalities that have ever produced an accepted packet in this session. */
  seen: Record<Modality, boolean>;
  active_alerts: AlertCode[];
  recovery_requested: boolean;
  fatal_reason: string | null;
  stop_reason: string | null;
  outcome: SessionOutcome | null;
  failure_reason: string | null;
  started_wall_ms: number | null;
  ended_wall_ms: number | null;
}

export function newContext(a: { session_id: string; owner_id: string }, now: Clock): SessionContext {
  const none = () => ({ audio: null, video: null, transcript: null });
  return {
    session_id: a.session_id,
    owner_id: a.owner_id,
    state: "IDLE",
    source_epoch: 0,
    meeting_uuid: null,
    stream_id: null,
    version: 0,
    entered_state_mono_ms: now.mono_ms,
    connected_callback_mono_ms: null,
    last_fresh_mono: none(),
    last_fresh_wall: none(),
    last_seq: {},
    verified_packets: 0,
    open_gaps: none(),
    gaps_total: 0,
    seen: { audio: false, video: false, transcript: false },
    active_alerts: [],
    recovery_requested: false,
    fatal_reason: null,
    stop_reason: null,
    outcome: null,
    failure_reason: null,
    started_wall_ms: null,
    ended_wall_ms: null,
  };
}

export type StepResult =
  | { ok: true; ctx: SessionContext; effects: Effect[] }
  | { ok: false; code: "INVALID_TRANSITION" | "INVALID_EVENT"; message: string; ctx: SessionContext; effects: [] };

/** Live state implied purely by freshness of media modalities. null = no media fresh. */
export function liveStateFromFreshness(
  last_fresh_mono: Record<Modality, number | null>,
  nowMono: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): "LIVE_AUDIO" | "LIVE_VIDEO" | "LIVE_AV" | null {
  const a = isFresh(last_fresh_mono.audio, nowMono, "audio", t);
  const v = isFresh(last_fresh_mono.video, nowMono, "video", t);
  if (a && v) return "LIVE_AV";
  if (a) return "LIVE_AUDIO";
  if (v) return "LIVE_VIDEO";
  return null;
}

/**
 * What a UI / API may SAY about the session right now. A stored LIVE_* is downgraded
 * to DEGRADED when freshness has lapsed (e.g. the process stalled and no TICK ran).
 */
export function presentState(
  ctx: SessionContext,
  nowMono: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): { state: SessionState; live: boolean; downgraded: boolean } {
  if (!isLive(ctx.state)) return { state: ctx.state, live: false, downgraded: false };
  const derived = liveStateFromFreshness(ctx.last_fresh_mono, nowMono, t);
  if (derived === null) return { state: "DEGRADED", live: false, downgraded: true };
  return { state: derived, live: true, downgraded: derived !== ctx.state };
}

export class LiveClaimError extends Error {}
/** Guard to call before emitting any "live" signal (notification, badge, push). */
export function assertLiveClaim(ctx: SessionContext, nowMono: number, t: Thresholds = DEFAULT_THRESHOLDS): void {
  const p = presentState(ctx, nowMono, t);
  if (!p.live) throw new LiveClaimError(`session ${ctx.session_id} is not provably live (state=${ctx.state})`);
}

/** Structural invariants that must hold for every reachable context. Returns violations. */
export function checkInvariants(ctx: SessionContext): string[] {
  const v: string[] = [];
  if (isLive(ctx.state)) {
    if (ctx.verified_packets < 1) v.push("LIVE without any verified packet");
    if (MEDIA_MODALITIES.every((m) => ctx.last_fresh_mono[m] === null)) v.push("LIVE without media freshness");
    if (ctx.state === "LIVE_AV" && (ctx.last_fresh_mono.audio === null || ctx.last_fresh_mono.video === null))
      v.push("LIVE_AV without both modalities");
    if (ctx.state === "LIVE_AUDIO" && ctx.last_fresh_mono.audio === null) v.push("LIVE_AUDIO without audio");
    if (ctx.state === "LIVE_VIDEO" && ctx.last_fresh_mono.video === null) v.push("LIVE_VIDEO without video");
  }
  if (isTerminal(ctx.state) && ctx.outcome === null) v.push("terminal without outcome");
  if (!isTerminal(ctx.state) && ctx.outcome !== null) v.push("outcome set on non-terminal state");
  if (ctx.state === "COMPLETED" && ctx.outcome !== "completed") v.push("COMPLETED/outcome mismatch");
  if (ctx.state === "PARTIAL" && ctx.outcome !== "partial") v.push("PARTIAL/outcome mismatch");
  if (ctx.state === "FAILED" && ctx.outcome !== "failed") v.push("FAILED/outcome mismatch");
  if (ctx.state === "COMPLETED" && (ctx.verified_packets === 0 || ctx.fatal_reason || ctx.gaps_total > 0))
    v.push("COMPLETED despite loss or no media");
  if (isTerminal(ctx.state) && MODALITIES.some((m) => ctx.open_gaps[m] !== null)) v.push("open gap in terminal state");
  if (ctx.version < 0) v.push("negative version");
  return v;
}

function ok(ctx: SessionContext, effects: Effect[]): StepResult {
  return { ok: true, ctx, effects };
}

export function step(
  prev: SessionContext,
  event: MachineEvent,
  now: Clock,
  t: Thresholds = DEFAULT_THRESHOLDS,
): StepResult {
  if (!(ALLOWED[event.type] as readonly SessionState[] | undefined)?.includes(prev.state)) {
    if (!(event.type in ALLOWED))
      return { ok: false, code: "INVALID_EVENT", message: `unknown event ${String((event as { type: unknown }).type)}`, ctx: prev, effects: [] };
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      message: `${event.type} not allowed in ${prev.state}`,
      ctx: prev,
      effects: [],
    };
  }
  const ctx = structuredClone(prev);
  const fx: Effect[] = [];

  const go = (to: SessionState, reason: string) => {
    if (ctx.state === to) return;
    fx.push({ kind: "state_changed", from: ctx.state, to, reason });
    ctx.state = to;
    ctx.entered_state_mono_ms = now.mono_ms;
  };
  const raise = (code: AlertCode, severity: "info" | "warning" | "critical") => {
    if (ctx.active_alerts.includes(code)) return;
    ctx.active_alerts.push(code);
    fx.push({ kind: "alert_raised", code, severity });
  };
  const resolve = (code: AlertCode) => {
    const i = ctx.active_alerts.indexOf(code);
    if (i < 0) return;
    ctx.active_alerts.splice(i, 1);
    fx.push({ kind: "alert_resolved", code });
  };
  const openGap = (m: Modality, reason: GapReason) => {
    if (ctx.open_gaps[m] || !ctx.seen[m]) return;
    ctx.open_gaps[m] = { since_wall_ms: now.wall_ms, reason };
    ctx.gaps_total += 1;
    fx.push({ kind: "gap_opened", modality: m, reason, at_wall_ms: now.wall_ms });
  };
  const closeGap = (m: Modality) => {
    if (!ctx.open_gaps[m]) return;
    ctx.open_gaps[m] = null;
    fx.push({ kind: "gap_closed", modality: m, at_wall_ms: now.wall_ms });
  };
  const closeAllGaps = () => MODALITIES.forEach(closeGap);
  const finishTerminal = (to: "COMPLETED" | "PARTIAL" | "FAILED", reason: string | null) => {
    closeAllGaps();
    ctx.outcome = to.toLowerCase() as SessionOutcome;
    ctx.failure_reason = to === "COMPLETED" ? null : reason;
    ctx.ended_wall_ms = now.wall_ms;
    ctx.active_alerts.slice().forEach(resolve);
    go(to, reason ?? "finalized");
    if (to === "PARTIAL") fx.push({ kind: "alert_raised", code: "session_partial", severity: "warning" });
    if (to === "FAILED") fx.push({ kind: "alert_raised", code: "session_failed", severity: "critical" });
  };
  const outcomeNow = (): ["COMPLETED" | "PARTIAL" | "FAILED", string | null] => {
    if (ctx.verified_packets === 0) return ["FAILED", ctx.fatal_reason ?? "no_media_received"];
    if (ctx.fatal_reason) return ["PARTIAL", ctx.fatal_reason];
    if (ctx.gaps_total > 0) return ["PARTIAL", "coverage_gaps"];
    return ["COMPLETED", null];
  };
  const beginFinalize = (reason: string) => {
    ctx.stop_reason ??= reason;
    // Stop-all is atomic per session: sources are told to stop in the same step as the state change.
    fx.push({ kind: "stop_sources", reason });
    // Coverage ended on purpose is not a loss: no gap is opened at stop.
    go("FINALIZING", reason);
  };
  const syncLive = (reasonUp: string) => {
    const derived = liveStateFromFreshness(ctx.last_fresh_mono, now.mono_ms, t);
    if (derived) {
      ctx.recovery_requested = false;
      resolve("media_silence");
      resolve("connected_without_media");
      resolve("recovery_requested");
      // Any seen modality that is no longer fresh is a coverage gap, even when the packet that
      // triggered this evaluation belongs to another modality.
      for (const m of MODALITIES)
        if (ctx.seen[m] && !isFresh(ctx.last_fresh_mono[m], now.mono_ms, m, t)) openGap(m, "silence");
      const lostMedia = MEDIA_MODALITIES.some(
        (m) => ctx.seen[m] && !isFresh(ctx.last_fresh_mono[m], now.mono_ms, m, t),
      );
      if (lostMedia) raise("modality_lost", "warning");
      else resolve("modality_lost");
      if (derived !== ctx.state) go(derived, reasonUp);
    }
  };

  switch (event.type) {
    case "DETECT":
      ctx.meeting_uuid = event.meeting_uuid;
      go("DETECTED", "meeting_detected");
      break;
    case "REQUEST_PERMISSION":
      go("PERMISSION", "permission_requested");
      break;
    case "PERMISSION_GRANTED":
      if (!Number.isInteger(event.source_epoch) || event.source_epoch < 1)
        return { ok: false, code: "INVALID_EVENT", message: "source_epoch must be >= 1", ctx: prev, effects: [] };
      ctx.source_epoch = event.source_epoch;
      ctx.stream_id = event.stream_id ?? null;
      ctx.started_wall_ms = now.wall_ms;
      go("CONNECTING", "permission_granted");
      break;
    case "PERMISSION_DENIED":
      ctx.fatal_reason = "permission_denied";
      finishTerminal("FAILED", "permission_denied");
      break;
    case "CANCEL":
      go("IDLE", "cancelled");
      ctx.meeting_uuid = null;
      break;
    case "CONNECTED":
      // The callback is recorded, nothing else. It is NOT evidence that media flows.
      ctx.connected_callback_mono_ms = now.mono_ms;
      fx.push({ kind: "noop", reason: "connected_callback_is_not_media" });
      break;
    case "PACKET":
      handlePacket(event.packet);
      break;
    case "TICK":
      handleTick();
      break;
    case "SOURCE_LOST":
      if (ctx.state === "CONNECTING") {
        ctx.fatal_reason = "source_lost_before_media";
        finishTerminal("FAILED", "source_lost_before_media");
      } else {
        MODALITIES.forEach((m) => openGap(m, "source_lost"));
        raise("modality_lost", "warning");
        go("DEGRADED", "source_lost");
      }
      break;
    case "PAUSE":
      MODALITIES.forEach((m) => openGap(m, "paused"));
      go("PAUSED", "user_pause");
      break;
    case "RESUME":
    case "RECOVERY_STARTED":
      if (!Number.isInteger(event.source_epoch) || event.source_epoch <= ctx.source_epoch)
        return {
          ok: false,
          code: "INVALID_EVENT",
          message: `source_epoch must increase (${event.source_epoch} <= ${ctx.source_epoch})`,
          ctx: prev,
          effects: [],
        };
      ctx.source_epoch = event.source_epoch;
      ctx.connected_callback_mono_ms = null;
      if (event.type === "RECOVERY_STARTED") raise("recovery_requested", "info");
      go("RECOVERING", event.type === "RESUME" ? "user_resume" : "recovery_started");
      break;
    case "RECOVERY_FAILED":
      raise("recovery_failed", "critical");
      ctx.fatal_reason = "recovery_failed";
      beginFinalize("recovery_failed");
      break;
    case "STOP":
      if (ctx.state === "IDLE" || ctx.state === "FINALIZING" || isTerminal(ctx.state)) {
        // Idempotent: a double Stop changes nothing and says so.
        fx.push({ kind: "noop", reason: ctx.state === "IDLE" ? "nothing_to_stop" : "already_stopping" });
      } else if (ctx.state === "DETECTED" || ctx.state === "PERMISSION") {
        go("IDLE", "stopped_before_capture");
        ctx.meeting_uuid = null;
      } else {
        beginFinalize("user_stop");
      }
      break;
    case "FATAL":
      ctx.fatal_reason ??= event.reason.slice(0, 128);
      if (ctx.state === "FINALIZING") {
        /* already finalizing: remember the reason so the outcome degrades */
      } else if (ctx.verified_packets === 0) {
        finishTerminal("FAILED", ctx.fatal_reason);
        fx.push({ kind: "stop_sources", reason: ctx.fatal_reason });
      } else {
        beginFinalize(ctx.fatal_reason);
      }
      break;
    case "FINALIZED": {
      const [to, why] = outcomeNow();
      finishTerminal(to, why);
      break;
    }
  }

  // Version moves only when the context really changed (a rejected packet or a double Stop does not).
  if (JSON.stringify(ctx) === JSON.stringify(prev)) return ok(prev, fx);
  ctx.version = prev.version + 1;
  return ok(ctx, fx);

  // ---- helpers needing closure over ctx/fx/now -------------------------------------------------

  function reject(p: Packet, reason: RejectReason) {
    fx.push({ kind: "packet_rejected", packet_id: p.id, reason });
  }

  function handlePacket(p: Packet) {
    if (p.session_id !== ctx.session_id || p.owner_id !== ctx.owner_id) return reject(p, "wrong_session");
    if (ctx.state === "PAUSED") return reject(p, "paused");
    if (p.source_epoch < ctx.source_epoch) return reject(p, "stale_epoch");
    if (p.source_epoch > ctx.source_epoch) return reject(p, "unknown_epoch");
    const th = t.modality[p.modality];
    if (p.received_mono_ms > now.mono_ms || p.source_ts_ms - p.received_wall_ms > t.max_future_skew_ms) {
      raise("clock_skew", "warning");
      return reject(p, "clock_skew_future");
    }
    if (now.mono_ms - p.received_mono_ms > th.max_packet_age_ms || p.received_wall_ms - p.source_ts_ms > th.max_source_lag_ms)
      return reject(p, "expired");
    if (p.payload_bytes === 0) return reject(p, "empty_payload");
    const key = `${p.source_epoch}:${p.modality}`;
    const last = ctx.last_seq[key];
    if (last !== undefined && p.seq === last) return reject(p, "duplicate");
    if (last !== undefined && p.seq < last) return reject(p, "out_of_order");

    ctx.last_seq[key] = p.seq;
    if (ctx.state === "FINALIZING") {
      // Late data is kept (storage) but can never prove liveness.
      fx.push({ kind: "packet_accepted", packet_id: p.id, modality: p.modality, late: true });
      return;
    }
    ctx.verified_packets += 1;
    ctx.seen[p.modality] = true;
    ctx.last_fresh_mono[p.modality] = p.received_mono_ms;
    ctx.last_fresh_wall[p.modality] = p.received_wall_ms;
    fx.push({ kind: "packet_accepted", packet_id: p.id, modality: p.modality, late: false });
    closeGap(p.modality);
    syncLive("fresh_media_packet");
  }

  function handleTick(): void {
    const since = now.mono_ms - ctx.entered_state_mono_ms;
    switch (ctx.state) {
      case "CONNECTING":
      case "RECOVERING": {
        const base = ctx.state === "CONNECTING" ? t.connect_timeout_ms : t.recovery_timeout_ms;
        if (ctx.connected_callback_mono_ms !== null && since >= t.connect_warn_ms) raise("connected_without_media", "warning");
        if (since >= base) {
          if (ctx.state === "CONNECTING") {
            raise("connect_timeout", "critical");
            ctx.fatal_reason = "connect_timeout";
            finishTerminal("FAILED", "connect_timeout");
            fx.push({ kind: "stop_sources", reason: "connect_timeout" });
          } else {
            raise("recovery_failed", "critical");
            ctx.fatal_reason = "recovery_timeout";
            beginFinalize("recovery_timeout");
          }
        }
        return;
      }
      case "LIVE_AUDIO":
      case "LIVE_VIDEO":
      case "LIVE_AV": {
        const derived = liveStateFromFreshness(ctx.last_fresh_mono, now.mono_ms, t);
        for (const m of MODALITIES) {
          if (ctx.seen[m] && !isFresh(ctx.last_fresh_mono[m], now.mono_ms, m, t))
            openGap(m, "silence");
        }
        if (derived === null) {
          raise("media_silence", "warning");
          go("DEGRADED", "media_silence");
        } else if (derived !== ctx.state) {
          raise("modality_lost", "warning");
          go(derived, "modality_stale");
        }
        return;
      }
      case "DEGRADED":
        if (!ctx.recovery_requested && since >= t.degraded_recovery_after_ms) {
          ctx.recovery_requested = true;
          fx.push({ kind: "request_recovery" });
        }
        return;
      case "FINALIZING":
        if (since >= t.finalize_timeout_ms) {
          const [to, why] = outcomeNow();
          finishTerminal(to === "COMPLETED" ? "PARTIAL" : to, to === "COMPLETED" ? "finalize_timeout" : why);
          return;
        }
        return;
      default:
        return;
    }
  }
}

/** Convenience for tests / callers that want exceptions. */
export class InvalidTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function stepOrThrow(
  ctx: SessionContext,
  event: MachineEvent,
  now: Clock,
  t: Thresholds = DEFAULT_THRESHOLDS,
): { ctx: SessionContext; effects: Effect[] } {
  const r = step(ctx, event, now, t);
  if (!r.ok) throw new InvalidTransitionError(r.code, r.message);
  return r;
}

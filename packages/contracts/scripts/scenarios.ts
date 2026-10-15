/** Hand-specified public scenarios. Expected states are written by hand, then checked by replayScenario. */
import type { Scenario } from "../src/index.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
type Step = Scenario["steps"][number];
const ev = (advance_ms: number, doIt: Step["do"], expect_state: Step["expect_state"], extra: Partial<Step> = {}): Step =>
  ({ advance_ms, do: doIt, accepted: true, expect_state, ...extra }) as Step;
const pk = (advance_ms: number, modality: "audio" | "video" | "transcript", seq: number, expect_state: Step["expect_state"], o: Record<string, number> = {}, epoch = 1) =>
  ev(advance_ms, { type: "PACKET", modality, seq, source_epoch: epoch, payload_bytes: 320, queued_ms: 0, source_lag_ms: 40, ...o }, expect_state);

const boot = (): Step[] => [
  ev(0, { type: "DETECT", meeting_uuid: "synthetic-meeting-001" }, "DETECTED"),
  ev(100, { type: "REQUEST_PERMISSION" }, "PERMISSION"),
  ev(100, { type: "PERMISSION_GRANTED", source_epoch: 1, stream_id: "synthetic-stream-001" }, "CONNECTING"),
];
const base = (name: string, description: string, steps: Step[], state: Scenario["expect_final"]["state"], outcome: Scenario["expect_final"]["outcome"]): Scenario => ({
  name, description, session_id: SESSION, owner_id: OWNER, steps, expect_final: { state, outcome },
});

export const SCENARIOS: Scenario[] = [
  base("happy_audio_video", "Audio then video prove media; clean stop.", [
    ...boot(),
    ev(50, { type: "CONNECTED" }, "CONNECTING"),
    pk(500, "audio", 0, "LIVE_AUDIO"),
    pk(200, "video", 0, "LIVE_AV"),
    pk(1000, "audio", 1, "LIVE_AV"),
    ev(100, { type: "STOP" }, "FINALIZING"),
    ev(100, { type: "FINALIZED" }, "COMPLETED"),
  ], "COMPLETED", "completed"),
  base("connected_without_media", "Connected callback never proves media: the session fails after the timeout.", [
    ...boot(),
    ev(50, { type: "CONNECTED" }, "CONNECTING", { expect_effects: ["connected_callback_is_not_media"] }),
    ev(8000, { type: "TICK" }, "CONNECTING", { expect_effects: ["alert_raised"] }),
    ev(12000, { type: "TICK" }, "FAILED", { expect_effects: ["stop_sources"] }),
  ], "FAILED", "failed"),
  base("audio_only", "Only audio flows.", [...boot(), pk(300, "audio", 0, "LIVE_AUDIO"), pk(1000, "audio", 1, "LIVE_AUDIO"), ev(100, { type: "STOP" }, "FINALIZING"), ev(0, { type: "FINALIZED" }, "COMPLETED")], "COMPLETED", "completed"),
  base("video_only", "Only video flows.", [...boot(), pk(300, "video", 0, "LIVE_VIDEO"), pk(1000, "video", 1, "LIVE_VIDEO"), ev(100, { type: "STOP" }, "FINALIZING"), ev(0, { type: "FINALIZED" }, "COMPLETED")], "COMPLETED", "completed"),
  base("silence_then_recovery", "Silence degrades, recovery on a new epoch restores LIVE; result is PARTIAL because of the gap.", [
    ...boot(),
    pk(300, "audio", 0, "LIVE_AUDIO"),
    ev(3500, { type: "TICK" }, "DEGRADED", { expect_effects: ["gap_opened"] }),
    ev(10000, { type: "TICK" }, "DEGRADED", { expect_effects: ["request_recovery"] }),
    ev(10, { type: "RECOVERY_STARTED", source_epoch: 2 }, "RECOVERING"),
    ev(10, { type: "CONNECTED" }, "RECOVERING"),
    pk(300, "audio", 0, "LIVE_AUDIO", {}, 2),
    ev(100, { type: "STOP" }, "FINALIZING"),
    ev(0, { type: "FINALIZED" }, "PARTIAL"),
  ], "PARTIAL", "partial"),
  base("expired_and_stale_packets", "Expired, duplicate and stale-epoch packets never create LIVE.", [
    ...boot(),
    pk(100, "audio", 0, "CONNECTING", { queued_ms: 6000 }),
    pk(100, "audio", 0, "CONNECTING", { source_lag_ms: 20000 }),
    pk(100, "audio", 0, "CONNECTING", { payload_bytes: 0 }),
    pk(100, "audio", 0, "CONNECTING", {}, 9),
    pk(100, "audio", 0, "LIVE_AUDIO"),
    pk(100, "audio", 0, "LIVE_AUDIO"),
    ev(100, { type: "STOP" }, "FINALIZING"),
    ev(0, { type: "FINALIZED" }, "COMPLETED"),
  ], "COMPLETED", "completed"),
  base("double_stop", "A second Stop is an idempotent no-op.", [
    ...boot(),
    pk(300, "audio", 0, "LIVE_AUDIO"),
    ev(100, { type: "STOP" }, "FINALIZING", { expect_effects: ["stop_sources"] }),
    ev(10, { type: "STOP" }, "FINALIZING", { expect_effects: ["already_stopping"] }),
    ev(10, { type: "FINALIZED" }, "COMPLETED"),
    ev(10, { type: "STOP" }, "COMPLETED", { expect_effects: ["already_stopping"] }),
  ], "COMPLETED", "completed"),
  base("invalid_transitions", "Illegal events are refused and leave the state untouched.", [
    ev(0, { type: "FINALIZED" }, "IDLE", { accepted: false }),
    ev(0, { type: "CONNECTED" }, "IDLE", { accepted: false }),
    ev(0, { type: "PAUSE" }, "IDLE", { accepted: false }),
    ev(0, { type: "DETECT", meeting_uuid: "synthetic-meeting-002" }, "DETECTED"),
    ev(0, { type: "PERMISSION_GRANTED", source_epoch: 1 }, "DETECTED", { accepted: false }),
    ev(0, { type: "CANCEL" }, "IDLE"),
  ], "IDLE", null),
];

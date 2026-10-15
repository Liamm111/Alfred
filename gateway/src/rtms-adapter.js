// Thin adapter around the official @zoom/rtms Node SDK (pinned 1.1.0).
// It is the ONLY file importing the SDK. Everything else is testable with a fake adapter.
import { reasonName } from './stop-reasons.js';

export async function createSdkAdapterFactory({ client, secret, logger, pollInterval = 10 } = {}) {
  const rtms = (await import('@zoom/rtms')).default;
  const stopTable = rtms.StopReason;
  return function adapterFactory(payload) {
    const c = new rtms.Client();
    let left = false;
    return {
      connect(h) {
        c.setAudioParams?.({
          contentType: rtms.AudioContentType?.RAW_AUDIO ?? 2,
          codec: rtms.AudioCodec.L16,
          sampleRate: rtms.AudioSampleRate.SR_16K,
          channel: rtms.AudioChannel.MONO,
          dataOpt: rtms.AudioDataOption.AUDIO_MULTI_STREAMS,
          duration: 20,
        });
        c.onJoinConfirm((reason) => h.onJoin(reason === rtms.RTMS_SDK_OK, reasonName(stopTable, reason)));
        c.onAudioData((buf, size, ts, md) => h.onAudio(buf, size, ts, md));
        c.onTranscriptData((buf, size, ts, md) => h.onTranscript(buf, size, ts, md));
        c.onDeskshareData?.((buf, size, ts, md) => h.onShare(buf, size, ts, md));
        c.onSharingEvent?.((e, ts, uid) => h.onSharingEvent(e, ts, uid));
        c.onParticipantEvent?.(() => h.onActivity());
        c.onActiveSpeakerEvent?.(() => h.onActivity());
        c.onMediaConnectionInterrupted?.(() => h.onLeave('DATA_CONNECTION_INTERRUPTED'));
        c.onLeave((reason) => { left = true; h.onLeave(reasonName(stopTable, reason)); });
        const ok = c.join({
          meeting_uuid: payload.meeting_uuid, rtms_stream_id: payload.rtms_stream_id, server_urls: payload.server_urls,
          client: process.env.ZM_RTMS_CLIENT, secret: secret ?? process.env.ZM_RTMS_SECRET, pollInterval,
        });
        if (!ok) throw new Error('rtms_join_returned_false');
      },
      leave() { if (!left) { left = true; try { c.leave(); } catch (e) { logger?.warn('leave_failed', { error: String(e?.message) }); } } },
    };
  };
}
// Not wired in Node SDK 1.1.0: chat callbacks (MEDIA_TYPE_CHAT constant exists, no onChatData). See reports/BLOC_06.md.

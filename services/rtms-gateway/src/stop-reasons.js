// Classification of RTMS stop/leave reasons (names from @zoom/rtms 1.1.0 StopReason table).
// terminal  -> the user/host/Zoom ended it: NEVER reconnect.
// transient -> network-ish failure: reconnect with backoff, source_epoch++.
// fatal     -> our credentials/config are wrong: do not hammer Zoom, alert.
export const TERMINAL = new Set([
  'HOST_TRIGGERED', 'USER_TRIGGERED', 'USER_LEFT', 'USER_EJECTED', 'HOST_DISABLED_APP', 'MEETING_ENDED',
  'STREAM_CANCELED', 'STREAM_REVOKED', 'ALL_APPS_DISABLED', 'RECEIVER_REQUEST_CLOSE', 'CUSTOMER_DISCONNECTED',
  'AGENT_DISCONNECTED', 'ADMIN_DISABLED_APP', 'MANUAL_API_TRIGGERED', 'EXIT_SIGNAL', 'STREAMING_NOT_SUPPORTED',
]);
export const FATAL = new Set(['AUTHENTICATION_FAILURE']);

export function classifyStop(reasonName) {
  if (TERMINAL.has(reasonName)) return 'terminal';
  if (FATAL.has(reasonName)) return 'fatal';
  return 'transient'; // unknown / network / timeouts: retry (bounded by maxReconnect)
}

/** numeric SDK code -> name, using the SDK's StopReason table */
export function reasonName(table, code) {
  for (const [k, v] of Object.entries(table ?? {})) if (v === code) return k;
  return 'UNDEFINED';
}

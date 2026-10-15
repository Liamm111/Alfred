// Compare two participant lists (from zoomSdk.getMeetingParticipants) to prove that starting RTMS
// from the Zoom App did NOT add a participant (no bot joins the meeting).
const keyOf = (p) => p.participantUUID ?? p.participantId ?? p.screenName;

export function compareParticipantLists(before, after) {
  const b = new Map(before.map((p) => [keyOf(p), p])); const a = new Map(after.map((p) => [keyOf(p), p]));
  const added = [...a.keys()].filter((k) => !b.has(k));
  const removed = [...b.keys()].filter((k) => !a.has(k));
  return { same: added.length === 0 && removed.length === 0, addedCount: added.length, removedCount: removed.length, beforeCount: b.size, afterCount: a.size };
}

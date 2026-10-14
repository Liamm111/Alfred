/**
 * Provider-agnostic meeting bot port (PRD ADR-01: RTMS stays a future alternative behind this interface).
 * Deliberately has NO audio-output / speak / chat-send capability (PRD A08, ADR-05): the architecture cannot talk in a meeting.
 */
export interface CreateBotInput {
  /** Stable idempotency key (course occurrence + schedule version). Providers may not honour it: callers must reconcile. */
  idempotencyKey: string;
  meetingUrl: string;
  botDisplayName: string;
  joinAt?: Date;
}

export interface BotRef {
  providerBotId: string;
  /** True for the simulated provider; surfaced in UI/API so a simulation is never mistaken for a real capture. */
  simulated: boolean;
}

export type BotLifecycleCode =
  | 'joining_call'
  | 'in_waiting_room'
  | 'in_call_not_recording'
  | 'recording_permission_allowed'
  | 'recording_permission_denied'
  | 'in_call_recording'
  | 'call_ended'
  | 'done'
  | 'fatal';

export interface MeetingProvider {
  readonly name: string;
  readonly simulated: boolean;
  /** Find a bot previously created with this key (reconciliation before any new creation, PRD Z06). */
  findBotByIdempotencyKey(key: string): Promise<BotRef | null>;
  createBot(input: CreateBotInput): Promise<BotRef>;
  cancelBot(providerBotId: string): Promise<void>;
}

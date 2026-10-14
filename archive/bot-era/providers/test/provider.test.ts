import { describe, expect, it } from 'vitest';
import { createMeetingProvider, MockMeetingProvider, ProviderNotConfiguredError } from '../src';

describe('provider factory', () => {
  it('never silently simulates: MOCK_MODE=false without a real adapter throws', () => {
    expect(() => createMeetingProvider({ MOCK_MODE: false })).toThrow(ProviderNotConfiguredError);
  });
  it('returns the simulated provider only when MOCK_MODE=true, flagged simulated', () => {
    const p = createMeetingProvider({ MOCK_MODE: true });
    expect(p.simulated).toBe(true);
  });
  it('mock createBot is idempotent per key and findable', async () => {
    const p = new MockMeetingProvider();
    const a = await p.createBot({ idempotencyKey: 'k', meetingUrl: 'https://zoom.us/j/1', botDisplayName: 'Assistant IA de Test' });
    const b = await p.createBot({ idempotencyKey: 'k', meetingUrl: 'https://zoom.us/j/1', botDisplayName: 'Assistant IA de Test' });
    expect(b).toEqual(a);
    expect(await p.findBotByIdempotencyKey('k')).toEqual(a);
  });
  it('port exposes no speak/chat/audio-output capability (PRD A08)', () => {
    const p = new MockMeetingProvider() as unknown as Record<string, unknown>;
    for (const k of ['speak', 'say', 'sendChat', 'sendMessage', 'outputAudio', 'playAudio']) expect(p[k]).toBeUndefined();
  });
});

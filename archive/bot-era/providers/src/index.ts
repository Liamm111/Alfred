import type { Env } from '@alfred/core';
import { MockMeetingProvider } from './mock';

export * from './meeting-provider';
export { MockMeetingProvider, DEMO_TRANSCRIPT } from './mock';

export class ProviderNotConfiguredError extends Error {
  constructor(public readonly provider: string) {
    super(`Provider "${provider}" is not configured: no real adapter is implemented/verified (gate REAL-* NOT VERIFIED)`);
    this.name = 'ProviderNotConfiguredError';
  }
}

/**
 * The ONLY place a provider implementation is chosen. The simulated provider is returned iff MOCK_MODE=true
 * (which env validation forbids in production). Otherwise we fail loudly instead of silently simulating.
 */
export function createMeetingProvider(env: Pick<Env, 'MOCK_MODE'>) {
  if (env.MOCK_MODE) return new MockMeetingProvider();
  throw new ProviderNotConfiguredError('recall');
}

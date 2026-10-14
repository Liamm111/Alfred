import type { BotRef, CreateBotInput, MeetingProvider } from './meeting-provider';

/** Fully synthetic classroom snippet for the dev demo. Fictional people; no real data. */
export const DEMO_TRANSCRIPT = [
  { id: 'demo-1', speaker: 'Enseignante (simulée)', startMs: 0, text: "Bonjour à tous, aujourd'hui on voit les probabilités conditionnelles." },
  { id: 'demo-2', speaker: 'Enseignante (simulée)', startMs: 8000, text: 'Alex, peux-tu expliquer ta réponse à l’exercice 3 ?' },
  { id: 'demo-3', speaker: 'Enseignante (simulée)', startMs: 20000, text: 'Pour mardi, vous devez tous rendre le TP.' },
] as const;

export class MockMeetingProvider implements MeetingProvider {
  readonly name = 'mock';
  readonly simulated = true;
  private readonly byKey = new Map<string, BotRef>();
  readonly cancelled = new Set<string>();

  async findBotByIdempotencyKey(key: string): Promise<BotRef | null> {
    return this.byKey.get(key) ?? null;
  }
  async createBot(input: CreateBotInput): Promise<BotRef> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return existing;
    const ref: BotRef = { providerBotId: `mock-bot-${this.byKey.size + 1}`, simulated: true };
    this.byKey.set(input.idempotencyKey, ref);
    return ref;
  }
  async cancelBot(providerBotId: string): Promise<void> {
    this.cancelled.add(providerBotId);
  }
}

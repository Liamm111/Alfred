import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { scanText } from '../secrets-scan.mjs';

describe('secrets scanner', () => {
  it('flags realistic leaks (fixtures built at runtime, not committed as literals)', () => {
    const fake = (p: string, n: number) => p + 'A1b2C3d4'.repeat(n);
    expect(scanText(`RECALL_WEBHOOK_SECRET=${fake('whsec_', 3)}`)).toContain('recall/svix webhook secret');
    expect(scanText(`k = "${fake('sk-', 4)}"`)).toContain('openai/anthropic-style key');
    expect(scanText(['-----BEGIN', 'PRIVATE KEY-----'].join(' '))).toContain('private key block');
    expect(scanText(`DEEPGRAM_API_KEY=${fake('', 4)}`)).toContain('secret-looking env assignment');
  });
  it('accepts empty/commented placeholders and local dev URLs', () => {
    expect(scanText('HEALTH_TOKEN=                      # required\nDATABASE_URL=postgres://alfred:alfred@localhost:5432/alfred')).toEqual([]);
  });
});

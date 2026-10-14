import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../src/env';

const prod = { APP_ENV: 'production', DATABASE_URL: 'postgres://x', HEALTH_TOKEN: 'h'.repeat(24), PUBLIC_WEB_ORIGIN: 'https://app.example.test' };

describe('env schema / MOCK_MODE guard', () => {
  it('defaults: development, mock off', () => {
    const env = parseEnv({});
    expect(env.APP_ENV).toBe('development');
    expect(env.MOCK_MODE).toBe(false);
  });
  it('mock allowed in test and development', () => {
    expect(parseEnv({ APP_ENV: 'test', MOCK_MODE: 'true' }).MOCK_MODE).toBe(true);
    expect(parseEnv({ MOCK_MODE: 'true' }).MOCK_MODE).toBe(true);
  });
  it('MOCK_MODE=true is impossible in production', () => {
    expect(() => parseEnv({ ...prod, MOCK_MODE: 'true' })).toThrow(EnvError);
    expect(() => parseEnv({ ...prod, MOCK_MODE: 'true' })).toThrow(/forbidden when APP_ENV=production/);
    expect(parseEnv({ ...prod, MOCK_MODE: 'false' }).MOCK_MODE).toBe(false);
  });
  it.each(['1', 'yes', 'TRUE', ''])('rejects ambiguous MOCK_MODE %j', (v) => {
    expect(() => parseEnv({ MOCK_MODE: v })).toThrow(EnvError);
  });
  it('rejects unknown APP_ENV', () => {
    expect(() => parseEnv({ APP_ENV: 'prod' })).toThrow(EnvError);
  });
  it('production requires health token, database url and https origin', () => {
    expect(() => parseEnv({ APP_ENV: 'production' })).toThrow(/HEALTH_TOKEN/);
    expect(() => parseEnv({ ...prod, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...prod, PUBLIC_WEB_ORIGIN: 'http://insecure.test' })).toThrow(/https/);
  });
  it('error messages never contain values', () => {
    try {
      parseEnv({ ...prod, HEALTH_TOKEN: 'short-secret-value' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('short-secret-value');
    }
  });
});

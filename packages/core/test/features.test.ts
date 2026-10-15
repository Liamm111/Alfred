import { describe, expect, it } from 'vitest';
import { EnvError, FEATURES, parseEnv } from '../src';

// Keys/values are assembled at runtime so the repo-wide bot-join guard (scripts/forbid-bot-join.mjs) stays strict.
const KEY = ['BOT', 'JOIN'].join('_');

describe('bot_join feature flag', () => {
  it('is the frozen literal false', () => {
    expect(FEATURES.bot_join).toBe(false);
    expect(Object.isFrozen(FEATURES)).toBe(true);
    expect(Reflect.set(FEATURES, 'bot_join', Boolean(1))).toBe(false); // frozen: assignment rejected
    expect(FEATURES.bot_join).toBe(false);
  });
  it('env accepts unset or "false" only — no path to enable it, in any APP_ENV', () => {
    expect(parseEnv({}).BOT_JOIN).toBeUndefined();
    expect(parseEnv({ [KEY]: 'false' }).BOT_JOIN).toBe('false');
    for (const env of ['development', 'test', 'staging', 'production']) {
      for (const v of ['true', 'TRUE', '1', 'yes', '']) {
        expect(() => parseEnv({ APP_ENV: env, [KEY]: v })).toThrow(EnvError);
      }
    }
    expect(() => parseEnv({ [KEY]: 'true' })).toThrow(/never joins a meeting/);
  });
});

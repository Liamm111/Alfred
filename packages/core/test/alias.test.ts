import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { aliasListSchema, normalizeAlias } from '../src/alias';
import { DEFAULT_PREFERENCES, preferencesInputSchema } from '../src/contracts/preferences';

describe('normalizeAlias', () => {
  it.each([
    ['Éloïse-Marie', 'eloise marie'],
    ["  Liam  ", 'liam'],
    ["M. Pioline", 'm pioline'],
    ['Jean-Pierre', 'jean pierre'],
    ['Œdipe', 'oedipe'],
    ['ÅSA', 'asa'],
    ['Zoë', 'zoe'],
  ])('%s → %s', (i, o) => expect(normalizeAlias(i)).toBe(o));

  it('is idempotent, trimmed, single-spaced (property)', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const n = normalizeAlias(s);
      return normalizeAlias(n) === n && n === n.trim() && !n.includes('  ');
    }), { numRuns: 500 });
  });
  it('accent/case-insensitive equivalence (property)', () => {
    const letters = fc.constantFrom(...'abcdeéèêëiîïoôuùûçn'.split(''));
    fc.assert(fc.property(fc.array(letters, { minLength: 2, maxLength: 12 }).map((a) => a.join('')), (s) => {
      return normalizeAlias(s.toUpperCase()) === normalizeAlias(s) && normalizeAlias(s.normalize('NFD')) === normalizeAlias(s);
    }), { numRuns: 300 });
  });
});

describe('aliasListSchema', () => {
  it('stores raw + normalized', () => {
    expect(aliasListSchema.parse(['Liam', 'Monsieur Pioline'])).toEqual([
      { raw: 'Liam', normalized: 'liam' },
      { raw: 'Monsieur Pioline', normalized: 'monsieur pioline' },
    ]);
  });
  it('rejects duplicates after normalization, markup, bidi/control chars, too short, too many', () => {
    expect(aliasListSchema.safeParse(['Liam', 'LIAM']).success).toBe(false);
    expect(aliasListSchema.safeParse(['Éloïse', 'eloise']).success).toBe(false);
    expect(aliasListSchema.safeParse(['<script>alert(1)</script>']).success).toBe(false);
    expect(aliasListSchema.safeParse(['Li‮am']).success).toBe(false);
    expect(aliasListSchema.safeParse(['Li​am']).success).toBe(false);
    expect(aliasListSchema.safeParse(['a']).success).toBe(false);
    expect(aliasListSchema.safeParse(['x'.repeat(51)]).success).toBe(false);
    expect(aliasListSchema.safeParse(Array.from({ length: 11 }, (_, i) => `Alias${String.fromCharCode(97 + i)}`)).success).toBe(false);
  });
});

describe('preferencesInputSchema', () => {
  const ok = { firstName: 'Liam', aliases: ['Liam'], timezone: 'Europe/Paris', alertPreferences: { mode: 'in_app_only', notificationPrivacy: 'discreet', acceptInAppOnly: true }, retentionVerbatimDays: 30, retentionSummaryDays: 90 };
  it('accepts a valid payload and applies FR defaults', () => {
    const p = preferencesInputSchema.parse(ok);
    expect(p.locale).toBe('fr');
    expect(p.summaryLanguage).toBe('fr');
  });
  it.each([['Mars/Olympus'], ['+02:00'], ['europe/paris'], ['Asia/Calcutta '], ['']])('rejects timezone %j', (tz) => {
    expect(preferencesInputSchema.safeParse({ ...ok, timezone: tz }).success).toBe(false);
  });
  it('accepts UTC and canonical zones; rejects unknown keys (strict) and out-of-range retention', () => {
    expect(preferencesInputSchema.safeParse({ ...ok, timezone: 'UTC' }).success).toBe(true);
    expect(preferencesInputSchema.safeParse({ ...ok, userId: 'someone-else' }).success).toBe(false);
    expect(preferencesInputSchema.safeParse({ ...ok, retentionVerbatimDays: 0 }).success).toBe(false);
    expect(preferencesInputSchema.safeParse({ ...ok, retentionSummaryDays: 5000 }).success).toBe(false);
  });
  it('defaults are French, Europe/Paris, discreet, 30/90 days, flagged as defaults', () => {
    expect(DEFAULT_PREFERENCES).toMatchObject({ locale: 'fr', timezone: 'Europe/Paris', retentionVerbatimDays: 30, retentionSummaryDays: 90, isDefault: true });
    expect(DEFAULT_PREFERENCES.alertPreferences.notificationPrivacy).toBe('discreet');
  });
});

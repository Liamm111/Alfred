import { z } from 'zod';

const LIGATURES: Record<string, string> = { œ: 'oe', æ: 'ae', ß: 'ss', ø: 'o', đ: 'd', ł: 'l' };

/**
 * Exact-match key for aliases (PRD §6): accent- and punctuation-insensitive, case-insensitive, whitespace-collapsed.
 * "Éloïse-Marie" → "eloise marie". Idempotent. Phonetic/fuzzy matching is deliberately NOT done here (T08: controlled lists).
 */
export function normalizeAlias(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[œæßøđł]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Letters, digits, spaces, apostrophes, hyphens, dots only: no markup, no control/format/bidi characters (Q07). */
const ALIAS_CHARS = /^[\p{L}\p{M}\p{N}' .’-]+$/u;

export const MAX_ALIASES = 10;

export const aliasInputSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(2, 'Alias trop court')
      .max(50, 'Alias trop long (50 caractères max)')
      .regex(ALIAS_CHARS, 'Caractères non autorisés (lettres, chiffres, espace, apostrophe, tiret)')
      .refine((s) => normalizeAlias(s).length >= 2, 'Alias trop court'),
  );

export const storedAliasSchema = z.object({ raw: z.string(), normalized: z.string() });
export type StoredAliasDto = z.infer<typeof storedAliasSchema>;

/** Validate a list of raw aliases: bounded, no duplicates after normalization (explicit error rather than silent dedupe). */
export const aliasListSchema = z
  .array(aliasInputSchema)
  .max(MAX_ALIASES, `${MAX_ALIASES} alias maximum`)
  .transform((list, ctx): StoredAliasDto[] => {
    const seen = new Set<string>();
    const out: StoredAliasDto[] = [];
    list.forEach((raw, i) => {
      const normalized = normalizeAlias(raw);
      if (seen.has(normalized)) ctx.addIssue({ code: 'custom', path: [i], message: `Alias en double : « ${raw} »` });
      seen.add(normalized);
      out.push({ raw, normalized });
    });
    return out;
  });

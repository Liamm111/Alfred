import { z } from 'zod';
import { aliasListSchema, storedAliasSchema } from '../alias';

/** IANA zone names as known to this runtime (canonical names + "UTC"). Rejects offsets and legacy aliases. */
const IANA = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);
export const timezoneSchema = z.string().refine((tz) => IANA.has(tz), 'Fuseau horaire IANA invalide');

const alertPreferencesSchema = z
  .object({
    mode: z.enum(['push_and_in_app', 'in_app_only']),
    notificationPrivacy: z.enum(['discreet', 'detailed']),
    /** Explicit acceptance required when push is not (yet) available (PRD §2.1). */
    acceptInAppOnly: z.boolean(),
  })
  .strict();

const firstNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Prénom requis').max(50).regex(/^[\p{L}\p{M}' .’-]+$/u, 'Caractères non autorisés'));

/** Body of PUT /api/me/preferences. `version` = optimistic concurrency (omit on first save). */
export const preferencesInputSchema = z
  .object({
    firstName: firstNameSchema,
    aliases: aliasListSchema,
    locale: z.enum(['fr', 'en']).default('fr'),
    summaryLanguage: z.enum(['fr', 'en']).default('fr'),
    timezone: timezoneSchema,
    alertPreferences: alertPreferencesSchema,
    retentionVerbatimDays: z.number().int().min(1).max(365),
    retentionSummaryDays: z.number().int().min(1).max(1095),
    completeOnboarding: z.boolean().default(false),
    version: z.number().int().min(1).optional(),
  })
  .strict();
export type PreferencesInput = z.infer<typeof preferencesInputSchema>;
export type PreferencesFormInput = z.input<typeof preferencesInputSchema>;

export const preferencesSchema = z.object({
  firstName: z.string(),
  aliases: z.array(storedAliasSchema),
  locale: z.enum(['fr', 'en']),
  summaryLanguage: z.enum(['fr', 'en']),
  timezone: z.string(),
  alertPreferences: alertPreferencesSchema,
  retentionVerbatimDays: z.number(),
  retentionSummaryDays: z.number(),
  onboardingCompleted: z.boolean(),
  version: z.number(),
  /** true when nothing was ever saved: these are server defaults, not user choices. */
  isDefault: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  firstName: '',
  aliases: [],
  locale: 'fr',
  summaryLanguage: 'fr',
  timezone: 'Europe/Paris',
  alertPreferences: { mode: 'push_and_in_app', notificationPrivacy: 'discreet', acceptInAppOnly: false },
  retentionVerbatimDays: 30,
  retentionSummaryDays: 90,
  onboardingCompleted: false,
  version: 0,
  isDefault: true,
};

export const meSchema = z.object({ id: z.string(), email: z.string(), onboardingCompleted: z.boolean() });
export type Me = z.infer<typeof meSchema>;

export const sessionInfoSchema = z.object({ id: z.string(), createdAt: z.string(), expiresAt: z.string(), userAgent: z.string().nullable(), current: z.boolean() });
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

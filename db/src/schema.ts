import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Durable job queue AND transactional outbox: a producer inserts a row in the SAME transaction as its business write
 * (PRD §4.1 / E04), so a crash after commit never loses the job and a rollback never leaves a phantom job.
 * `payload` carries small, NON-sensitive metadata only (ids, versions); never transcript text, emails or URLs.
 */
export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    uniqueKey: text('unique_key').notNull(),
    payloadReference: text('payload_reference'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockedBy: text('locked_by'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    unique('job_queue_type_unique_key_uq').on(t.type, t.uniqueKey),
    check('job_queue_status_chk', sql`${t.status} in ('pending','running','succeeded','dead')`),
    check('job_queue_attempts_chk', sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
    index('job_queue_claim_idx').on(t.status, t.availableAt),
  ],
);

/** Minimal audit trail (PRD §5.1): never stores verbatim private content. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id'),
    targetId: text('target_id'),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    minimalMetadata: jsonb('minimal_metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_events_user_idx').on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------------------------------
// Identity (BLOC 02). `users` follows PRD §5.1; the extra columns (name, emailVerified, image, updatedAt) and the three
// auth_* tables are required by the auth library (Better Auth). Property names MUST match the library's field names.
// ---------------------------------------------------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_accounts_user_idx').on(t.userId)],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

export interface StoredAlias { raw: string; normalized: string }
export interface StoredAlertPreferences {
  /** 'push_and_in_app' needs a verified push subscription (later block); 'in_app_only' is an explicit user acceptance (PRD §2.1). */
  mode: 'push_and_in_app' | 'in_app_only';
  /** discreet = no verbatim on lock screen (PRD N06). */
  notificationPrivacy: 'discreet' | 'detailed';
  acceptInAppOnly: boolean;
}

export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    firstName: text('first_name').notNull().default(''),
    aliases: jsonb('aliases').$type<StoredAlias[]>().notNull().default([]),
    locale: text('locale').notNull().default('fr'),
    summaryLanguage: text('summary_language').notNull().default('fr'),
    timezone: text('timezone').notNull().default('Europe/Paris'),
    alertPreferences: jsonb('alert_preferences').$type<StoredAlertPreferences>().notNull(),
    retentionVerbatimDays: integer('retention_verbatim_days').notNull().default(30),
    retentionSummaryDays: integer('retention_summary_days').notNull().default(90),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_preferences_retention_chk', sql`${t.retentionVerbatimDays} between 1 and 365 and ${t.retentionSummaryDays} between 1 and 1095`),
    check('user_preferences_locale_chk', sql`${t.locale} in ('fr','en')`),
  ],
);

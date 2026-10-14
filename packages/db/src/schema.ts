import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

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

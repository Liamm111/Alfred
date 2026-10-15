import { z } from 'zod';

/** Contracts v1 — versioned; breaking changes require a v2 module. */
export const CONTRACT_VERSION = 'v1' as const;

export const healthLiveSchema = z.object({ status: z.literal('ok') });
export type HealthLive = z.infer<typeof healthLiveSchema>;

export const healthReadySchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.object({
    database: z.enum(['ok', 'fail']),
    schema: z.enum(['ok', 'behind', 'unknown']),
  }),
  schemaVersion: z.string().nullable(),
  mockMode: z.boolean(),
});
export type HealthReady = z.infer<typeof healthReadySchema>;

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'dead'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Page contract shared by list endpoints (PRD §14: pagination + limits). */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

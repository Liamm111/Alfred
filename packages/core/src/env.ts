import { z } from 'zod';

export const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Strict boolean: only the literal strings "true" / "false" are accepted (no "1", "yes", ...). */
const strictBool = z.enum(['true', 'false']).transform((v) => v === 'true');

const baseSchema = z.object({
  APP_ENV: z.enum(APP_ENVS).default('development'),
  MOCK_MODE: strictBool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).optional(),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_WEB_ORIGIN: z.url().default('http://localhost:3000'),
  HEALTH_TOKEN: z.string().min(24).optional(),
  MIGRATIONS_DIR: z.string().optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(10).default(1000),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).default(60_000),
});

export const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.APP_ENV === 'production' && env.MOCK_MODE) {
    ctx.addIssue({ code: 'custom', path: ['MOCK_MODE'], message: 'MOCK_MODE=true is forbidden when APP_ENV=production' });
  }
  if ((env.APP_ENV === 'production' || env.APP_ENV === 'staging') && !env.HEALTH_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['HEALTH_TOKEN'], message: 'HEALTH_TOKEN (>=24 chars) is required in staging/production' });
  }
  if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test' && !env.DATABASE_URL) {
    ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL is required outside development/test' });
  }
  if (env.APP_ENV === 'production' && env.PUBLIC_WEB_ORIGIN.startsWith('http://')) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_WEB_ORIGIN'], message: 'PUBLIC_WEB_ORIGIN must be https in production' });
  }
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment: ${issues.join('; ')}`);
    this.name = 'EnvError';
  }
}

/** Parse + validate. Error messages contain variable names only, never values. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}

export function requireDatabaseUrl(env: Env): string {
  if (!env.DATABASE_URL) throw new EnvError(['DATABASE_URL: required']);
  return env.DATABASE_URL;
}

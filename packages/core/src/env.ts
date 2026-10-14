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
  AUTH_SECRET: z.string().min(32).optional(),
  EMAIL_TRANSPORT: z.enum(['disabled', 'file', 'smtp']).default('disabled'),
  EMAIL_FROM: z.string().min(3).default('Assistant IA <no-reply@localhost>'),
  EMAIL_OUTBOX_DIR: z.string().optional(),
  SMTP_URL: z.string().optional(),
  AUTH_MAGIC_LINK_MAX_PER_MIN: z.coerce.number().int().min(1).default(5),
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
  const strict = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
  if (strict && !env.AUTH_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['AUTH_SECRET'], message: 'AUTH_SECRET (>=32 chars) is required in staging/production' });
  }
  if (strict && env.EMAIL_TRANSPORT !== 'smtp') {
    ctx.addIssue({ code: 'custom', path: ['EMAIL_TRANSPORT'], message: 'EMAIL_TRANSPORT must be smtp in staging/production (file/disabled would break or fake sign-in)' });
  }
  if (strict && env.AUTH_MAGIC_LINK_MAX_PER_MIN > 5) {
    ctx.addIssue({ code: 'custom', path: ['AUTH_MAGIC_LINK_MAX_PER_MIN'], message: 'AUTH_MAGIC_LINK_MAX_PER_MIN above 5 is only allowed outside staging/production' });
  }
  if (env.EMAIL_TRANSPORT === 'smtp' && (!env.SMTP_URL || env.EMAIL_FROM.endsWith('@localhost>'))) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'SMTP_URL and a real EMAIL_FROM are required for the smtp transport' });
  }
  if (env.EMAIL_TRANSPORT === 'file' && !env.EMAIL_OUTBOX_DIR) {
    ctx.addIssue({ code: 'custom', path: ['EMAIL_OUTBOX_DIR'], message: 'EMAIL_OUTBOX_DIR is required for the file transport' });
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

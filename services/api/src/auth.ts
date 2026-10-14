import { createHash, randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import type { Env } from '@alfred/core';
import { schema, type Db } from '@alfred/db';
import { createEmailSender, magicLinkMail, type EmailSender } from './email';

export const MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

/** Per-recipient send throttle (anti mail-bombing from many IPs). In-memory: V0 runs a single API instance. */
export class RecipientThrottle {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 3, private readonly windowMs = 10 * 60_000) {}
  allow(email: string, now = Date.now()): boolean {
    const key = createHash('sha256').update(email.toLowerCase()).digest('hex');
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

export interface AuthDeps {
  env: Env;
  db: Db;
  mailer?: EmailSender;
  throttle?: RecipientThrottle;
}

export function createAuth({ env, db, mailer = createEmailSender(env), throttle = new RecipientThrottle() }: AuthDeps) {
  // Dev/test without AUTH_SECRET: ephemeral secret (sessions die with the process). Staging/production require it (env schema).
  const secret = env.AUTH_SECRET ?? randomBytes(32).toString('hex');
  const secure = env.PUBLIC_WEB_ORIGIN.startsWith('https://');
  return betterAuth({
    appName: 'AI Course Assistant',
    baseURL: env.PUBLIC_WEB_ORIGIN,
    basePath: '/api/auth',
    secret,
    trustedOrigins: [env.PUBLIC_WEB_ORIGIN],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: schema.users, session: schema.authSessions, account: schema.authAccounts, verification: schema.authVerifications },
    }),
    emailAndPassword: { enabled: false },
    session: { expiresIn: SESSION_TTL_SECONDS, updateAge: 24 * 3600 },
    advanced: {
      cookiePrefix: 'alfred',
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure, path: '/' },
      database: { generateId: 'uuid' },
      ipAddress: { ipAddressHeaders: ['x-client-ip'] },
      // Explicit: the library silently disables both checks when NODE_ENV=test; tests must exercise production behaviour.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    rateLimit: { enabled: true, window: 60, max: 100, storage: 'memory' },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: 'hashed',
        rateLimit: { window: 60, max: env.AUTH_MAGIC_LINK_MAX_PER_MIN },
        async sendMagicLink({ email, url }) {
          // Same observable result whether or not we send: no account enumeration, no mail-bombing of one address.
          if (!throttle.allow(email)) return;
          await mailer.send(magicLinkMail(email, url, MAGIC_LINK_TTL_SECONDS / 60));
        },
      }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;

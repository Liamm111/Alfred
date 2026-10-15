import { parseEnv } from '@alfred/core';
import { freshTestDb } from '@alfred/db/testing';
import { buildApp } from '../src/app';
import { MemoryEmailSender } from '../src/email';

export const ORIGIN = 'http://localhost:3000';

export async function makeTestApp(extraEnv: Record<string, string> = {}) {
  const h = await freshTestDb();
  const mailer = new MemoryEmailSender();
  const env = parseEnv({ APP_ENV: 'test', LOG_LEVEL: 'silent', PUBLIC_WEB_ORIGIN: ORIGIN, AUTH_MAGIC_LINK_MAX_PER_MIN: '100', ...extraEnv });
  const app = await buildApp({ env, db: h.db, mailer });
  const jsonHeaders = (cookie?: string) => ({ 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) });
  /** Headers of a browser fetch() without a body (no content-type): GET/DELETE. */
  const bodylessHeaders = (cookie?: string) => ({ origin: ORIGIN, ...(cookie ? { cookie } : {}) });

  /** Full magic-link sign-in; returns a Cookie header value for the new session. */
  async function signIn(email: string): Promise<string> {
    const before = mailer.sent.length;
    const r = await app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: jsonHeaders(), payload: { email, callbackURL: '/onboarding', errorCallbackURL: '/login' } });
    if (r.statusCode !== 200) throw new Error(`sign-in request failed: ${r.statusCode}`);
    if (mailer.sent.length !== before + 1) throw new Error('no mail captured');
    const link = /https?:\/\/\S+/.exec(mailer.sent[mailer.sent.length - 1]!.text)![0];
    const u = new URL(link);
    const v = await app.inject({ method: 'GET', url: u.pathname + u.search });
    if (v.statusCode !== 302) throw new Error(`verify failed: ${v.statusCode}`);
    return v.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  return { ...h, app, mailer, env, signIn, jsonHeaders, bodylessHeaders };
}

export const validPrefs = {
  firstName: 'Liam',
  aliases: ['Liam', 'Monsieur Pioline'],
  locale: 'fr',
  summaryLanguage: 'fr',
  timezone: 'Europe/Paris',
  alertPreferences: { mode: 'in_app_only', notificationPrivacy: 'discreet', acceptInAppOnly: true },
  retentionVerbatimDays: 30,
  retentionSummaryDays: 90,
  completeOnboarding: true,
};

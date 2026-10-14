import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorResponseSchema } from '@alfred/core';
import { schema } from '@alfred/db';
import { makeTestApp, ORIGIN, validPrefs } from './helpers';

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => { t = await makeTestApp(); });
afterAll(async () => { await t.app.close(); await t.close(); });

const rows = async <T>(q: ReturnType<typeof sql>) => ((await t.db.execute(q)) as unknown as { rows: T[] }).rows;

describe('401 without a valid session (fail closed)', () => {
  it('every private /api route rejects anonymous callers with the standard error', async () => {
    const priv = t.app.routeLog.filter((r) => r.url.startsWith('/api/') && !r.url.startsWith('/api/auth/') && r.method !== 'HEAD');
    expect(priv.length).toBeGreaterThanOrEqual(4); // me, preferences GET/PUT, sessions, session delete
    for (const r of priv) {
      const url = r.url.replace(':id', '3f1b6c1e-8f4e-4c52-9d3c-2a5f6b7c8d9e');
      const res = await t.app.inject({ method: r.method as 'GET', url, headers: r.method === 'PUT' ? t.jsonHeaders() : t.bodylessHeaders(), ...(r.method === 'PUT' ? { payload: validPrefs } : {}) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(errorResponseSchema.parse(res.json()).code).toBe('unauthorized');
    }
  });
  it('identity headers, garbage cookies and forged tokens do not authenticate (no mock auth)', async () => {
    for (const headers of [{ 'x-user-id': 'anyone' }, { authorization: 'Bearer admin' }, { cookie: 'alfred.session_token=forged.value' }, { cookie: '__Secure-alfred.session_token=x' }]) {
      expect((await t.app.inject({ url: '/api/me', headers })).statusCode).toBe(401);
    }
  });
});

describe('magic link sign-in', () => {
  it('sends one mail, creates the user on first verify, sets a hardened session cookie', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: t.jsonHeaders(), payload: { email: 'Alice@Example.test', callbackURL: '/onboarding', errorCallbackURL: '/login' } });
    expect(r.statusCode).toBe(200);
    const mail = t.mailer.sent.at(-1)!;
    expect(mail.to.toLowerCase()).toBe('alice@example.test');
    const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    expect(link.origin).toBe(ORIGIN);
    // token is stored hashed, never raw
    const token = link.searchParams.get('token')!;
    const ver = await rows<{ identifier: string }>(sql`select identifier from auth_verifications`);
    expect(ver.length).toBeGreaterThan(0);
    expect(ver.some((v) => v.identifier.includes(token))).toBe(false);
    const v = await t.app.inject({ url: link.pathname + link.search });
    expect(v.statusCode).toBe(302);
    expect(v.headers.location).toBe(`${ORIGIN}/onboarding`);
    const raw = String(v.headers['set-cookie']);
    expect(raw).toMatch(/alfred\.session_token=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: v.cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'alice@example.test', onboardingCompleted: false });
    // single use
    const again = await t.app.inject({ url: link.pathname + link.search });
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toMatch(/\/login\?error=INVALID_TOKEN/);
  });

  it('expired link is refused and redirects to the error page', async () => {
    await t.app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: t.jsonHeaders(), payload: { email: 'exp@example.test', callbackURL: '/onboarding', errorCallbackURL: '/login' } });
    const link = new URL(/https?:\/\/\S+/.exec(t.mailer.sent.at(-1)!.text)![0]);
    await t.db.execute(sql`update auth_verifications set expires_at = now() - interval '1 minute'`);
    const v = await t.app.inject({ url: link.pathname + link.search });
    expect(v.statusCode).toBe(302);
    expect(v.headers.location).toMatch(/\/login\?error=INVALID_TOKEN/);
    expect(v.headers['set-cookie']).toBeUndefined();
  });

  it('callback URL to a foreign origin is refused up front: 403, no mail, no redirect (open redirect)', async () => {
    const before = t.mailer.sent.length;
    for (const key of ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL']) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: t.jsonHeaders(), payload: { email: 'redir@example.test', [key]: 'https://evil.example/steal' } });
      expect(r.statusCode, key).toBe(403);
    }
    expect(t.mailer.sent.length).toBe(before);
  });

  it('sign-in request from a foreign Origin is rejected', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, payload: { email: 'csrf@example.test' } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('per-recipient throttle: same observable answer, but at most 3 mails / 10 min (no mail bombing)', async () => {
    const before = t.mailer.sent.length;
    for (let i = 0; i < 6; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: t.jsonHeaders(), payload: { email: 'victim@example.test' } });
      expect(r.statusCode).toBe(200);
    }
    expect(t.mailer.sent.length - before).toBe(3);
  });
});

describe('preferences', () => {
  it('defaults first (flagged), then save → reload keeps aliases (normalized), timezone, retention, onboarding', async () => {
    const cookie = await t.signIn('prefs@example.test');
    const d = await t.app.inject({ url: '/api/me/preferences', headers: { cookie } });
    expect(d.json()).toMatchObject({ isDefault: true, locale: 'fr', timezone: 'Europe/Paris', onboardingCompleted: false, version: 0 });
    const put = await t.app.inject({ method: 'PUT', url: '/api/me/preferences', headers: t.jsonHeaders(cookie), payload: { ...validPrefs, aliases: ['Éloïse', 'Monsieur Pioline'], timezone: 'America/Toronto' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ version: 1, onboardingCompleted: true, isDefault: false });
    expect(put.json().aliases).toEqual([{ raw: 'Éloïse', normalized: 'eloise' }, { raw: 'Monsieur Pioline', normalized: 'monsieur pioline' }]);
    // "reconnection": brand-new session for the same email sees the same data
    const cookie2 = await t.signIn('prefs@example.test');
    expect(cookie2).not.toBe(cookie);
    const again = await t.app.inject({ url: '/api/me/preferences', headers: { cookie: cookie2 } });
    expect(again.json()).toMatchObject({ firstName: 'Liam', timezone: 'America/Toronto', retentionVerbatimDays: 30, retentionSummaryDays: 90, onboardingCompleted: true, version: 1 });
    expect(again.json().aliases).toHaveLength(2);
  });

  it('validation: bad tz, duplicate alias, unknown key (userId smuggling), push-without-subscription onboarding', async () => {
    const cookie = await t.signIn('val@example.test');
    const put = (payload: unknown) => t.app.inject({ method: 'PUT', url: '/api/me/preferences', headers: t.jsonHeaders(cookie), payload: payload as object });
    expect((await put({ ...validPrefs, timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    const dup = await put({ ...validPrefs, aliases: ['Liam', 'LIAM'] });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().message).toMatch(/double/);
    expect((await put({ ...validPrefs, userId: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(400);
    const push = await put({ ...validPrefs, alertPreferences: { mode: 'push_and_in_app', notificationPrivacy: 'discreet', acceptInAppOnly: false } });
    expect(push.statusCode).toBe(400);
    expect(push.json().message).toMatch(/Push/);
    const notAccepted = await put({ ...validPrefs, alertPreferences: { mode: 'in_app_only', notificationPrivacy: 'discreet', acceptInAppOnly: false } });
    expect(notAccepted.statusCode).toBe(400);
    // saving without completing onboarding is allowed with push mode (draft), and stays "not onboarded"
    const draft = await put({ ...validPrefs, alertPreferences: { mode: 'push_and_in_app', notificationPrivacy: 'discreet', acceptInAppOnly: false }, completeOnboarding: false });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().onboardingCompleted).toBe(false);
  });

  it('optimistic concurrency: stale version => 409', async () => {
    const cookie = await t.signIn('conc@example.test');
    const send = (version?: number) => t.app.inject({ method: 'PUT', url: '/api/me/preferences', headers: t.jsonHeaders(cookie), payload: { ...validPrefs, ...(version ? { version } : {}) } });
    expect((await send()).statusCode).toBe(200);
    expect((await send(1)).statusCode).toBe(200);
    expect((await send(1)).statusCode).toBe(409);
  });
});

describe('cross-user isolation (IDOR)', () => {
  it("A never sees B's data; B cannot revoke A's session (404, session survives)", async () => {
    const a = await t.signIn('idor-a@example.test');
    const b = await t.signIn('idor-b@example.test');
    await t.app.inject({ method: 'PUT', url: '/api/me/preferences', headers: t.jsonHeaders(a), payload: { ...validPrefs, firstName: 'Alice', aliases: ['Alice'] } });
    await t.app.inject({ method: 'PUT', url: '/api/me/preferences', headers: t.jsonHeaders(b), payload: { ...validPrefs, firstName: 'Bob', aliases: ['Bob'] } });
    expect((await t.app.inject({ url: '/api/me/preferences', headers: { cookie: a } })).json().firstName).toBe('Alice');
    expect((await t.app.inject({ url: '/api/me/preferences', headers: { cookie: b } })).json().firstName).toBe('Bob');

    const aSessions = (await t.app.inject({ url: '/api/me/sessions', headers: { cookie: a } })).json() as { id: string; current: boolean }[];
    const bSessions = (await t.app.inject({ url: '/api/me/sessions', headers: { cookie: b } })).json() as { id: string }[];
    expect(aSessions).toHaveLength(1);
    expect(aSessions[0]!.current).toBe(true);
    expect(aSessions.some((s) => bSessions.some((x) => x.id === s.id))).toBe(false);

    const attack = await t.app.inject({ method: 'DELETE', url: `/api/me/sessions/${aSessions[0]!.id}`, headers: t.bodylessHeaders(b) });
    expect(attack.statusCode).toBe(404);
    const unknown = await t.app.inject({ method: 'DELETE', url: '/api/me/sessions/3f1b6c1e-8f4e-4c52-9d3c-2a5f6b7c8d9e', headers: t.bodylessHeaders(b) });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().message).toBe(attack.json().message); // no existence oracle
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: a } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/me/sessions/not-a-uuid', headers: t.jsonHeaders(b) })).statusCode).toBe(400);
  });
});

describe('session lifecycle', () => {
  it('revoking another own session takes effect immediately', async () => {
    const c1 = await t.signIn('life@example.test');
    const c2 = await t.signIn('life@example.test');
    const list = (await t.app.inject({ url: '/api/me/sessions', headers: { cookie: c1 } })).json() as { id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    const other = list.find((s) => !s.current)!;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/me/sessions/${other.id}`, headers: t.bodylessHeaders(c1) })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: c2 } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: c1 } })).statusCode).toBe(200);
  });

  it('logout invalidates the session server-side and clears the cookie', async () => {
    const c = await t.signIn('logout@example.test');
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: t.jsonHeaders(c), payload: {} });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/i);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: c } })).statusCode).toBe(401); // old cookie replayed
  });

  it('expired session => 401', async () => {
    const c = await t.signIn('expired@example.test');
    await t.db.execute(sql`update auth_sessions set expires_at = now() - interval '1 second' where user_id = (select id from users where email='expired@example.test')`);
    const r = await t.app.inject({ url: '/api/me', headers: { cookie: c } });
    expect(r.statusCode).toBe(401);
    expect(errorResponseSchema.parse(r.json()).code).toBe('unauthorized');
  });

  it('soft-deleted user => 401 even with a live session', async () => {
    const c = await t.signIn('gone@example.test');
    await t.db.execute(sql`update users set deleted_at = now() where email='gone@example.test'`);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: c } })).statusCode).toBe(401);
  });
});

describe('CSRF / origin', () => {
  it('state-changing /api calls without or with a foreign Origin are 403 even with a valid cookie', async () => {
    const c = await t.signIn('csrf@example.test');
    const base = { method: 'PUT' as const, url: '/api/me/preferences', payload: validPrefs };
    expect((await t.app.inject({ ...base, headers: { 'content-type': 'application/json', cookie: c } })).statusCode).toBe(403);
    expect((await t.app.inject({ ...base, headers: { 'content-type': 'application/json', cookie: c, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await t.app.inject({ ...base, headers: t.jsonHeaders(c) })).statusCode).toBe(200);
  });
});

describe('audit & privacy', () => {
  it('audit rows carry no aliases or names', async () => {
    const all = JSON.stringify(await t.db.select().from(schema.auditEvents));
    expect(all).toContain('preferences.update');
    expect(all).not.toMatch(/Pioline|Éloïse|Alice|Bob/);
  });
});

import { cookies } from 'next/headers';
import { meSchema, preferencesSchema, sessionInfoSchema, type Me, type Preferences, type SessionInfo } from '@alfred/core/shared';
import { z } from 'zod';

// Server-side only (runtime env, never bundled for the browser).
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

export type ApiResult<T> = { status: 'ok'; data: T } | { status: 'anon' } | { status: 'down' };

async function apiGet<T>(path: string, parse: (v: unknown) => T): Promise<ApiResult<T>> {
  try {
    const cookie = (await cookies()).toString();
    const res = await fetch(`${API_ORIGIN}${path}`, { headers: cookie ? { cookie } : {}, cache: 'no-store' });
    if (res.status === 401) return { status: 'anon' };
    if (!res.ok) return { status: 'down' };
    return { status: 'ok', data: parse(await res.json()) };
  } catch {
    return { status: 'down' };
  }
}

export const getMe = (): Promise<ApiResult<Me>> => apiGet('/api/me', (v) => meSchema.parse(v));
export const getPreferences = (): Promise<ApiResult<Preferences>> => apiGet('/api/me/preferences', (v) => preferencesSchema.parse(v));
export const getSessions = (): Promise<ApiResult<SessionInfo[]>> => apiGet('/api/me/sessions', (v) => z.array(sessionInfoSchema).parse(v));

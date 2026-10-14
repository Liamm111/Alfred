import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@alfred/core';
import { schema } from '@alfred/db';
import type { AppDeps } from './app';
import type { Auth } from './auth';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function toHeaders(h: FastifyRequest['headers']): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
    else if (typeof v === 'string') out.set(k, v);
  }
  return out;
}

/**
 * The ONLY way a request becomes authenticated: a valid server-side session cookie. Fails closed (401) on a missing/expired/
 * revoked session, a soft-deleted user, or ANY error while resolving. Client-supplied identity headers are never read.
 */
export function makeRequireUser(app: { deps: AppDeps; auth: Auth }) {
  return async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    try {
      const session = await app.auth.api.getSession({ headers: toHeaders(req.headers) });
      if (!session) throw new AppError('unauthorized', 'Connexion requise');
      const db = app.deps.db;
      if (!db) throw new AppError('unauthorized', 'Connexion requise');
      const [u] = await db.select({ id: schema.users.id, email: schema.users.email, deletedAt: schema.users.deletedAt }).from(schema.users).where(eq(schema.users.id, session.user.id)).limit(1);
      if (!u || u.deletedAt) throw new AppError('unauthorized', 'Connexion requise');
      req.auth = { userId: u.id, sessionId: session.session.id, email: u.email };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('unauthorized', 'Connexion requise');
    }
  };
}

export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new AppError('unauthorized', 'Connexion requise'); // guard missing => fail closed
  return req.auth;
}

import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { AppError, HTTP_STATUS, resolveRequestId, createLogger, type Env, type ErrorResponse } from '@alfred/core';
import type { Db } from '@alfred/db';
import { healthRoutes } from './routes/health';
import { demoRoutes } from './routes/demo';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { createAuth, type Auth } from './auth';
import type { EmailSender } from './email';
import { makeRequireUser } from './guard';

export interface AppDeps {
  env: Env;
  db: Db | null;
  logger?: ReturnType<typeof createLogger>;
  /** Override the mail transport (tests). Defaults to the one selected by EMAIL_TRANSPORT. */
  mailer?: EmailSender;
  version?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    auth: Auth;
    routeLog: { method: string; url: string }[];
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? createLogger({ level: deps.env.LOG_LEVEL });
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    genReqId: (req) => resolveRequestId(req.headers['x-request-id']),
    logController: new LogController({ requestIdLogLabel: 'requestId', disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: deps.env.APP_ENV === 'production',
  });
  app.decorate('deps', deps);
  // Route inventory (used by tests to prove every private /api route is guarded).
  const routeLog: { method: string; url: string }[] = [];
  app.decorate('routeLog', routeLog);
  app.addHook('onRoute', (r) => { for (const m of [r.method].flat()) routeLog.push({ method: m, url: r.url }); });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    return undefined;
  });

  const body = (req: { id: string }, code: ErrorResponse['code'], message: string): ErrorResponse => ({ code, message, requestId: req.id });

  app.setNotFoundHandler((req, reply) => reply.code(404).send(body(req, 'not_found', 'Ressource introuvable')));
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send(body(req, err.code, err.message));
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send(body(req, 'payload_too_large', 'Corps de requête trop volumineux'));
    const sc = err.statusCode;
    if (sc && sc >= 400 && sc < 500) {
      const code = sc === 404 ? 'not_found' : sc === 401 ? 'unauthorized' : sc === 403 ? 'forbidden' : sc === 429 ? 'rate_limited' : 'validation_error';
      return reply.code(HTTP_STATUS[code]).send(body(req, code, 'Requête invalide'));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(body(req, 'internal_error', 'Erreur interne'));
  });

  await app.register(healthRoutes);

  if (deps.db) {
    const auth = createAuth({ env: deps.env, db: deps.db, ...(deps.mailer ? { mailer: deps.mailer } : {}) });
    app.decorate('auth', auth);

    // CSRF defence in depth (cookies are SameSite=Lax): every state-changing /api request must come from our web origin.
    app.addHook('onRequest', async (req) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.url.startsWith('/api/')) return;
      if (req.headers.origin !== deps.env.PUBLIC_WEB_ORIGIN) throw new AppError('forbidden', 'Origine non autorisée');
    });

    await app.register(authRoutes);
    await app.register(async (priv) => {
      priv.addHook('preHandler', makeRequireUser(app));
      await priv.register(meRoutes);
    });
  }
  // Demo routes exist ONLY in simulation mode, and never in production (env validation already forbids that combination).
  if (deps.env.MOCK_MODE && deps.env.APP_ENV !== 'production') await app.register(demoRoutes, { prefix: '/dev/demo' });

  return app;
}

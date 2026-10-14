import type { FastifyPluginAsync } from 'fastify';
import { healthReadySchema, type HealthReady } from '@alfred/core';
import { sql } from 'drizzle-orm';
import { schemaStatus } from '@alfred/db';
import { safeEqual } from '../app';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health/live', async () => ({ status: 'ok' as const }));

  // Internal/protected (PRD §14): bearer HEALTH_TOKEN when configured (mandatory in staging/production by env validation).
  app.get('/health/ready', async (req, reply) => {
    const { env, db, version } = app.deps;
    if (env.HEALTH_TOKEN) {
      const h = req.headers.authorization ?? '';
      const ok = h.startsWith('Bearer ') && safeEqual(h.slice(7), env.HEALTH_TOKEN);
      if (!ok) return reply.code(401).send({ code: 'unauthorized', message: 'Authentification requise', requestId: req.id });
    }
    const out: HealthReady = {
      status: 'ok',
      version: version ?? '0.0.0',
      checks: { database: 'fail', schema: 'unknown' },
      schemaVersion: null,
      mockMode: env.MOCK_MODE,
    };
    if (db) {
      try {
        await db.execute(sql`select 1`);
        out.checks.database = 'ok';
        const s = await schemaStatus(db, env.MIGRATIONS_DIR);
        out.checks.schema = s.state === 'ok' ? 'ok' : 'behind';
        out.schemaVersion = s.latestTag;
      } catch {
        // details intentionally not exposed
      }
    }
    if (out.checks.database !== 'ok' || out.checks.schema !== 'ok') out.status = 'degraded';
    return reply.code(out.status === 'ok' ? 200 : 503).send(healthReadySchema.parse(out));
  });
};

import type { FastifyPluginAsync } from 'fastify';
import { DEMO_TRANSCRIPT } from '@alfred/providers';

/** Deterministic dev demo (simulation only). Registered iff MOCK_MODE=true && APP_ENV != production. */
export const demoRoutes: FastifyPluginAsync = async (app) => {
  app.get('/transcript', async (_req, reply) => {
    reply.header('x-simulation', 'true');
    return { simulated: true, banner: 'SIMULATION — aucun cours réel, aucune donnée fournisseur', items: DEMO_TRANSCRIPT };
  });
};

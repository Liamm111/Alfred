import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '@alfred/core';
import { toHeaders } from '../guard';

/** Bridges Fastify <-> Better Auth's Web-standard handler. All sign-in/out endpoints live under /api/auth/*. */
export const authRoutes: FastifyPluginAsync = async (app) => {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const url = new URL(req.url, app.deps.env.PUBLIC_WEB_ORIGIN);
      const hasBody = req.method !== 'GET' && req.body !== undefined && req.body !== null;
      // Client IP for the auth library's rate limiter: always OUR resolved value (Fastify trustProxy), never a client-sent header.
      const headers = toHeaders(req.headers);
      headers.set('x-client-ip', req.ip);
      const request = new Request(url, {
        method: req.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
      });
      let res: Response;
      try {
        res = await app.auth.handler(request);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError('internal_error', 'Erreur interne');
      }
      reply.status(res.status);
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      const buf = Buffer.from(await res.arrayBuffer());
      return reply.send(buf.length > 0 ? buf : null);
    },
  });
};

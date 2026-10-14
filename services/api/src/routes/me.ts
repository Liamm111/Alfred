import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  DEFAULT_PREFERENCES,
  meSchema,
  preferencesInputSchema,
  preferencesSchema,
  sessionInfoSchema,
  type Preferences,
} from '@alfred/core';
import { schema } from '@alfred/db';
import { authOf } from '../guard';

const uuidParam = z.object({ id: z.uuid() });

function parse<S extends z.ZodType>(s: S, data: unknown): z.output<S> {
  const r = s.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new AppError('validation_error', `${i?.path.join('.') || 'requête'}: ${i?.message ?? 'invalide'}`);
  }
  return r.data;
}

/** Placeholder until the Push block: no subscription can be verified yet, so "immediate alerts" can never be promised (PRD N01). */
export async function hasVerifiedPushSubscription(_userId: string): Promise<boolean> {
  return false;
}

type PrefRow = typeof schema.userPreferences.$inferSelect;
const toDto = (r: PrefRow): Preferences => ({
  firstName: r.firstName,
  aliases: r.aliases,
  locale: r.locale as 'fr' | 'en',
  summaryLanguage: r.summaryLanguage as 'fr' | 'en',
  timezone: r.timezone,
  alertPreferences: r.alertPreferences,
  retentionVerbatimDays: r.retentionVerbatimDays,
  retentionSummaryDays: r.retentionSummaryDays,
  onboardingCompleted: r.onboardingCompletedAt !== null,
  version: r.version,
  isDefault: false,
});

/** Every route in this plugin is behind requireUser (registered by buildApp) and scoped by the session's userId — never by a client id. */
export const meRoutes: FastifyPluginAsync = async (app) => {
  const db = () => {
    if (!app.deps.db) throw new AppError('not_ready', 'Service indisponible');
    return app.deps.db;
  };

  app.get('/api/me', async (req) => {
    const { userId, email } = authOf(req);
    const [p] = await db().select({ at: schema.userPreferences.onboardingCompletedAt }).from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).limit(1);
    return meSchema.parse({ id: userId, email, onboardingCompleted: !!p?.at });
  });

  app.get('/api/me/preferences', async (req) => {
    const { userId } = authOf(req);
    const [row] = await db().select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).limit(1);
    return preferencesSchema.parse(row ? toDto(row) : DEFAULT_PREFERENCES);
  });

  app.put('/api/me/preferences', async (req) => {
    const { userId } = authOf(req);
    const input = parse(preferencesInputSchema, req.body);

    if (input.completeOnboarding) {
      const a = input.alertPreferences;
      const pushOk = a.mode === 'push_and_in_app' && (await hasVerifiedPushSubscription(userId));
      const inAppOk = a.mode === 'in_app_only' && a.acceptInAppOnly;
      if (!pushOk && !inAppOk) {
        throw new AppError(
          'validation_error',
          "alertPreferences: les notifications Push ne sont pas encore vérifiées ; accepte explicitement « application ouverte seulement » pour continuer",
        );
      }
    }

    const saved = await db().transaction(async (tx) => {
      const [cur] = await tx.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).for('update').limit(1);
      const values = {
        firstName: input.firstName,
        aliases: input.aliases,
        locale: input.locale,
        summaryLanguage: input.summaryLanguage,
        timezone: input.timezone,
        alertPreferences: input.alertPreferences,
        retentionVerbatimDays: input.retentionVerbatimDays,
        retentionSummaryDays: input.retentionSummaryDays,
        updatedAt: new Date(),
      };
      let row: PrefRow | undefined;
      if (!cur) {
        if (input.version !== undefined) throw new AppError('conflict', 'Préférences modifiées ailleurs : recharge la page');
        [row] = await tx.insert(schema.userPreferences).values({ userId, ...values, onboardingCompletedAt: input.completeOnboarding ? new Date() : null }).returning();
      } else {
        if (input.version !== undefined && input.version !== cur.version) throw new AppError('conflict', 'Préférences modifiées ailleurs : recharge la page');
        [row] = await tx
          .update(schema.userPreferences)
          .set({ ...values, version: cur.version + 1, onboardingCompletedAt: cur.onboardingCompletedAt ?? (input.completeOnboarding ? new Date() : null) })
          .where(eq(schema.userPreferences.userId, userId))
          .returning();
      }
      if (!row) throw new AppError('internal_error', 'Erreur interne');
      // Audit without content: no aliases, no names.
      await tx.insert(schema.auditEvents).values({ userId, targetId: userId, action: 'preferences.update', outcome: 'ok', minimalMetadata: { version: row.version, aliasCount: input.aliases.length } });
      return row;
    });
    return preferencesSchema.parse(toDto(saved));
  });

  app.get('/api/me/sessions', async (req) => {
    const { userId, sessionId } = authOf(req);
    const rows = await db()
      .select({ id: schema.authSessions.id, createdAt: schema.authSessions.createdAt, expiresAt: schema.authSessions.expiresAt, userAgent: schema.authSessions.userAgent })
      .from(schema.authSessions)
      .where(and(eq(schema.authSessions.userId, userId), gt(schema.authSessions.expiresAt, sql`now()`)))
      .orderBy(schema.authSessions.createdAt);
    return rows.map((r) => sessionInfoSchema.parse({ id: r.id, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(), userAgent: r.userAgent?.slice(0, 200) ?? null, current: r.id === sessionId }));
  });

  // IDOR-safe: the owner is part of the WHERE clause. Someone else's / unknown session id => the same 404.
  app.delete('/api/me/sessions/:id', async (req, reply) => {
    const { userId } = authOf(req);
    const { id } = parse(uuidParam, req.params);
    const deleted = await db().delete(schema.authSessions).where(and(eq(schema.authSessions.id, id), eq(schema.authSessions.userId, userId))).returning({ id: schema.authSessions.id });
    if (deleted.length === 0) throw new AppError('not_found', 'Session introuvable');
    await db().insert(schema.auditEvents).values({ userId, targetId: id, action: 'session.revoke', outcome: 'ok' });
    return reply.code(204).send();
  });
};

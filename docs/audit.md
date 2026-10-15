# Audit — BLOC 00 (réajustement PRD V0.2)

Date : 14 octobre 2026. Périmètre : tout le dépôt (`git ls-files`, 118 fichiers avant réajustement). Aucun prototype antérieur n'existait ; le code audité est celui écrit lors des blocs v0.0 (architecture « bot Recall.ai », désormais **interdite**).

## 1. Arbre des dépendances (après réajustement)

```
apps/web ──► @alfred/core (shared: alias, préférences, erreurs — sans node:*)
services/api ──► @alfred/core, @alfred/db, better-auth, fastify, nodemailer, zod, pino
services/workers ──► @alfred/core, @alfred/db
db (@alfred/db) ──► @alfred/core, drizzle-orm, pg        (migrations up/down, jobs/outbox)
packages/core ──► zod, pino                               (env, features, erreurs, logger, alias, contrats préférences)
packages/ai ──► zod                                       (format de corpus d'évaluation ; futur : classifieurs, STT adapters)
packages/contracts, apps/mac, apps/zoom-surface, services/rtms-gateway : vides (README seulement)
archive/bot-era/providers : archivé, hors workspace
```

## 2. Classification de tout usage « bot / Recall / join / Meeting SDK / démarrage auto »

Méthode : `git grep -i -E "recall|bot|joinMeeting|createBot|joinAt|join_at|meeting[- ]?sdk|ZoomMtg|MeetingProvider|auto.?start|startBot"` + revue manuelle des 118 fichiers.

| Occurrence | Fichiers | Classe | Décision |
|---|---|---|---|
| Port `MeetingProvider` (`createBot`, `findBotByIdempotencyKey`, `cancelBot`, types `CreateBotInput/BotRef/BotLifecycleCode`) | `packages/providers/src/meeting-provider.ts` | **INTERDIT** (crée un participant) | **archivé** → `archive/bot-era/providers/` (hors workspace, lint, build, tests) |
| `MockMeetingProvider` + `createMeetingProvider`/`ProviderNotConfiguredError` (désignait « recall ») + ses 4 tests | `packages/providers/src/{mock,index}.ts`, `test/provider.test.ts` | **INTERDIT** | archivé avec le reste du package |
| `DEMO_TRANSCRIPT` (texte synthétique) | `packages/providers/src/mock.ts` | **UTILE** (démo MOCK_MODE) | **conservé** : déplacé en `packages/core/src/demo-fixture.ts`, route `/dev/demo/transcript` inchangée |
| Libellé UI « Le bot s'appellera « Assistant IA de … » » | `apps/web/app/_components/PreferencesForm.tsx` | **INTERDIT** (promesse d'un participant) | **corrigé** : « L'assistant ne parle jamais à ta place » |
| Règle de scan `whsec_…` « recall/svix webhook secret » | `scripts/secrets-scan.mjs` + test | NEUTRE (motif de secret générique) | conservé ; les signatures Zoom RTMS seront traitées au bloc 06 |
| Matrice de risques Z01–Z10/E*/T*/A* v0.0, section Recall de `DEPENDENCIES.md`, `PRD_V0.0` | `docs/` | OBSOLÈTE | archivés dans `docs/archive/` (historique) ; Recall retiré des dépendances actives |
| Jobs/outbox/lease (`job_queue`, `enqueue/claim/complete/fail`) | `db/src/jobs.ts` | **RÉUTILISABLE** | conservé (outbox du PRD D1-9, bloc 12) |
| Démarrages automatiques | — | aucun | la boucle `startWorker` ne lance que des jobs enregistrés ; aucun handler métier ; aucun appel de jonction/capture n'existe |
| Meeting SDK / `ZoomMtg` / `@zoom/meetingsdk` | — | absent | interdit par le garde-fou `check:no-bot` |

Résultat : **aucun appel de jonction participant ne subsiste dans le code actif** (`pnpm check:no-bot`).

## 3. Composants réutilisables (à ne pas casser)

| Composant | Réutilisé par (blocs v0.2) |
|---|---|
| Env Zod strict + `MOCK_MODE` interdit en prod | tous |
| Logger expurgé, erreurs `{code,message,requestId}`, request-id | 02, 06, 13, 16 |
| `db/` migrations up/down + `assertSchemaUpToDate` + jobs/outbox (lease, fencing, backoff, dead) | 02, 06, 12, 17 |
| Auth produit Better Auth (lien magique, sessions HttpOnly, révocation, CSRF/Origin, rate-limit) + guard fail-closed + IDOR tests | 03 (côté web ; PKCE Mac à faire) |
| Préférences : alias normalisés, fuseau IANA, rétention, confidentialité des notifs | 03, 11, 12 |
| UI Next (login, onboarding, paramètres), e2e Playwright desktop+mobile, CI, scans | 13 |

## 4. Dérives de code vs PRD V0.2 (à traiter par les blocs concernés)

| Constat | Bloc |
|---|---|
| Onboarding/préférences ne couvrent pas : consentement par cours, patronyme/variantes séparés, sensibilité d'alerte, états de permissions Mac | 03, 04, 16 |
| `users`/`user_preferences` existent ; manquent `user_aliases` (table dédiée), `user_devices`, `zoom_accounts`, `sessions`, `capture_sources`, etc. (PRD D2) | 02 |
| Pas de RLS ; isolation uniquement applicative | 02 |
| Rétention par défaut 30/90 j ≠ PRD v0.2 (30 j textes, 7 j images optionnelles, 0 flux brut) | 02, 16 |
| Lien magique web ≠ « auth produit HTTPS+PKCE » exigée pour l'app Mac | 03 |

## 5. Risques identifiés par l'audit

1. Régression silencieuse vers une architecture « participant » : couverte par `check:no-bot` (CI) + flag `bot_join` non réactivable.
2. Dépendance à un compte Zoom **payant** (RTMS exige un abonnement Developer Pack, pas de plan Basic) : voir `DEPENDENCIES.md` — conditionne tous les gates `REAL-ZOOM-*`.
3. Aucune machine macOS ni iPhone dans l'environnement de développement actuel : blocs 04, 07, 08, 12 (partie réelle), 18 seront `BLOCKED` pour preuve réelle.
4. Capture locale = risque de contournement d'une interdiction hôte : à verrouiller au bloc 16 (consent gate) avant le bloc 07.

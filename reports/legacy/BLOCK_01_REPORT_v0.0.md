# Rapport BLOC 01 — fondation TypeScript strict, données durables, CI

Date : 14 octobre 2026. Commits : `feat: BLOC 01 foundation …` puis `fix: prod-bundle check …`.

## Verdict
**BLOC 01: PASS** (avec deux limites explicites ci-dessous : Docker Compose non exécuté ici ; « portage de la démo » sans objet).
Rappel : la V0 n'est pas livrée (`REAL-ZOOM`, `REAL-PUSH` : NOT VERIFIED).

## Réellement codé
- Monorepo pnpm : `apps/{web,api,worker}`, `packages/{core,db,providers,evals}` ; TS strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`…), ESLint 9 flat, Vitest 5 (projets `unit` / `integration`).
- `@alfred/core` : schéma d'environnement Zod (MOCK_MODE strict, interdit en production ; HEALTH_TOKEN/DATABASE_URL/https exigés en prod), erreurs standard `{code,message,requestId}`, request-id sûr (anti log-injection), logger pino **expurgé** (texte, emails, tokens, URLs, secrets), contrats `v1`.
- `@alfred/db` : Drizzle, migration `0000_foundation` (`job_queue`, `audit_events`), **rollback** écrit à la main (`drizzle/down/*.sql`), `migrateUp/Down`, `schemaStatus`/`assertSchemaUpToDate` (O01).
- File de jobs / outbox transactionnel : `enqueue` idempotent (`unique(type,unique_key)`, utilisable dans une transaction métier), `claim` (`FOR UPDATE SKIP LOCKED` + bail), `complete`/`fail` avec jeton de fencing, backoff exponentiel, `dead` après `max_attempts` (y compris crashs répétés), `heartbeat`.
- `apps/api` Fastify : `/health/live` (public), `/health/ready` (bearer `HEALTH_TOKEN`, DB + version de schéma), 404/413/400/500 normalisés, en-têtes de sécurité, démarrage refusé si schéma en retard.
- `apps/worker` : boucle `runOnce`/`startWorker` ; aucun handler métier (seulement `demo.noop` en MOCK_MODE). Seul un **code** d'erreur est persisté.
- `packages/providers` : port `MeetingProvider` **sans** canal de sortie audio/chat (A08), `MockMeetingProvider`, factory qui **échoue** (`ProviderNotConfiguredError`) si `MOCK_MODE=false` — pas de simulation silencieuse.
- `packages/evals` : schéma de corpus (origine `synthetic` obligatoire) + 3 exemples ; **pas** les 200/80/30 exemples du PRD §12.2 (non faits).
- `apps/web` Next 16 : page d'accueil honnête, en-têtes, rewrite `/api/*` → API (variable serveur, non `NEXT_PUBLIC_`).
- Démo déterministe : `/dev/demo/transcript` (+ en-tête `x-simulation`) **uniquement** si `MOCK_MODE=true`. Il n'existait aucun prototype à porter (BLOC 00).
- Outils : `scripts/pg-local.sh` (Postgres sans Docker), `scripts/secrets-scan.mjs`, `scripts/check-prod-bundle.mjs`, `scripts/crash-recovery.sh`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example` sans valeur réelle.

## Commandes exécutées et résultats
| Commande | Résultat |
|---|---|
| clone propre (`git clone`) + `pnpm install --frozen-lockfile` | PASS |
| `pnpm secrets:scan` / `lint` / `typecheck` / `test` | PASS (unit : 32 tests au moment du bloc) |
| `pnpm migrate:up` → `migrate:down` → `migrate:up` | PASS |
| `pnpm test:integration` (Postgres 16 réel) | PASS (17 tests : migrations up/down/up, jobs, 50 workers concurrents sans double claim, crash avant ack + fencing, backoff/dead, rollback d'outbox, readiness) |
| `pnpm build` | PASS (Next + tsup api/worker) |
| `pnpm test:e2e` (Playwright desktop + mobile) | PASS 2/2 |
| `pnpm check:prod-bundle` | PASS 8/8 : bundle web sans secret/route démo ; API de prod refuse `MOCK_MODE=true` ; `/dev/demo` = 404 ; `/health/ready` sans jeton = 401 ; pas de fuite de DSN/secret |
| `sh scripts/crash-recovery.sh` (**kill -9** de tous les processus Postgres) | PASS : 5 jobs commités conservés, écriture non commitée absente, `claim` fonctionne après redémarrage |
| **CI GitHub Actions** (run [38612806077](https://github.com/Liamm111/Alfred/actions/runs/38612806077)) | **success** sur `f4b49e3` (install gelé, scan, lint, typecheck, tests, migrations, intégration, build, e2e, bundle prod) |

## Sécurité
Secrets uniquement via l'environnement serveur ; `.env*` ignorés ; scan de secrets en CI ; logs expurgés (test) ; messages d'erreur d'environnement sans valeurs (test) ; `/health/ready` protégé ; MOCK_MODE impossible en production (unit + binaire de prod réellement lancé).

## Bugs P0/P1
- Corrigé : bundle API incluant `pino` en CJS → crash au démarrage (détecté par `check-prod-bundle`) ; dépendances tierces déclarées dans les apps.
- Corrigé : `check-prod-bundle` dépendait de l'état laissé par d'autres suites (migre désormais lui-même) et pouvait rester bloqué.
- Corrigé : `pg-local.sh` ne relançait pas Postgres après `kill -9` en sandbox sans init (verrous périmés/zombies).
- Ouverts (par conception, blocs ultérieurs) : lignes de `docs/RISK_MATRIX.md` non couvertes.

## Limites
- `docker compose up -d db` **non exécuté** : aucun démon Docker dans le bac à sable (le CI GitHub utilise un service Postgres 16). Le fichier est donc non vérifié localement.
- Le code de démo existe encore dans le bundle de l'API de prod ; il est inatteignable (route non enregistrée, vérifié par exécution) mais pas éliminé du binaire.
- Rollback de migration : écrit à la main, jamais généré ; chaque migration future doit fournir son `down` (sinon `migrateDown` échoue explicitement).
- Rate-limit mémoire (instance unique) — voir BLOC 02.
- Pas de métriques/Sentry (O04 partiel), pas de DLQ alertante (E07).

## Gates
`REAL-ZOOM`, `REAL-PUSH`, `REAL-RECALL/STT/LLM`, `REAL-EMAIL` : NOT VERIFIED.

## Prochaine étape recommandée
BLOC 02 (identité). Ne rien lancer d'autre automatiquement.

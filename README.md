# AI Course Assistant

Assistant personnel **transparent** pour suivre des cours Zoom autorisés — contrat : [`docs/PRD_V0_SOURCE_OF_TRUTH.md`](docs/PRD_V0_SOURCE_OF_TRUTH.md).

> **La V0 n'est pas livrée.** Gates `REAL-ZOOM` et `REAL-PUSH` : NOT VERIFIED ([`docs/RELEASE_GATES.md`](docs/RELEASE_GATES.md)).
> État réel : [`docs/STATUS_REALITY.md`](docs/STATUS_REALITY.md). Rapports : `docs/BLOCK_*_REPORT.md`.

## Structure (pnpm workspace)
| Chemin | Rôle |
|---|---|
| `apps/web` | Next.js (App Router) |
| `apps/api` | Fastify TS : santé, erreurs standard, (auth au BLOC 02) |
| `apps/worker` | worker de jobs durables (leases) |
| `packages/core` | env Zod (MOCK_MODE), erreurs, logger expurgé, contrats v1 |
| `packages/db` | Drizzle : schéma, migrations up/down, file de jobs / outbox |
| `packages/providers` | port `MeetingProvider` + fournisseur simulé (MOCK_MODE seulement) |
| `packages/evals` | format de corpus d'évaluation (synthétique uniquement) |

## Démarrer en local
```sh
cp .env.example .env            # aucune valeur réelle dedans
docker compose up -d db         # PostgreSQL 16   (sans Docker : scripts/pg-local.sh start)
pnpm install --frozen-lockfile
pnpm migrate:up
pnpm --filter @alfred/api dev   # :4000
pnpm --filter @alfred/web dev   # :3000
```

## Commandes de contrôle (gate PRD §12.3)
`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:integration` (Postgres `DATABASE_URL_TEST`, base `*_test` **détruite**) ·
`pnpm test:e2e` (Playwright desktop + mobile) · `pnpm build` · `pnpm secrets:scan` · `pnpm check:prod-bundle` ·
`pnpm migrate:up|down` · `sh scripts/crash-recovery.sh` (kill -9 Postgres).

## MOCK_MODE
`MOCK_MODE=true|false` (strict, défaut `false`). `true` est **refusé au démarrage** si `APP_ENV=production`
(`packages/core/src/env.ts`). Il active seulement `/dev/demo/*` et le fournisseur simulé. Sans lui, aucun fournisseur n'est
simulé silencieusement : la factory échoue (`ProviderNotConfiguredError`).

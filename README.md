# AI Course Assistant

Assistant personnel **transparent** pour suivre ton cours Zoom (PRD V0.2 hybride RTMS + macOS) : [`docs/PRD_V0_SOURCE_OF_TRUTH.md`](docs/PRD_V0_SOURCE_OF_TRUTH.md).
**Une seule présence Zoom : la tienne.** Aucun bot, aucun participant ajouté, aucune réponse à ta place (`pnpm check:no-bot`, flag `bot_join` non réactivable).

> **La V0 n'est pas livrée.** `REAL-ZOOM-RTMS`, `REAL-MAC-CAPTURE`, `REAL-IPHONE-PUSH` : NOT VERIFIED ([`docs/RELEASE_GATES.md`](docs/RELEASE_GATES.md)).
> État réel : [`docs/STATUS_REALITY.md`](docs/STATUS_REALITY.md) · audit : [`docs/audit.md`](docs/audit.md) · ADR : [`docs/ARCHITECTURE_ADR.md`](docs/ARCHITECTURE_ADR.md) · rapports : [`reports/`](reports/) · plan des blocs : [`docs/prompts/CODEX_PROMPTS_MASTER.md`](docs/prompts/CODEX_PROMPTS_MASTER.md).

## Structure (pnpm workspace)
| Chemin | Rôle | État |
|---|---|---|
| `apps/web` | Next.js : connexion, onboarding, paramètres (PWA/Live à venir) | partiel |
| `apps/mac` | compagnon SwiftUI (menu bar, ScreenCaptureKit, Vision) | non construit |
| `apps/zoom-surface` | Zoom App in-client (`startRTMS`) | non construit |
| `services/api` | Fastify : santé, auth produit, préférences | partiel |
| `services/rtms-gateway` | consommateur `@zoom/rtms` | non construit |
| `services/workers` | worker de jobs durables (lease) | squelette |
| `db` | Drizzle : migrations up/down, jobs/outbox | partiel |
| `packages/core` | env (MOCK_MODE, bot_join), logger expurgé, erreurs, alias, préférences | construit |
| `packages/contracts` | contrats + machine d'états | non construit |
| `packages/ai` | format de corpus d'évaluation ; futur : classifieurs, STT | squelette |
| `archive/bot-era` | ancien code « bot » (interdit, hors workspace) | archivé |

## Démarrer en local
```sh
cp .env.example .env            # aucune valeur réelle dedans
docker compose up -d db         # PostgreSQL 16   (sans Docker : scripts/pg-local.sh start)
pnpm install --frozen-lockfile
pnpm migrate:up
pnpm --filter @alfred/api dev   # :4000
pnpm --filter @alfred/web dev   # :3000
```

## Commandes de contrôle
`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:integration` (Postgres `DATABASE_URL_TEST`, base `*_test` **détruite**) · `pnpm test:e2e` (Playwright desktop + mobile) · `pnpm build` · `pnpm secrets:scan` · `pnpm check:no-bot` · `pnpm check:prod-bundle` · `pnpm migrate:up|down` · `sh scripts/crash-recovery.sh` (kill -9 Postgres).

## Modes
`MOCK_MODE=true|false` (strict, défaut `false`) : interdit si `APP_ENV=production` ; n'active que `/dev/demo/*` (texte synthétique étiqueté simulation). `BOT_JOIN` : seule valeur légale = absent ou `false`.

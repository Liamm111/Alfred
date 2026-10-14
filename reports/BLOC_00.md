# BLOC 00 — Audit initial et gel des invariants (réajustement PRD V0.2)

Date : 14 octobre 2026. Contrat : `docs/PRD_V0_SOURCE_OF_TRUTH.md` (v0.2 hybride RTMS + Mac) ; prompts : `docs/prompts/CODEX_PROMPTS_MASTER.md`.

## Objectif
Réajuster le dépôt (construit sous l'ancien PRD « bot Recall.ai ») au PRD V0.2 : classer et archiver le code interdit, geler les invariants, poser le monorepo cible, installer des garde-fous empêchant tout retour d'un participant/bot — sans casser les tests utiles.

## Verdict
**BLOC 00: PASS** (GO pour le bloc 01). Ce verdict ne dit rien de la V0 : aucun contrat Zoom RTMS, Mac ou iPhone n'est vérifié (gates `REAL-*` NOT VERIFIED).

## Réellement fait
- **Audit** : `docs/audit.md` (arbre de dépendances, classification de chaque usage bot/Recall/join/Meeting SDK, composants réutilisables, dérives vs PRD, risques).
- **Code interdit archivé, pas supprimé** : `packages/providers` (port `MeetingProvider`/`createBot`, `MockMeetingProvider`, factory « recall », 4 tests) → `archive/bot-era/` (hors workspace, lint, build, tests). Fixture de démo synthétique **conservée** (`packages/core/src/demo-fixture.ts`). Libellé UI « Le bot s'appellera… » corrigé.
- **`bot_join=false` sans voie de réactivation** : `FEATURES.bot_join` = constante figée `false` ; `BOT_JOIN` n'accepte que « absent » ou `false` (tout autre ⇒ échec au démarrage dans tous les `APP_ENV`).
- **Garde-fou AST/grep `pnpm check:no-bot`** (CI) : appels `joinMeeting/createBot/startBot/…`, imports/requires (`recall*`, `meetingsdk`, `zoomus/websdk`, `ZoomMtg`), dépendances `package.json`, API Swift (`ZoomSDK`, `MobileRTC`…), hôtes de fournisseurs de bots, `bot_join=true` (code, `.env`, YAML). Autorise `@zoom/rtms` et `@zoom/appssdk`. **Test de mutation** : un fichier injecté avec un appel de jonction fait échouer le garde (exit 1), puis retiré.
- **Monorepo cible posé** : `services/{api,workers,rtms-gateway}`, `apps/{web,mac,zoom-surface}`, `packages/{core,contracts,ai}`, `db/`, `tests/`, `docs/`, `reports/` (déplacements via `git mv`, historique conservé ; chemins des scripts, e2e et CI corrigés).
- **Docs** : PRD v0.2 (l'ancien archivé), `ARCHITECTURE_ADR.md` (invariants I-1…I-6 + décisions A1…A8, ADR v0.0 révoqués listés), `DEPENDENCIES.md` (docs officielles RTMS/Web Push relues), `RELEASE_GATES.md`, `RISK_MATRIX.md` (R01–R40 → bloc → preuve, + reprises utiles de l'ancienne matrice), `STATUS_REALITY.md`, README.
- Rapports de l'ancienne numérotation conservés dans `reports/legacy/`.

## Commandes exécutées et résultats
| Commande | Résultat |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm secrets:scan` | PASS |
| `pnpm check:no-bot` (+ mutation) | PASS ; la mutation est bien rejetée |
| `pnpm lint` / `pnpm typecheck` | PASS |
| `pnpm test` | PASS 55 tests (dont 4 sur `bot_join`, 4 sur le garde-fou ; −4 tests du port bot archivé) |
| `pnpm test:integration` (Postgres 16 réel) | PASS 37 (migrations up/down/up, jobs/lease/fencing, readiness, auth, IDOR, CSRF, rate-limit) |
| `pnpm build` | PASS (Next + API + workers) |
| `pnpm test:e2e` (Playwright desktop + mobile) | PASS 2/2 |
| `pnpm check:prod-bundle` | PASS 10/10 |
| `sh scripts/crash-recovery.sh` (kill -9 Postgres) | PASS |
| CI GitHub | voir « CI » en bas |

Tests existants **non cassés** : aucune suite utile supprimée ; seuls les 4 tests du port `MeetingProvider` (interdit) sont archivés.

## Sécurité
Aucun secret ajouté ; aucun appel fournisseur ; logs expurgés inchangés ; le seul endpoint de simulation (`/dev/demo`) reste sous `MOCK_MODE` (interdit en prod) et étiqueté simulation.

## Écarts, limites et dettes (honnêtes)
- **Prérequis financier découvert** : RTMS exige un compte Zoom payant avec Developer Pack (Basic non supporté, erreur 2310) ; le démarrage REST exige participant invité + hôte présent (erreur 2308). Conditionne tout gate `REAL-ZOOM-*`.
- **Incohérence de documentation Zoom** : événements `meeting.rtms_started` (page streams) vs `postmeeting.rtms_started` (page add-features) ; chat RTMS non confirmé ; indicateurs visibles par les participants non documentés → à trancher avec un événement réel (bloc 06).
- Page Apple ScreenCaptureKit non servie à l'outil : capacités audio/micro/picker **non vérifiées**.
- Le garde-fou n'attrape que des motifs connus (liste de noms/modules) : il ne remplace pas l'audit final du bloc 19.
- Le modèle de données et l'auth restent ceux du v0.0 : pas de RLS, tables PRD D2 absentes (blocs 02–03), pas de PKCE Mac.
- Aucun Mac, iPhone ni compte Zoom RTMS dans l'environnement : blocs 04, 07, 08, 12 (réel), 18 seront `BLOCKED` pour la preuve réelle.
- `packages/core` conservé hors liste cible du prompt (justifié dans l'ADR A1).

## Bugs P0/P1
Aucun ouvert introduit. Matrice R01–R40 : 38 `NON COUVERT`, 2 `PARTIEL` (R36, R40) — volontairement, par bloc.

## Gates
`NO-BOT-GUARD`, `INVARIANTS-FROZEN`, `SOURCE-PRD`, `NO-SECRETS`, `MOCK-PROD-GUARD`, `STATUS-REALITY` : PASS. `REAL-ZOOM-RTMS`, `REAL-ZOOM-APP`, `REAL-MAC-CAPTURE`, `REAL-IPHONE-PUSH`, `REAL-STT/LLM`, `REAL-EMAIL` : NOT VERIFIED ; `STAGING-AUTH` : BLOCKED.

## GO / NO-GO
**GO** pour le BLOC 01 (contrats typés et machine d'états) — il est faisable sans Zoom/Mac/iPhone. Commande suivante : coller le BLOC 01 de `docs/prompts/CODEX_PROMPTS_MASTER.md`. Rien n'est lancé automatiquement.

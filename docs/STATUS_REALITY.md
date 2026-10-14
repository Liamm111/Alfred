# État réel du dépôt (après réajustement V0.2)

Audit du 14 octobre 2026. Ne décrit que des éléments observés. Aucun prototype antérieur n'existait (`main` = commit vide `b3efa7e`).

## Preuve du code existant vs mock vs non construit

| Portion (PRD V0.2) | Preuve | Statut |
|---|---|---|
| Invariant « aucun participant » (flag + garde AST + CI) | `packages/core/src/{features,env}.ts`, `scripts/forbid-bot-join.mjs` | **CONSTRUIT, testé** |
| Monorepo pnpm, TS strict, CI | `.github/workflows/ci.yml` | CONSTRUIT |
| PostgreSQL, migrations up/down, jobs/outbox durables, kill -9 | `db/`, `scripts/crash-recovery.sh` | CONSTRUIT (pas de RLS, tables v0.2 absentes) |
| Auth produit web (lien magique), sessions, guard, IDOR/CSRF | `services/api`, `apps/web` | CONSTRUIT (SMTP réel NON VÉRIFIÉ ; PKCE Mac absent) |
| Préférences/alias/rétention | `/api/me/preferences`, UI | CONSTRUIT (modèle à étendre, voir `audit.md` §4) |
| Démo déterministe | `/dev/demo/transcript` (MOCK_MODE) | **SIMULÉ**, étiquetée simulation |
| Contrats/machine d'états (`packages/contracts`) | — | NON CONSTRUIT (bloc 01) |
| Compagnon Mac (`apps/mac`) | — | NON CONSTRUIT, **aucun Mac disponible** |
| Zoom App in-client (`apps/zoom-surface`) | — | NON CONSTRUIT |
| RTMS Gateway (`services/rtms-gateway`) | — | NON CONSTRUIT |
| Capture audio/vision macOS, OCR | — | NON CONSTRUIT |
| STT, moteur d'interpellation, synthèse, devoirs | — | NON CONSTRUIT (`packages/ai` = format de corpus seulement) |
| Push iPhone / alertes Mac | — | NON CONSTRUIT |
| Suppression/rétention/consentement par séance | — | NON CONSTRUIT |
| Zoom réel, Mac réel, iPhone réel | — | **NOT VERIFIED** (gates `REAL-*`) |

« Non construit » ne signifie pas échec : aucun artefact n'existe encore. Aucun mock n'est présenté comme preuve.

## Correspondance anciens blocs (v0.0) → nouveaux blocs (v0.2)
| Ancien travail | Réutilisé pour |
|---|---|
| v0.0 B01 (fondation, jobs/outbox) | socle des blocs 02, 06, 12, 17 (le nouveau bloc 01 = contrats/machine d'états reste à faire) |
| v0.0 B02 (auth web, préférences) | partiel bloc 03 ; modèle de données à compléter au bloc 02 ; **le nouveau bloc 02 (RLS, schéma D2) reste à faire** |
| Rapports | `reports/legacy/BLOCK_0{0,1,2}_REPORT_v0.0.md` (historique) |

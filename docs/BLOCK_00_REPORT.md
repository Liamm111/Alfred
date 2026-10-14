# Rapport BLOC 00 — audit, dépendances réelles, garde-fous

Date : 14 octobre 2026. Remplace la tentative antérieure `codex/block-00-audit` (bloquée faute de PRD ; ses livrables ont été conservés et corrigés).

## Verdict
**BLOC 00: PASS** — critères du bloc remplis ; cela ne signifie PAS que la V0 est livrée (`REAL-ZOOM`, `REAL-PUSH` : NOT VERIFIED).

## Constat principal
Le « prototype existant » **n'existe pas** : `main` = commit vide `b3efa7e`. Aucune démo, aucun test, aucune migration. L'audit
conclut à un chantier vert-champ ; il n'y a rien à migrer ni à supprimer (ADR-005).

## Réellement fait
- PRD converti et versionné : `docs/PRD_V0_SOURCE_OF_TRUTH.md` (lu en entier).
- `docs/STATUS_REALITY.md` (table preuve vs mock), `ARCHITECTURE_DECISIONS.md`, `DEPENDENCIES.md`, `RELEASE_GATES.md`, `RISK_MATRIX.md`.
- `MOCK_MODE` explicite (`true|false`, défaut `false`), interdit en production : `scripts/validate-runtime-mode.sh`.
- Documentation officielle relue (Recall ×5, Zoom ×2) ; Apple **illisible** par l'outil (consigné, non inventé).
- Corrections vs tentative antérieure : APNs natif retiré (hors PRD, ADR-004) ; gates `SOURCE-*`/`DEMO-BOOT`/`EXISTING-TESTS` passent par « absence documentée » ; matrice P0/P1 réelle (64 lignes) au lieu de 7 risques provisoires.

## Commandes et résultats
| Commande | Résultat |
|---|---|
| `./tests/test-runtime-mode.sh` | PASS 7/7 |
| `sh -n scripts/validate-runtime-mode.sh` | PASS |
| démo / tests préexistants | non exécutables : n'existent pas (documenté) |
| lecture docs Recall/Zoom | OK ; Apple : contenu non servi |

## Sécurité
Aucun secret, aucun appel fournisseur authentifié, aucune action externe. `.gitignore` exclut `.env*` (sauf `.env.example`).

## Bugs P0/P1
Aucun code applicatif ⇒ les 64 lignes P0/P1 sont `NON COUVERT` (voir `RISK_MATRIX.md`) ; assignées aux blocs 01/02 quand couvrables, sinon « ≥03 ».

## Limites
- Les blocs ≥03 ne sont pas définis dans mes consignes : leur numérotation dans la matrice est provisoire.
- Page Apple Web Push non vérifiée ; pages Recall « création de bot/join_at » et « Deepgram multi » non relues.
- Le PRD affirme que le Meeting SDK est « non prévu pour les bots » ; la page lue ne le dit pas (noté).

## Gates
`REAL-ZOOM`, `REAL-PUSH`, `REAL-RECALL/STT/LLM` : **NOT VERIFIED**.

## Prochaine étape
BLOC 01 (fondation TS strict/DB/CI), où `MOCK_MODE` est porté dans le schéma d'environnement.

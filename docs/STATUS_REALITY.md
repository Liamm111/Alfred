# État réel du dépôt

Audit du 14 octobre 2026, refait après réception du PRD (`docs/PRD_V0_SOURCE_OF_TRUTH.md`,
converti depuis `PRD_V0_COMPLET.docx`). Cette page ne décrit que des éléments observés.

## Entrées observées

- Remote `origin` : `Liamm111/Alfred`. Branches : `main` (commit vide `b3efa7e`, « preserve empty initial
  repository state ») et `codex/block-00-audit` (tentative BLOC 00 antérieure, bloquée faute de PRD).
- **État initial conservé** : `main` @ `b3efa7e` (arbre vide) — aucune suppression possible, rien à migrer.
- **Prototype : inexistant.** Aucun `src/`, `tests/`, manifeste, démo, README historique ou migration avant
  la tentative `codex/block-00-audit`, qui n'a ajouté que docs + un garde-fou shell.
- PRD : maintenant présent et lu en entier (20 sections, 17 tables, 67 lignes de matrice de risques).

## Preuve du code existant vs mock

| Portion | Preuve recherchée | Connectée | Simulée | Non construite | Verdict |
|---|---|---|---|---|---|
| Application web / API / worker | manifeste, entrée | non | non | **oui** | NON CONSTRUIT |
| Démo déterministe | entrée de démo | non | non | **oui** | NON CONSTRUIT (voir BLOC 01) |
| Recall.ai | client, token, appel | non | non | oui | NOT VERIFIED |
| Zoom (réunion autorisée) | réunion, consentement hôte | non | non | oui | NOT VERIFIED |
| Web Push (VAPID/PWA iOS) | clés VAPID, appareil | non | non | oui | NOT VERIFIED |
| LLM / STT Deepgram | clé, appels | non | non | oui | NOT VERIFIED |
| Persistance / migrations | schéma | non | non | oui | NON CONSTRUIT |
| Authentification / autorisation | code, tests | non | non | oui | NON CONSTRUIT |
| Mode mock | `scripts/validate-runtime-mode.sh` + 7 tests shell | — | garde-fou seul | non raccordé à une app | PASS local (voir BLOC 01 pour le port TS) |

« Non » ne signifie pas échec : aucun artefact n'existe à inspecter. Aucune preuve fournisseur n'est fabriquée.

## Divergences avec le PRD V0

Tout le PRD §0.1 (10 critères de sortie) est **non satisfait**, faute de code. Le logiciel n'est pas livré.
Divergence avec la demande : le « prototype existant » annoncé n'existe pas ; le BLOC 00 devient un audit
d'absence + installation des garde-fous (docs, gates, matrice de risques, MOCK_MODE).

## Frontières de confiance (PRD §6, §10-34)

Transcriptions, chats, titres de réunion et liens sont des données non fiables : jamais d'instructions
système, d'outils, de secrets ni d'actions externes déclenchés par leur contenu.

# Gates de release

| Gate | Condition de passage | Preuve actuelle | État |
|---|---|---|---|
| `SOURCE-PRD` | PRD lu intégralement et versionné | `docs/PRD_V0_SOURCE_OF_TRUTH.md` | PASS |
| `SOURCE-PROTOTYPE` | prototype audité | aucun prototype n'existe (`STATUS_REALITY.md`) | PASS (absence documentée) |
| `INITIAL-STATE` | état initial conservé | `origin/main` @ `b3efa7e` (arbre vide) | PASS |
| `STATUS-REALITY` | table code vs mock | `docs/STATUS_REALITY.md` | PASS |
| `MOCK-PROD-GUARD` | production refuse le mock | `./tests/test-runtime-mode.sh` 7/7 | PASS |
| `DEMO-BOOT` | démo lancée ou cause documentée | cause : aucune démo n'existe | PASS (documenté) |
| `EXISTING-TESTS` | tests préexistants exécutés | aucun test préexistant | PASS (documenté) |
| `REAL-ZOOM` | cours Zoom réel autorisé, scopes, preuve expurgée | aucun compte/credential/consentement | **NOT VERIFIED** — « Gate REAL-ZOOM non validé, V0 non finie » |
| `REAL-PUSH` | push réel sur iPhone PWA, confirmé humainement | aucun appareil/clé VAPID | **NOT VERIFIED** |
| `REAL-EMAIL` | e-mail de connexion reçu via un vrai SMTP sur une boîte de test | transport codé, jamais exécuté contre un serveur réel | **NOT VERIFIED** |
| `STAGING-AUTH` | connexion + préférences + reconnexion sur un staging HTTPS avec auth configurée | aucun staging | **BLOCKED** (équivalent local : `apps/web/e2e/identity.spec.ts`) |
| `REAL-RECALL` / `REAL-STT` / `REAL-LLM` | appels réels authentifiés | aucune clé | NOT VERIFIED |

Gate final PRD §12.3 : `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `build`,
scan de secrets, migrations up/down, smoke déploiement, évals, test Push iPhone réel. **V0 non livrée** tant que les gates
`REAL-*` ne sont pas PASS.

Matrice P0/P1 complète avec bloc propriétaire et preuve exigée : [`RISK_MATRIX.md`](RISK_MATRIX.md).

# Gates de release (PRD V0.2 §K)

| Gate | Condition de passage | Preuve actuelle | État |
|---|---|---|---|
| `SOURCE-PRD` | PRD v0.2 lu en entier et versionné | `docs/PRD_V0_SOURCE_OF_TRUTH.md` | PASS |
| `INVARIANTS-FROZEN` | invariants écrits (ADR-I) | `docs/ARCHITECTURE_ADR.md` | PASS |
| `NO-BOT-GUARD` | aucun appel de jonction participant ; flag `bot_join` non réactivable ; CI | `pnpm check:no-bot` (+ test de mutation), `packages/core/test/features.test.ts` | PASS |
| `NO-SECRETS` | aucun secret dans le dépôt | `pnpm secrets:scan` | PASS |
| `STATUS-REALITY` | table preuve vs mock | `docs/STATUS_REALITY.md` | PASS |
| `MOCK-PROD-GUARD` | production refuse le mock | `packages/core/test/env.test.ts`, `pnpm check:prod-bundle` | PASS |
| `REAL-ZOOM-RTMS` | cours Zoom réel autorisé, scopes, hôte consentant, premier paquet décodé | aucun compte Zoom (Developer Pack requis), aucun hôte | **NOT VERIFIED** — « V0 non finie » |
| `REAL-ZOOM-APP` | Zoom App in-client lance `startRTMS()` sans ajouter de participant (liste avant/après) | aucune app Marketplace | **NOT VERIFIED** |
| `REAL-MAC-CAPTURE` | audio + fenêtre via ScreenCaptureKit sur Mac réel, avec consentement | aucun Mac | **NOT VERIFIED** |
| `REAL-IPHONE-PUSH` | push reçu sur iPhone physique, PWA installée, confirmé humainement | aucun appareil | **NOT VERIFIED** |
| `REAL-STT` / `REAL-LLM` | appels réels authentifiés, corpus mesuré | aucune clé | NOT VERIFIED |
| `REAL-EMAIL` / `STAGING-AUTH` | lien magique reçu par SMTP réel ; reconnexion sur staging HTTPS | aucun SMTP/staging | NOT VERIFIED / BLOCKED |

**V0 livrée seulement avec** : cours Zoom réel autorisé sur Mac, réception audio/visuelle réellement possible, interpellation détectée, notification reçue sur iPhone physique, compte rendu/devoir sourcé (K3). Un bloc `BLOCKED` n'est jamais promu PASS par un mock.

Gate technique PRD §K1 : `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `build`, `secrets:scan`, `check:no-bot`, `check:prod-bundle`, migrations up/down.

Matrice R01–R40 : [`RISK_MATRIX.md`](RISK_MATRIX.md).

# ARCHITECTURE_ADR — contrat d'architecture (PRD V0.2 hybride RTMS + Mac)

Remplace `docs/archive/ARCHITECTURE_DECISIONS_V0.0.md` (architecture bot Recall.ai). Un invariant ne peut être modifié que par un nouvel ADR justifié.

## Invariants figés (ADR-I)
- **I-1 Une seule présence Zoom.** L'utilisateur rejoint avec son compte ; **aucun participant, bot, avatar ou Meeting SDK** ajouté. `bot_join` = constante `false` sans voie de réactivation (`packages/core/src/{features,env}.ts`) ; `pnpm check:no-bot` en CI.
- **I-2 Sources et consentement.** RTMS officiel si scopes + hôte l'autorisent ; capture locale (ScreenCaptureKit) seulement avec consentements adaptés et **jamais pour contourner un refus explicite**. Aucun indicateur Zoom/Apple masqué ; Stop-All immédiat.
- **I-3 Preuves.** Toute note/devoir/question porte des `evidence_ids` ; rien d'affirmé sans preuve ; dates `null` si ambiguës.
- **I-4 Santé par flux.** `LIVE_*` exige un premier paquet décodé avec timestamps et une fraîcheur valide — jamais une simple connexion/webhook.
- **I-5 Entrées non fiables.** Transcriptions, OCR, chat = données ; aucun outil, secret ou action déclenchés par leur contenu ; LLM en extraction seule.
- **I-6 Zéro mock comme preuve.** Un bloc `BLOCKED` faute de Zoom/Mac/iPhone ne devient jamais PASS par un mock.

## Décisions techniques
- **ADR-A1 — Monorepo pnpm** : `apps/{mac,zoom-surface,web}`, `services/{api,rtms-gateway,workers}`, `packages/{contracts,ai,core}`, `db/`, `tests/`, `docs/`, `reports/`. `packages/core` (env, logger, erreurs, alias, préférences) est conservé en plus de la cible du prompt, car partagé API/web/worker.
- **ADR-A2 — PostgreSQL source de vérité** ; jobs/outbox transactionnels (`db/src/jobs.ts`) ; migrations Drizzle + `down` manuelles ; API/worker refusent de démarrer si le schéma est en retard. RLS à ajouter au bloc 02.
- **ADR-A3 — Auth produit** : Better Auth (lien magique) côté web/API ; sessions serveur HttpOnly ; CSRF par `Origin` ; guard fail-closed. L'app Mac utilisera PKCE + Keychain (bloc 03). Identité produit ≠ identité Zoom ≠ preuve de participation (bloc 03).
- **ADR-A4 — RTMS Gateway** (bloc 06) : `@zoom/rtms` en version verrouillée, webhooks signés vérifiés avant parsing, `source_epoch`, jitter, dead-letter.
- **ADR-A5 — Web Push VAPID sur PWA iOS** ; accepté par le service push ≠ lu (blocs 12/13).
- **ADR-A6 — STT/LLM interchangeables**, jamais bloquants pour capture ni alerte ; budgets et circuit breakers (blocs 10/11/17).
- **ADR-A7 — `MOCK_MODE` explicite, impossible en production** ; la démo `/dev/demo/*` n'existe que sous ce mode et est étiquetée simulation (conservée du v0.0).
- **ADR-A8 — Code « bot » archivé, pas supprimé** : `archive/bot-era/` pour l'historique, hors workspace/lint/build/test, exempté du garde-fou.

## ADR hérités du v0.0 toujours valables
Fail-closed d'autorisation (par `userId` de session, jamais d'id client) ; CSRF défense en profondeur ; pas d'énumération de comptes ; onboarding honnête sur le Push (`hasVerifiedPushSubscription`) ; alias `{raw, normalized}` ; forçage des contrôles Origin/CSRF de la bibliothèque d'auth (désactivés par défaut sous `NODE_ENV=test`).

## ADR du v0.0 **révoqués**
PRD-ADR-01 (« Zoom + Recall.ai + Deepgram »), PRD-ADR-02 partiel (backend centré bot), ADR-009 (MockMeetingProvider), ADR-005 de l'ancienne numérotation sur Recall. Remplacés par I-1…I-6.

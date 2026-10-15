# Décisions d'architecture

Les ADR-01…07 du PRD §18 sont **figées** ; elles sont reprises ci-dessous et complétées par des ADR locales.

## ADR du PRD (figées)
- **PRD-ADR-01** V0 = Zoom + Recall.ai + Deepgram FR/EN ; RTMS reporté (MeetingProvider abstrait).
- **PRD-ADR-02** Next.js + Fastify + worker + PostgreSQL ; pas de backend en mémoire en production.
- **PRD-ADR-03** Web Push sur PWA iOS avec test confirmé par l'utilisateur ; pas de push garanti en onglet Safari.
- **PRD-ADR-04** `transcript.data` final = source canonique du résumé ; `partial_data` = aperçu seulement.
- **PRD-ADR-05** Pas de participation simulée, de prise de parole ni d'émargement.
- **PRD-ADR-06** Preuve horodatée + statut d'incertitude pour chaque événement important.
- **PRD-ADR-07** Déploiement interdit si sécurité, Zoom autorisé, Push réel ou tests de sortie non vérifiés.

## ADR locales
- **ADR-001 — MOCK_MODE explicite, interdit en production.** Valeurs `true|false` strictes, défaut `false`.
  `MOCK_MODE=true` + `APP_ENV=production` ⇒ arrêt du processus. Implémenté en shell (BLOC 00, `scripts/validate-runtime-mode.sh`)
  puis dans le schéma d'environnement TypeScript (BLOC 01), validé au démarrage de chaque processus. Les routes de démo ne
  sont **enregistrées** que si `MOCK_MODE=true`.
- **ADR-002 — Fournisseurs non vérifiés par défaut.** Une page de documentation n'est pas un credential, un compte,
  un consentement ou un test. `REAL-ZOOM`, `REAL-PUSH` restent `NOT VERIFIED`.
- **ADR-003 — Entrées conversationnelles non fiables.** Voir PRD §6 et §10-34.
- **ADR-004 — Web Push (VAPID), pas APNs natif.** Le PRD cible une PWA (§1, §8). La tentative antérieure documentait
  APNs token-based ; hors périmètre V0 et retiré de `DEPENDENCIES.md`.
- **ADR-005 — Pas de suppression/réécriture du prototype.** Il n'existe pas. `main` (arbre vide) reste la baseline.

## ADR du BLOC 01
- **ADR-006 — Monorepo pnpm, packages TS « source-exportés ».** `@alfred/core|db|providers|evals` exportent leur source ;
  `tsx`/`vitest`/Next les consomment directement, `tsup` regroupe les packages `@alfred/*` dans `apps/api|worker/dist`
  (dépendances tierces externes, donc déclarées dans l'app). Ajout de `@alfred/db` (non listé au PRD §4) pour isoler schéma/migrations/jobs.
- **ADR-007 — Migrations : Drizzle (up) + `drizzle/down/<tag>.sql` écrits à la main (down).** drizzle-kit ne génère pas de rollback ;
  `migrateDown` n'exécute que des fichiers down existants et échoue sinon. Aucune migration automatique au démarrage : API/worker
  **refusent de démarrer** si le schéma est en retard (`assertSchemaUpToDate`, PRD O01).
- **ADR-008 — `job_queue` = file durable ET outbox transactionnel.** `enqueue(tx, …)` dans la transaction métier ; clé `unique(type, unique_key)` ;
  claim `FOR UPDATE SKIP LOCKED` avec bail ; jeton de fencing `(locked_by, attempts)` pour rejeter l'ack d'un worker zombie ;
  backoff exponentiel ; `dead` après `max_attempts` (y compris crashs répétés). Seul un **code d'erreur** est stocké, jamais un message.
- **ADR-009 — Démo déterministe = simulation, jamais en prod.** Routes `/dev/demo/*` et `MockMeetingProvider` n'existent que si `MOCK_MODE=true`
  (impossible avec `APP_ENV=production`) ; la factory de provider échoue bruyamment sinon. Aucun prototype antérieur n'existait à « porter ».

## ADR du BLOC 02
- **ADR-010 — Auth : Better Auth (plugin magic-link) sur Fastify, Drizzle/Postgres.** Bibliothèque éprouvée, sessions serveur en base
  (`auth_sessions`), cookie `alfred.session_token` HttpOnly + SameSite=Lax (+ Secure en https). Pas de mot de passe. Jeton de lien **haché**
  en base, usage unique, 15 min ; session 30 j glissante (le jeton de session est neuf à chaque connexion ; la révocation est immédiate car pas de cache de cookie).
  Les vérifications Origin/CSRF de la bibliothèque sont **forcées** (`disableOriginCheck/CSRFCheck:false`) car elle les coupe silencieusement
  quand `NODE_ENV=test` — un test l'a révélé (open-redirect non refusé).
- **ADR-011 — Autorisation fail-closed.** `makeRequireUser` est le seul producteur d'identité ; les routes privées sont enregistrées dans un plugin
  dont le hook `preHandler` l'impose ; tout le scope par `userId` de la session (jamais un id client) ; ressources enfants filtrées par propriétaire dans le `WHERE`
  (404 identique pour inconnu/étranger). Un test énumère `routeLog` et exige 401 sur chaque route `/api/*` privée.
- **ADR-012 — CSRF de défense en profondeur.** Toute requête non-GET sur `/api/*` doit porter `Origin == PUBLIC_WEB_ORIGIN`.
- **ADR-013 — Pas d'énumération de comptes ni de mail-bombing.** Réponse identique que l'envoi ait eu lieu ou non ; plafond 3 mails / 10 min / destinataire
  (mémoire, instance unique) + limite par client IP (IP résolue côté serveur via `TRUST_PROXY_HOPS`, jamais un en-tête client).
- **ADR-014 — Onboarding honnête sur le Push.** Tant qu'aucun abonnement Push n'est vérifiable (`hasVerifiedPushSubscription` = false), terminer l'onboarding
  exige le choix explicite « application ouverte seulement » (PRD §2.1, N01). Le serveur le fait respecter, pas seulement l'UI.
- **ADR-015 — Aliases.** Stockés `{raw, normalized}` ; normalisation NFKD sans accents/ponctuation/casse ; doublons après normalisation refusés explicitement ;
  alphabet restreint (pas de balisage, caractères de contrôle/bidi refusés). Pas de correspondance phonétique (T08 : listes contrôlées, plus tard).

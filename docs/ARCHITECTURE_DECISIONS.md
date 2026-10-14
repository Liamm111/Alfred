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

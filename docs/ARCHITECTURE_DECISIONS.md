# Décisions d'architecture

## ADR-000 — Ne pas inventer l'architecture absente

- **Statut :** accepté le 14 octobre 2026.
- **Contexte :** le dépôt distant est vide et le PRD est absent.
- **Décision :** ne sélectionner ni langage, ni framework, ni base, ni API
  fournisseur avant récupération et lecture du contrat fonctionnel.
- **Conséquence :** BLOC 00 reste bloqué pour l'audit produit. Seuls des
  garde-fous autonomes et réversibles sont ajoutés.

## ADR-001 — Mode simulé explicite et interdit en production

- **Statut :** accepté le 14 octobre 2026.
- **Décision :** `MOCK_MODE` accepte uniquement `true` ou `false`, vaut `false`
  par défaut, et `MOCK_MODE=true` avec `APP_ENV=production` arrête le processus
  avec une erreur. Les environnements acceptés sont `development`, `test`,
  `staging` et `production`.
- **Preuve :** `scripts/validate-runtime-mode.sh` et sept cas dans
  `tests/test-runtime-mode.sh`.
- **Limite :** aucune application n'existe encore ; tout futur point d'entrée
  doit invoquer le validateur avant d'accepter du trafic ou de lancer un worker.

## ADR-002 — Fournisseurs non vérifiés par défaut

- **Statut :** accepté le 14 octobre 2026.
- **Décision :** une documentation accessible ne prouve ni credentials, ni
  compte, ni consentement, ni scopes, ni comportement réel. Les gates
  `REAL-ZOOM` et `REAL-PUSH` restent `NOT VERIFIED` jusqu'à un test réel,
  autorisé et traçable.

## ADR-003 — Entrées conversationnelles non fiables

- **Statut :** accepté le 14 octobre 2026.
- **Décision :** transcription et chat restent des données ; ils ne peuvent
  piloter du code, lire des secrets ou déclencher directement des actions
  externes. Toute action sensible nécessitera validation structurée,
  autorisation serveur et journalisation sans secret.

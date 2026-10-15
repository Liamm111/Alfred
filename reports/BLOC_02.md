# BLOC 02 — Base PostgreSQL, migrations et isolation

**Verdict : PASS (PostgreSQL 16.15 réel, 39/39 tests)** · **GO** pour le BLOC 03.
Réserves : voir « Dettes » (GUC `app.user_id` modifiable par du SQL arbitraire ; retention non planifiée ; pas testé en charge).

## Livrables

| Livrable | Où | Statut |
|---|---|---|
| Schéma (users, sessions, capture_sources, packets, evidence(+packets), gaps, alerts, assignments(+evidence), jobs, outbox, secret_refs, retention_policies, deletion_receipts) | `db/migrations/0001_core.up.sql` | PASS |
| Migrations up/down, verrou consultatif, checksum, transaction par migration | `db/migrations/*`, `src/db/migrate.ts` | PASS |
| Idempotence : uniques `(owner, idempotency_key)`, `(session, epoch, modality, seq)`, `(owner, dedupe_key)` | SQL + `src/db/repo.ts` | PASS |
| Isolation : RLS sur 13 tables + `users`, FK composites `(session_id, owner_id)` | SQL | PASS |
| Transaction + outbox, relais `SKIP LOCKED` | `repo.ts` (`transitionSession`, `claimOutbox`) | PASS |
| Concurrence optimiste (`version` + trigger) | SQL + `ConcurrencyError` | PASS |
| Secrets : enveloppe chiffrée ou référence externe, jamais en clair | table `secret_refs` | PASS (le chiffrement applicatif arrive au BLOC 03) |
| Rétention | fonction `run_retention` (politique par utilisateur, défauts 7 j paquets / 90 j evidence) | PASS (exécutable, **non planifiée**) |
| Suppression vérifiable | `erase_user()` + `deletion_receipts` | PASS |
| Seed synthétique, refusé sans opt-in | `db/seed/synthetic_seed.sql` | PASS |

## Décisions

- **Pas de raw audio/image** : aucune colonne `bytea` dans `packets`/`evidence` (seulement `payload_sha256` + `payload_bytes`) ; test d'inventaire des colonnes `bytea` (seules `secret_refs.ciphertext/nonce`). Les entrées passent par le schéma Zod strict du BLOC 01 avant l'INSERT.
- **Le fail-safe du BLOC 01 est répliqué en base** : `CHECK` interdisant `LIVE_*` sans `verified_packets ≥ 1` et sans horodatage média correspondant (un transcript seul ne suffit pas) ; terminal ⇒ `outcome` cohérent ; trigger « un état terminal est final » ; `source_epoch` non décroissant.
- **Une seule session active par propriétaire**, garantie par un index unique partiel (sûr face aux courses), en plus de la règle du registre.
- **RLS fail-closed** : politique `owner_id = app_current_user()` ; sans `app.user_id` aucune ligne. Le rôle API `alfred_app` n'est ni superuser, ni `BYPASSRLS`, ni propriétaire (testé). `app.user_id` est posé par `set_config(..., true)` dans la transaction (aucune fuite vers la requête suivante, testé sur une connexion unique).
- **Défense en profondeur** : même en contournant la RLS (rôle `alfred_maintenance`), les FK composites refusent d'attacher le paquet d'un utilisateur à la session d'un autre.
- **Evidence ⇒ ≥1 paquet, assignment ⇒ ≥1 evidence** : triggers de contrainte différés (vérifiés au COMMIT).
- **Suppression** : cascade FK depuis `users`, puis `erase_user` recompte toutes les tables portant `owner_id`, échoue (et annule) s'il reste une ligne, et écrit un reçu anonyme (SHA-256 de l'id). Un utilisateur ne peut effacer que lui-même (SQLSTATE 42501).

## Tests exécutés (preuves)

`npx vitest run tests/db` → 3 fichiers, **39 tests, 39 PASS**, répétés 3 fois sans flakiness (journal : `reports/logs/bloc02-tests.txt`).

- **Accès cross-user interdit** : lecture, update, delete, insert au nom d'autrui, `users`, `jobs`, `outbox`, `secret_refs`, `retention_policies` ; absence de `app.user_id` ; rôle non privilégié.
- **Doublon clé idempotente** : session (séquentiel + 12 en parallèle → 1 ligne, 1 événement outbox), paquets (clé, `(epoch, modality, seq)`, 20 en parallèle → 1), jobs (8 en parallèle → 1), clé isolée par propriétaire.
- **Suppression et FK** : cascade session→enfants, orphelins refusés (23503), erasure vérifiée (compteurs, reçu anonyme), erasure d'autrui refusée sans effet.
- **Race conditions** : concurrence optimiste (4 écrivains, 1 gagnant, 0 événement pour les perdants), double activation simultanée (1 seule, 23505), 3 propriétaires en parallèle sans interférence, 6 workers sur 30 jobs (aucun doublon), 4 relais outbox concurrents (exactement une publication par événement), retry/dead-letter.
- **Rollback migration** : `down` complet (tables et fonctions disparues) puis `up` ; migration en échec entièrement annulée et non enregistrée ; migration modifiée après application détectée ; deux migrateurs concurrents appliquent une seule fois.
- **Outbox transactionnel** : crash avant commit et violation de contrainte dans la même transaction ⇒ ni changement ni événement.
- **Tests de mutation** : retirer la RLS de `sessions` fait échouer 3 tests ; retirer l'index « une session active » fait échouer le test de course ; migrations restaurées.

## Dettes / risques

1. **`app.user_id` est une variable de session** : tout SQL arbitraire exécuté par `alfred_app` pourrait la changer. Acceptable tant que l'API n'expose pas de SQL brut ; durcissement possible : un rôle/connexion par requête ou `SECURITY LABEL`/fonction signée.
2. Les tables ne sont pas `FORCE ROW LEVEL SECURITY` (le propriétaire de migration y échappe) : l'application ne doit jamais se connecter en propriétaire (vérifié côté rôle, pas côté déploiement).
3. `run_retention` n'est pas planifiée (aucun cron/job installé) ; l'outbox publiée est purgée à 7 jours en dur.
4. `secret_refs` ne fait que stocker ; le chiffrement/rotation de clés est livré au BLOC 03 ; aucun KMS réel branché.
5. Pas de test de charge ni de plan de sauvegarde/PITRs ; les rôles sont conservés par `down` (cluster-wide).
6. Les données `evidence.text` (transcript) peuvent être sensibles : la rétention (90 j par défaut) est à valider avec le PRD.

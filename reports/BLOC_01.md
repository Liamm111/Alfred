# BLOC 01 — Contrats typés et machine d'états

**Verdict : PASS (TS) — Swift : BLOCKED (non compilé, pas de toolchain)** · **GO** pour le BLOC 02 / **NO-GO** pour une livraison macOS tant que `swift test` n'a pas tourné.

Hypothèse : le PRD n'est pas présent dans le dépôt (vide au départ). Les entités et seuils ci-dessous sont des choix explicites, à confronter au PRD (voir « Dettes »).

## Livrables

| Livrable | Où | Statut |
|---|---|---|
| Schémas Zod (Session, CaptureSource, Packet, Evidence, Gap, Alert, Assignment) + types TS inférés | `src/contracts/schemas.ts` | PASS |
| JSON Schema générés (draft 2020-12, objets stricts) | `schemas/*.schema.json` | PASS (généré, drift-check) |
| Types Swift `Codable` générés depuis les mêmes schémas | `swift/AlfredContracts/.../Contracts.generated.swift` | **BLOCKED** : généré + test de cohérence TS↔Swift OK, jamais compilé |
| Machine d'états IDLE→…→COMPLETED/PARTIAL/FAILED | `src/contracts/state-machine.ts` | PASS |
| Seuils de fraîcheur par modalité, horloges, `source_epoch` | `src/contracts/freshness.ts` | PASS |
| Stop-all atomique, sessions multiples | `src/contracts/registry.ts` | PASS |
| Événements versionnés (`api_version=v1`, `schema_version=1.0.0`) | `src/contracts/events.ts` | PASS |
| Fixtures publiques synthétiques + scénarios rejouables | `fixtures/` | PASS |

## Décisions de conception

- **Un callback « connecté/started » ne prouve jamais un média.** `CONNECTED` est enregistré (`connected_callback_mono_ms`) mais ne change jamais l'état. On n'entre dans `LIVE_*` que par un `PACKET` audio/vidéo accepté : frais, non vide, bonne époque, bon `session_id`/`owner_id`, seq croissant. Un transcript seul ne prouve pas non plus un média. `CONNECTING` + callback sans média → alerte `connected_without_media` à 8 s, `FAILED(connect_timeout)` à 20 s.
- **Pas de LIVE mensonger à l'affichage** : `presentState()` rétrograde un `LIVE_*` stocké en `DEGRADED` si la fraîcheur est périmée (process gelé, aucun TICK) ; `assertLiveClaim()` lève une erreur ; horloge monotone qui recule ⇒ échec fermé.
- **Horloges** : fraîcheur calculée uniquement sur l'horloge monotone du récepteur ; `received_wall_ms` pour l'affichage ; `source_ts_ms` (source, non fiable) borné (futur ≤ 5 s ; retard source ≤ seuil modalité).
- **Seuils (par défaut)** : audio 3 s, vidéo 5 s, transcript 15 s (+ âge max de paquet 5/8/20 s, retard source max 10/15/30 s).
- **`source_epoch`** : strictement croissant ; `RESUME`/`RECOVERY_STARTED` exigent une nouvelle époque ; paquets d'une ancienne (`stale_epoch`) ou d'une époque non annoncée (`unknown_epoch`) rejetés.
- **Stop** : idempotent (double Stop = no-op visible `already_stopping`, version inchangée) ; émet `stop_sources` ; `registry.stopAll()` est tout-ou-rien (une session corrompue annule tout, vérifié).
- **Issue** : `COMPLETED` seulement sans trou ni erreur fatale ; trou/fatal ⇒ `PARTIAL` ; aucun paquet vérifié ⇒ `FAILED`.
- **Vie privée** : objets Zod stricts, aucun champ pour de l'audio/image brut (testé avec 6 noms de champ).
- Limite connue du JSON Schema : les `refine` (end ≥ start) ne s'y expriment pas ; ils restent imposés par Zod.

## Tests exécutés (preuves)

`npx vitest run tests/contracts` → **3 fichiers, 281 tests, 281 PASS** (journal expurgé : `reports/logs/bloc01-tests.txt`).

- Matrice exhaustive 14 états × 16 événements (224 cas) : tout couple absent de la table `ALLOWED` renvoie `INVALID_TRANSITION`, contexte inchangé (même référence), 0 effet ; invariants vérifiés après chaque cas. États terminaux absorbants.
- Silence : un modality perdue ⇒ trou + `LIVE_x` restant ; silence total ⇒ `DEGRADED` + alerte ; retour des paquets ⇒ trous refermés.
- Paquet expiré (délai récepteur, retard source), futur, doublon, désordre, époque périmée/inconnue, vide, autre session/propriétaire.
- Double Stop (en FINALIZING, après terminal, en IDLE), Stop depuis chaque état de capture.
- Audio seul → `LIVE_AUDIO`, vidéo seule → `LIVE_VIDEO`, les deux → `LIVE_AV`, dégradation partielle.
- Deux sessions : un propriétaire ne peut avoir qu'une session active ; deux propriétaires sont indépendants ; un paquet de A rejoué dans B est rejeté ; un autre propriétaire ne peut pas piloter la session.
- Fuzz déterministe : 3000 séquences × 40 événements ; invariant « on n'entre dans LIVE que par un PACKET » et invariants de contexte jamais violés.
- **Test de mutation** : en faisant passer `CONNECTED` en `LIVE_AUDIO`, 8 tests échouent (la suite détecte bien la violation du fail-safe) ; code restauré.
- Fixtures : 7 valides acceptées, 16 invalides rejetées, 8 types d'événements, 4 refus de version/forme, 8 scénarios rejoués, scan « données synthétiques uniquement », `gen:check` sans dérive.

## Dettes / risques

1. **Swift non compilé** (pas de toolchain Linux ici) : `swift build && swift test` à exécuter sur macOS ; le test `FixturesTests.swift` est écrit mais non exécuté.
2. **PRD absent** : noms de champs, entités et seuils sont des hypothèses ; un « silence » légitime (personne ne parle) se distingue mal d'une perte si la source n'envoie pas de paquets de silence ⇒ tout trou donne `PARTIAL`.
3. Les JSON Schemas n'expriment pas les `refine` ni la règle « version épinglée » côté non-TS.
4. La machine est pure ; la persistance (BLOC 02) doit appliquer `version` en concurrence optimiste.
5. Politique de compatibilité : schémas stricts ⇒ un producteur 1.x+1 ne peut pas écrire à un consommateur 1.x sans négociation.

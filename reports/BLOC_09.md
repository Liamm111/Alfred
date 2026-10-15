# BLOC 09 — Normalisation, alignement et fusion

**Verdict global : PASS sur la logique (18/18 tests, Linux) ; BLOCKED sur l'intégration RTMS réelle. GO pour le BLOC 10/11 sur ce contrat ; NO-GO production tant que l'adaptateur RTMS réel n'est pas validé.**

Contexte : dépôt vide au départ (pas de BLOCs 01–07), pas d'accès à Zoom RTMS. Le flux RTMS est donc **simulé** par `SourceNormalizer` avec `kind: 'rtms'` ; la forme réelle des messages RTMS n'a pas été mappée.

## Livrables

| Livrable | Statut | Où |
|---|---|---|
| Contrat unique `NormalizedEvidence` (audio/transcript/ocr) | PASS | `blocs-08-12/src/contracts/evidence.ts` (+ `validateEvidence`) |
| Ordre canonique, offsets UTC, timebase média | PASS | `blocs-08-12/src/merge/timebase.ts` (`ClockModel` type NTP, `MediaTimebase`), `canonicalCmp` |
| Provenance, `source_epoch`, health, freshness, segments de trou | PASS | contrat + `GapSegment` |
| RTMS préféré si attesté, fallback local pour modalités/intervalles manquants | PASS | `MeetingMerger` (rang 0 attesté / 1 RTMS non attesté / 2 local) |
| Anti-doublon overlap + texte + speaker | PASS | `#isDuplicate` |
| Cache/replay local borné | PASS | `blocs-08-12/src/merge/replay.ts` (SQLite, bornes items+octets, perte tracée) |
| Interdiction de fusion de deux réunions | PASS | `MergeHub`, `wrong_meeting`, `source_bound_elsewhere` |

## Propriété clé

La timeline est une **fonction pure de l'ensemble ingéré** : même résultat quel que soit l'ordre d'arrivée (test avec 5 permutations aléatoires). Un énoncé local reçu avant son jumeau RTMS est donc bien retiré a posteriori.

## Vérifications obligatoires

- **Dérive +1 min** : (a) horloge Mac non synchronisée → mise en **quarantaine** (hors timeline, `window().complete=false`), puis `rebaseSource(-60000)` → doublon correctement supprimé ; (b) horloge « synchronisée à tort » → détectée car l'événement finit dans le futur de l'horloge de confiance (`trusted_now_ms`) ; (c) dérive −1 min (indétectable par l'horloge) → détectée par appariement de texte RTMS/Mac (médiane −60 s sur 4 paires), corrigée par rebase.
- **Source reconnectée** : `seq` repart de 1, `evidence_id` reste unique grâce à `source_epoch` ; trou `reconnect` de 10 s exposé ; retransmission = `idempotent`.
- **Doublons audio similaires** : recouvrement ≥ 80 % fusionné, 50 % conservé ; speakers vérifiés différents (« oui » alice / « oui » bob) jamais fusionnés ; même mot 30 s plus tard conservé.
- **Changement de source au milieu d'une question** : `window()` renvoie les 3 segments dans l'ordre, une bascule `rtms-1 → mac-1`, un trou ouvert [5000, 6500] ms, `complete=false`, speaker du fallback `unknown`.
- **Deux meetings** : routage séparé, evidence B refusée par le merger A, source Mac liée à A refusée quand elle émet pour B.
- **Interdiction explicite** : `denied_by_policy` ou `capture_allowed=false` → toute ingestion refusée (y compris fallback local), trou `policy_blocked` jamais présenté comme comblé. Panne technique (`unavailable`) ≠ interdiction : fallback autorisé.
- Perf : 2 × 3 600 énoncés (≈3 h) fusionnés en ~0,4 s.

## Limites de la preuve

- Aucune donnée RTMS réelle, aucune signature/attestation vérifiée : `attested` est un booléen fourni par l'appelant.
- Seuils (overlap 0,5 / 0,8, similarité 0,8 / 0,95, tolérance futur 15 s, dérive 2 s) **non calibrés** sur des transcriptions réelles FR/EN.
- Le texte « identique » à 0,95 de similarité est fusionné même avec recouvrement faible : risque de fusionner deux répétitions volontaires très rapprochées (< 1 s) entre RTMS et Mac.

## Logs expurgés

`reports/logs/bloc09_tests.txt` : textes synthétiques uniquement, aucun identifiant réel.

## Dettes

1. Adaptateur RTMS réel (mapping des messages, vérification d'attestation, `meeting_uuid` d'instance).
2. Qui décide `denied_by_policy` ? Aujourd'hui un setter ; il faut la source de vérité (événement hôte/consentement) — c'est le point le plus sensible du bloc.
3. À l'entrée de l'interdiction, le contenu déjà ingéré est conservé (pas de purge) ; décision produit à prendre.
4. `ReplayBuffer` évince globalement le plus ancien (même au détriment d'une autre réunion) ; prévoir un quota par réunion.
5. La sélection est recalculée en O(n²) sur invalidation (OK à 3 h, à indexer pour de plus longs flux).
6. `media_*` est renseigné mais l'ordre canonique repose sur l'UTC ; la timebase média n'est pas utilisée pour corriger la dérive.
7. Dérive en retard non détectable sans paires de texte (sessions sans parole partagée entre sources).

## GO / NO-GO

GO pour BLOC 10–12 sur ce contrat. NO-GO production tant que les dettes 1–3 ne sont pas levées.

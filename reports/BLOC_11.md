# BLOC 11 — Moteur d'interpellations temps réel

**Verdict global : PARTIAL — moteur de règles, déduplication, annulation, enrichissement LLM (contrat) et feedback : PASS ; LLM réel et conditions réelles : BLOCKED. GO pour le BLOC 12 ; NO-GO pour annoncer un taux de détection.**

Aucun LLM, aucune transcription réelle de réunion n'était disponible. Le moteur est un **moteur de règles déterministe** (FR/EN) ; l'enrichissement LLM est une interface avec validation stricte, testée avec des LLM factices, **jamais avec un vrai modèle**.

## Livrables

| Livrable | Statut | Où |
|---|---|---|
| Préfiltre alias, vocatifs, impératifs, pronoms | PASS | `blocs-08-12/src/address/rules.ts`, `patterns.ts` |
| Contexte 15–60 s | PASS | `context_ms` borné [15 s, 60 s] (test sur le nombre de lignes envoyées au LLM) |
| LLM structuré (score, reason codes, evidence) | PARTIAL | `llm.ts` : schéma, prompt versionné, `parseVerdict` (extraits exacts obligatoires). **Aucun appel LLM réel.** |
| 5 classes + alerte | PASS | `DIRECT_CERTAIN→urgent`, `DIRECT_PROBABLE→normal`, mention/groupe/hors-sujet→aucune |
| Déduplication des relances | PASS | même demandeur 45 s, autre demandeur 15 s, fermée par la réponse de l'utilisateur |
| Règles d'abord, enrichissement non bloquant | PASS | `onSegment` synchrone ; LLM en tâche de fond, timeout 2,5 s, ne peut ni contourner une annulation ni dépasser `normal` s'il agit seul |
| Alerte sur provisoire | PASS | seulement pour l'appel explicite (CERTAIN) ; retirée si le final diverge ou annule |
| Feedback faux positif / raté + version | PASS | `feedback.ts`, `ENGINE_VERSION` sur chaque décision, export JSONL, candidats d'alias (jamais appliqués automatiquement) |

## Corpus et résultats

- `blocs-08-12/corpus/address_cases.ts` : **140 cas** (FR 76, EN 57, mixte 7), 13 catégories dont nom évoqué (23), homophones (10), questions indirectes (10), prénom absent (10), plusieurs Liam (10), phrases annulées (11), relances (10). 2 cas « limite connue » étiquetés avec la vérité terrain et vérifiés comme **non détectés** (STT « Lien », appel de présence).
- Exécution en deux modes (final seul, et provisoire+final) : mêmes classes, mêmes alertes nettes.
- **Une unique alerte directe par question** : vérifié sur les 140 cas × 2 modes (aucun `question_id` en double, aucune alerte pour une autre classe que DIRECT_*).
- **Aucune urgence pour une mention** : vérifié, aucune alerte sur les cas `MENTION_SIMPLE` (hors limite connue).

### Ce que les chiffres valent vraiment

Le corpus principal a été écrit en même temps que les règles, par le même auteur : il mesure la **cohérence interne** et sert de test de régression. Pour estimer la généralisation j'ai écrit deux jeux de contrôle **après** gel des règles et les ai exécutés **une fois** avant tout réglage :

| Jeu | Cas | Réussite à la 1ʳᵉ exécution | Après correction |
|---|---|---|---|
| Contrôle 1 | 41 | **31/41 (76 %)** | 41/41 |
| Contrôle 2 | 32 | **26/32 (81 %)** | 32/32 |

Journaux : `reports/logs/bloc11_holdout_first_run.txt`, `bloc11_holdout2_first_run.txt`. Après correction ces jeux sont devenus des tests de régression : **100 % n'est donc plus une mesure indépendante.** Estimation honnête de la généralisation sur mes propres formulations : **≈ 75–80 %**, sur un auteur unique, et probablement moins sur de la parole réelle (hésitations, STT bruité, chevauchements).

Défauts réels révélés par ces jeux, corrigés ensuite : « **Where is Liam?** » déclenchait une alerte **urgente** (le `?` après le nom était pris pour un appel) ; « Liam will present next week » / « Liam can explain it better than me » alertaient en urgent (modaux) ; « Liam, merci de nous avoir expliqué cela » alertait (participe passé pris pour un impératif) ; le discours rapporté (`Alice said: "Liam, can you help?"`) alertait. Deux étiquettes de ma part étaient fausses (h33, h34) et ont été corrigées ; c'est signalé dans les fichiers de corpus.

## Garde-fous (fail-safe)

- Chaque décision porte `reasons`, `uncertainty`, `evidence_spans`, `engine_version`. Les sollicitations sans prénom (« Peux-tu expliquer ? ») ne déclenchent **aucune** alerte mais laissent la trace `UNNAMED_SECOND_PERSON`.
- `ENGINE_GUARANTEE` : « meilleur effort, aucune garantie de tout détecter ». Le moteur **peut** rater un appel (limite connue : prénom mal transcrit à distance ≥ 2, sollicitation implicite).
- Nom phonétique seul (« Liame ») : jamais CERTAIN. Plusieurs Liam sans nom de famille : au plus PROBABLE. STT < 0,6 : au plus PROBABLE.

## Dettes / risques

1. LLM réel : calibrer les seuils (retrait ≥ 0,85/0,95, ajout ≥ 0,8, promotion ≥ 0,9), mesurer la latence, écrire l'adaptateur de transport. Les prompts ne sont pas évalués.
2. Corpus **réel** (transcriptions annotées par plusieurs personnes), avec précision/rappel par classe ; mesurer le taux de fausses alertes par heure de réunion.
3. Prénoms qui sont des mots courants (Will, Mark, Rose, Max…) : le moteur n'a aucune protection ; « will you » serait ambigu.
4. Surnoms/nom de famille seul : seulement après civilité (« Monsieur Martin »). Pas de suggestion d'alias automatique appliquée.
5. Les relances inter-demandeurs (15 s) fusionnent peut-être des demandes distinctes ; seuils non calibrés.
6. Les lexiques (impératifs, politesses, civilités, handover) sont courts, FR/EN seulement, et fixés à la main — chaque ajout est un risque de fausse alerte.
7. Le moteur ne connaît pas le vrai « moi » avec certitude si le roster RTMS change d'identifiant (invités, reconnexion).

## GO / NO-GO

- **GO** : intégrer au flux (BLOC 12) : l'API `EngineEvent` (alert / update / retract / closed / trace) est stable et idempotente par `question_id`.
- **NO-GO** : toute promesse de fiabilité ; l'affichage doit rester « meilleur effort ».

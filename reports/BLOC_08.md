# BLOC 08 — Vision Mac, fenêtres Zoom et OCR

**Verdict global : PARTIAL — logique PASS (Linux), intégration macOS BLOCKED. GO conditionnel / NO-GO pour production.**

Contexte d'exécution : conteneur Linux, sans macOS, sans Zoom, sans Xcode/`swiftc`. Le dépôt était vide (aucun résultat des BLOCs 01–07 n'existait). Tout ce qui dépend de ScreenCaptureKit / Vision / TCC n'a donc **pas pu être exécuté** ; la logique de décision a été isolée en TypeScript et testée.

## Livrables

| Livrable | Statut | Preuve |
|---|---|---|
| SCContentSharingPicker (fenêtre Zoom + fenêtre de partage) | **BLOCKED** (écrit, non compilé) | `blocs-08-12/mac/Sources/AlfredMac/SharePicker.swift` |
| Détection apparition/disparition/état de fenêtre | PASS (logique) | `blocs-08-12/src/vision/windows.ts`, tests `fenêtre disparue…`, `minimisé`, `autre Space` |
| Filtrage « Zoom seulement » | PASS (logique) | `evaluatePick`, `cropMasked` ; tests `contenu non-Zoom exclu`, `plein écran…` |
| Échantillonnage limité + change-detection | PASS | `blocs-08-12/src/vision/sampler.ts` (dHash 64 bits, plafond dur 500 ms, heartbeat) |
| Frame hash + quality score + preuves horodatées | PASS | `NormalizedEvidence` modality `ocr` avec `frame_hash`, `quality_score`, `utc_*`, `clock_offset_ms` |
| OCR Vision local | **BLOCKED** (écrit, non exécuté) | `VisionOCR.swift` (fr-FR, en-US, `.accurate`) |
| Fenêtre réduite / autre Space / 2ᵉ écran / minuscule / flou / multi-fenêtre | PASS (logique) | voir tests |
| Aucun enregistrement vidéo continu ; image facultative TTL court | PASS | `FrameStore` (désactivé par défaut, TTL ≤ 5 min, purge sur révocation) |

## Tests exécutés (Linux, Node 22) — 19/19 PASS

Log : `reports/logs/bloc08_tests.txt` (`npm test` dans `blocs-08-12/`). Couverture des vérifications demandées :

- **Slides avec changements** : 2 diapos → `slide-1`/`slide-2` ; frame identique → `unchanged`, 1 seul appel OCR.
- **Zoom minimisé / caché / autre Space** : réponse `unavailable` (jamais l'ancienne diapo), trou `not_visible` de 4000 ms tracé, recapture forcée au retour.
- **Partage plein écran** : fenêtre non-Zoom (`com.apple.mail`) recouvrant → pixels noircis avant OCR, la chaîne `SECRET` n'apparaît dans aucune evidence ; Zoom absent → 0 capture, 0 OCR ; Zoom recouvert > 50 % → `occluded`.
- **OCR lisibilité** : texte net → `good` (3/3 lignes exactes) ; texte de ~7 px → `illegible`, `dropped_tiny` ; flou rayon ≥ 3 → `illegible` ; faible contraste → `illegible`. Le flou fait chuter `quality_score` (1.00 → 0.51 → 0.39 → 0.31…).
- **Permission retirée** : arrêt immédiat, images purgées, frames natives ignorées (`dropped`), trou `permission_revoked` de 4000 ms, reprise = nouvelle `source_epoch` et **pas** de reprise implicite de l'ancienne diapo.
- **Contenu non Zoom exclu** : sélection d'une fenêtre Safari refusée, 0 OCR.
- **Pas de vidéo continue** : un flux offert à 30 fps donne ≤ 2 traitements en 10 s ; store désactivé par défaut ; TTL > 5 min refusé ; fichiers réellement supprimés sur disque à l'expiration et à `finalize`.

Défaut trouvé *par* les tests puis corrigé : après un blocage (minimisé, permission), la dernière diapo redevenait « disponible » au retour de la fenêtre. Corrigé (`SlideTracker.#needsObservation`) : l'ancien contenu n'est ré-affirmé qu'après une nouvelle observation.

## Limites de la preuve (à lire)

- L'OCR utilisé en test est un **OCR jouet** (`blocs-08-12/tests/support/font.ts`, police 5×7 majuscules). Il réagit à de vrais pixels (flou, taille, contraste) mais **ne prouve rien sur la précision d'Apple Vision** (accents, casse, polices réelles, slides denses).
- Seuils (`MIN_LINE_HEIGHT_PX = 9`, confiance 0.5, dHash ≥ 4, stale 30 s) : **heuristiques non calibrées** sur de vraies captures Zoom.
- Aucune capture ScreenCaptureKit réelle ; comportement de `SCWindow.isOnScreen` (Spaces, plein écran natif macOS, 2ᵉ écran) supposé d'après la documentation, **non vérifié**.

## Logs expurgés

Les logs de test ne contiennent que des textes synthétiques (« PLAN DU COURS », etc.). Aucun log de capture réelle n'existe. Le texte OCR n'est jamais journalisé hors `NormalizedEvidence`.

## Dettes

1. Compiler et lancer `blocs-08-12/mac/` sur macOS 14+ ; tester TCC (Enregistrement d'écran) retiré en cours de réunion (`SCStreamDelegate.didStopWithError`).
2. ScreenCaptureKit n'expose pas « réduit » : `minimized` est toujours `false` côté Swift, la fenêtre apparaît `on_screen=false` → mappée `other_space`. Distinguer exige l'API Accessibilité (permission en plus).
3. Corpus réel de slides Zoom (flou de compression, texte < 12 px, thèmes sombres) pour calibrer les seuils ; mesurer WER-équivalent de l'OCR.
4. Capturer en mode `singleDisplay` avec `SCContentFilter(display:including:)` côté natif (défense en profondeur ; le masquage TS existe mais le natif ne doit pas livrer de pixels non-Zoom du tout).
5. Chiffrer le store disque si l'option est activée en production (aujourd'hui fichiers bruts, TTL ≤ 5 min).
6. Les bundle IDs Zoom ne sont que `us.zoom.xos` ; vérifier les variantes (Zoom Workplace, clients entreprise).

## GO / NO-GO

- **GO** pour poursuivre l'intégration (les décisions fail-safe sont testées et le contrat evidence est stable).
- **NO-GO** pour déclarer le BLOC 08 terminé en production tant que les points 1–3 ci-dessus ne sont pas exécutés sur un Mac réel.

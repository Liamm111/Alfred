# BLOC 04 — Compagnon Mac natif SwiftUI

**Verdict global : PARTIAL — build Mac PASS (CI macos-14), tests UI réels et vérifications manuelles non faites** · **GO/NO-GO : GO conditionnel** (NO-GO produit tant que MANUAL_MAC_ZOOM §B et des XCUITest ne sont pas faits).

**Mise à jour (PR Liamm111/Alfred#3) :** le job CI `mac` (macOS, Swift) est **vert** sur le commit `d70ad81` : `swift build -c release` (cible `AlfredCompanion` comprise), `swift test` (**45 tests, 0 échec sur macOS**) et `scripts/build_app.sh` (bundle `.app` signé ad hoc, hardened runtime, vérification `codesign`). Les deux premiers runs avaient échoué sur de vraies erreurs de compilation (`StateStore` struct, capture de `self`, plist d'entitlements invalide), corrigées. Ni signature Developer ID ni notarisation n'ont été exécutées. Le texte ci‑dessous « BLOCKED / non compilé » décrit l'état avant ce run.

Environnement : Linux x86_64, Swift 6.0.3 (toolchain Linux installée pour l'occasion). Pas de macOS, Xcode, SwiftUI, AppKit ni ScreenCaptureKit.

## Livrables
| Exigence | Statut | Preuve |
|---|---|---|
| App SwiftUI + AppKit, menu bar + fenêtre principale, icône/statuts lisibles | **Écrit, non compilé** | `mac/Sources/AlfredCompanion/*.swift` (MenuBarExtra, Window, NSApplicationDelegateAdaptor). Les 5 fichiers passent `swiftc -parse` (syntaxe seulement ; **pas de typage vérifié**). Icône = SF Symbol piloté par `StatusPresenter`. |
| Détection Zoom = indice seulement | **PASS (logique)** | `ZoomHint`/`ZoomHintDetector` n'ont aucune API de déclenchement ; tests `testZoomHintLevels`, `testDetectionStartAndLifecycleNeverFocusZoom`. |
| Boutons explicites Start/Pause/Resume/Stop (+ STOP TOUT), Onboarding, Diagnostics | **PASS (logique) / non compilé (vues)** | `CompanionController` exige un `UserAction` ; `Onboarding.next`, `DiagnosticsReport`. |
| Permissions en états distincts | **PASS (logique)** | `PermissionStatus` = notDetermined/granted/denied/restricted/unavailable ; `ScreenRecordingResolver` (macOS n'a pas de tri‑état natif : « denied » = refusé après une demande mémorisée). Provider réel `MacPermissionProvider` non compilé. |
| Cycle de vie sleep/wake/lock | **PASS (logique)** | `testSleepAndLockStopAndPurgeWakeNeverResumes`, `testPolicyCanKeepCapturingThroughLock`, `testTerminateStopsEverything`. Observateurs `LifecycleObserver` non compilés ; les notifications `com.apple.screenIsLocked/Unlocked` sont non documentées par Apple (à valider). |
| Focus Zoom uniquement après clic | **PASS (logique)** | `ZoomFocusCoordinator.focusZoom(UserAction)` seul point d'entrée ; test : 0 appel après détection/start/veille/réveil. |
| Signable/notarisable | **Préparé, non exécuté** | `Info.plist`, `.entitlements` (audio‑input), `scripts/build_app.sh` (hardened runtime `--options runtime`, notarytool, stapler). Aucune signature réalisée. |
| Logs redacted | **PASS** | `LogRedactor` + `RedactingLogger` (tests `testRedaction`, `testDiagnosticsReportIsRedactedAndComplete`) ; `FileLogSink` écrit uniquement des lignes déjà expurgées. |

## Vérifications obligatoires
| Vérification | Statut | Détail |
|---|---|---|
| Build Mac | **PASS (CI)** | Voir mise à jour ci‑dessus. (Avant : aucun macOS local.) `.github/workflows/ci.yml` job `mac` (macos-14) à exécuter. `Package.swift` exclut la cible app hors macOS. |
| UI : permission refusée | **PARTIEL** | Testé au niveau *état de présentation* (`UIStateTests.testPermissionDeniedShowsSettingsButtonAndDisablesStart`, `testEachPermissionStateHasDistinctMessage`) + `--uitest-permission=denied` prévu pour XCUITest. **Aucun XCUITest écrit ni exécuté** (dette). |
| UI : stop‑all | **PARTIEL** | `testStopAllAvailableWheneverSomethingRuns` (bouton dispo même si permission révoquée), `testStopAllStopsEverySource…` (audio + micro stoppés, buffer purgé, callbacks tardifs ignorés, idempotent). |
| UI : redémarrage app | **PARTIEL** | `testRestartNeverResumesCapture` (relance sur même store → Inactif, bannière « interrompue », 0 source créée), `testOnboardingFlagSurvivesRestart`. Pas de test de relance de processus réel. |

## Tests exécutés
`cd mac && swift test` (Linux) : **45 tests, 0 échec** — voir `reports/evidence_bloc04_07_swift_core_tests.txt`. Ces 45 incluent aussi les tests Bloc 07.
Logs expurgés : `reports/evidence_redacted_log_sample.txt` (gateway) ; côté Mac voir tests de redaction.

## Dettes
1. Compiler/typer toute la cible `AlfredCompanion` sur macOS (risque réel d'erreurs de compilation : API `CMSampleBuffer.withAudioBufferList`, `MenuBarExtra`, isolation d'acteurs).
2. XCUITest réels (menu bar, bannière refus, STOP TOUT, relance).
3. Vérifier sur macOS 14/15 : redémarrage requis après octroi Screen Recording ; prompts périodiques de Sequoia.
4. Signature Developer ID + notarisation (script prêt, jamais lancé). Pas d'icône d'app (`.icns`).
5. `CGWindowListCopyWindowInfo` : confirmer l'absence de prompt de permission.
6. Association/nonce côté Mac (appel backend pour obtenir le code court) non implémentée : la Zoom App attend `?n=CODE`.

**GO/NO-GO : NO-GO** (preuve de build absente). Passage à GO : CI `mac` verte + §B de `mac/MANUAL_MAC_ZOOM.md` P1–P9 remplis.

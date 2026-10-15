# BLOC 07 — Capture audio native macOS autorisée

**Verdict : PARTIAL — pipeline Core PASS (Linux et macOS), adaptateur ScreenCaptureKit COMPILE (CI macOS) mais jamais exécuté ; validation matérielle BLOCKED** · **GO/NO-GO : NO-GO.**

**Mise à jour (PR Liamm111/Alfred#3) :** le job CI `mac` est vert (commit `d70ad81`) : `AudioSources.swift` compile sur macOS et les 45 tests Swift passent sur macOS. Aucune capture réelle n'a été exécutée (CI sans Zoom, sans audio, sans permission Screen Recording) ; isolation, AirPods, changement de sortie et STOP réel restent à mesurer (`mac/MANUAL_MAC_ZOOM.md` §C).

## Livrables
| Exigence | Statut | Preuve |
|---|---|---|
| ScreenCaptureKit : sélection de contenu, `capturesAudio=true`, micro séparé consenti | **Écrit, non compilé** | `AudioSources.swift` (`SCStreamConfiguration.capturesAudio=true`, `excludesCurrentProcessAudio=true`, filtres fenêtre/application/écran dans `AppModel.reloadChoices`). Micro = `MicrophoneSource` distincte, créée seulement si case + consentement (`CompanionController` refuse sinon : test). Aucune sélection par défaut. |
| Horodatages monotones | PASS (Core) / non vérifié (Mac) | `MonotonicClock` ; `SystemMonotonicClock` jamais décroissant (10 000 lectures). Côté Mac : `HostTimeClock` = horloge des PTS `CMSampleBuffer` — **cohérence à valider**. |
| Conversion PCM stable | PASS (Core) | `PCMConverter` : Float32 planaire stéréo 48 kHz → s16 mono 16 kHz, état conservé entre buffers (test : conversion en flux ≈ conversion d'un bloc, écart < 400 LSB), écrêtage, entrées invalides. |
| Ring buffer chiffré borné | PASS | `EncryptedRingBuffer` AES‑256‑GCM (CryptoKit / swift‑crypto sous Linux), AAD = (source, ts), borné en octets (plus ancien supprimé, compteur), pas de clair dans les blobs, altération détectée, `purge()` vide **et change la clé**. |
| Santé bitrate / silence | PASS | `AudioHealthMonitor` : bitrate ≈ 256 kb/s mesuré, `silent`, `absent` (jamais reçu / plus de données), `gap` (trou 500 ms mesuré). |
| Sélection explicite fenêtre/app/écran ; casque/Bluetooth/HP ; détection de pollution | Sélection : écrit. **Tests matériel : BLOCKED** | `IsolationProbe` (phases A/B) testée sur fixtures ; protocole matériel dans `mac/MANUAL_MAC_ZOOM.md` §C. |
| Interrupteur global Stop : audio + micro + purge | PASS (Core) | `testStopAllStopsEverySourceImmediatelyPurgesAndDropsLateCallbacks` : barrière d'entrée fermée **avant** l'arrêt des sources, callbacks tardifs ignorés, purge, idempotent. Arrêt effectif de `SCStream`/`AVAudioEngine` non vérifié sur Mac. |

## Vérifications obligatoires
| | Statut |
|---|---|
| Tests fixture sample buffers | **PASS** — `CaptureTests` 16/16 (dans les 45 tests Swift, `reports/evidence_bloc04_07_swift_core_tests.txt`), dont un scénario « audio normal → sortie changée (absent) → reprise à 44,1 kHz mono → trou visible ». |
| MANUAL Mac Zoom : haut‑parleur, AirPods, changement de sortie, écho, audio absent | **BLOCKED** — grille prête (A1–A9), **aucun résultat** ; pas de Mac, pas de Zoom, pas d'audio. |

## Risque spécifique
Isolation par filtre fenêtre **non supposée** : `CaptureSelection.isolationValidatedByDefault == false` pour tous les modes, le protocole §C mesure RMS_A (Zoom seul) vs RMS_B (autre app seule) pour chaque mode ; un mode « pollué » ne doit pas être proposé par défaut. **Aucune mesure réelle n'existe.**

## Dettes
1. Compiler/exécuter `AudioSources.swift` (usage de `CMSampleBuffer.withAudioBufferList` + `AVAudioPCMBuffer(bufferListNoCopy:)`, sémaphores autour de `startCapture/stopCapture` — à tester contre un blocage du thread principal).
2. Mesures d'isolation par mode, AirPods (HFP/A2DP, changement de fréquence), écho.
3. Sortie du ring buffer : rien ne consomme encore `drain()` (transport/ASR = blocs suivants). Politique de rétention/purge à valider avec le produit.
4. Changements de configuration en cours de flux (changement de sortie) : la reprise automatique du stream n'est pas implémentée (on signale `absent`/`gap`).
5. Pas d'indicateur utilisateur dédié en cas de pollution détectée à l'exécution (seule la sonde manuelle existe).

**GO/NO-GO : NO-GO** jusqu'à build Mac + §C A1/A4/A5/A7/A9 + verdicts d'isolation.

# Alfred — blocs 04 à 07

| Dossier | Bloc | Contenu |
|---|---|---|
| `mac/` | 04, 07 | Swift package : `CompanionCore` (logique testée, Linux+macOS) + `AlfredCompanion` (SwiftUI/AppKit/ScreenCaptureKit, macOS seulement) |
| `zoom-app/` | 05 | Zoom App (Zoom Apps SDK) + contrôleur testé avec SDK mocké + doc d'installation + script manuel |
| `gateway/` | 06 (+ association 05) | Gateway Node : webhooks signés, `@zoom/rtms` 1.1.0, sessions, normalisation |
| `reports/` | | `BLOC_04.md` … `BLOC_07.md` + preuves `evidence_*` |

Tests : `cd gateway && npm ci && npm test` · `cd zoom-app && npm i && npm test` · `cd mac && swift test` · CI : `.github/workflows/ci.yml` (le job `mac` débloque 04/07).

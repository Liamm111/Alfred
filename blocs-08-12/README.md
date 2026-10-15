# Alfred — blocs 08 à 12

Détecte, pendant une réunion Zoom, quand l'utilisateur est sollicité, et l'alerte (Mac + iPhone).
Ce dépôt contient le **cœur logique testable** (TypeScript, Node 22, zéro dépendance d'exécution) et les **sources natives non compilées** (Swift, `mac/`).

| Bloc | Sujet | Code | Rapport |
|---|---|---|---|
| 08 | Vision Mac, fenêtres Zoom, OCR | `src/vision/`, `mac/` | `reports/BLOC_08.md` |
| 09 | Normalisation, alignement, fusion | `src/contracts/`, `src/merge/` | `reports/BLOC_09.md` |
| 10 | STT multilingue, diarisation honnête | `src/stt/` | `reports/BLOC_10.md` |
| 11 | Moteur d'interpellations | `src/address/`, `corpus/` | `reports/BLOC_11.md` |
| 12 | Outbox, push iPhone, alertes Mac | `src/outbox/`, `web/`, `mac/` | `reports/BLOC_12.md` |

```
npm install        # typescript + @types/node uniquement
npm run check      # tsc + 109 tests (Node ≥ 22.18)
node scripts/holdout.ts ; node scripts/holdout2.ts   # jeux de contrôle du BLOC 11
```

**Statut honnête** : les décisions de sécurité (fail-safe) sont testées ; **rien n'a été exécuté sur macOS, sur iPhone, avec Zoom/RTMS, un vrai STT ou un vrai LLM**. Voir les rapports pour les PASS / BLOCKED exacts. Les BLOCs 01–07 n'étaient pas présents dans le dépôt ; leurs interfaces sont donc supposées (voir `src/contracts/evidence.ts`).

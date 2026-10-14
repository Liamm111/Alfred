# Gates de release

## Gates BLOC 00

| Gate | Condition de passage | Preuve actuelle | État |
| --- | --- | --- | --- |
| `SOURCE-PRD` | PRD lu intégralement et versionné | fichier absent | `BLOCKED` |
| `SOURCE-PROTOTYPE` | `src/`, tests, README et historique audités | dépôt initial vide | `BLOCKED` |
| `INITIAL-STATE` | état initial conservé avant changement | branche locale `initial-state/block-00`, commit vide `b3efa7e` | `PASS` |
| `STATUS-REALITY` | table code existant vs mock | `docs/STATUS_REALITY.md` | `PASS` |
| `MOCK-PROD-GUARD` | production refuse le mock | test shell dédié | `PASS` |
| `DEMO-BOOT` | démo lancée ou cause documentée | aucun code/manifeste/point d'entrée | `BLOCKED` documenté |
| `EXISTING-TESTS` | tests préexistants exécutés | aucune suite préexistante | `BLOCKED` documenté |
| `REAL-ZOOM` | test réel autorisé avec scopes et preuve expurgée | aucun compte/credential/consentement | `NOT VERIFIED` |
| `REAL-PUSH` | push réel autorisé vers un appareil consenti | aucun compte/credential/appareil/consentement | `NOT VERIFIED` |

Le passage au bloc suivant est interdit tant que `SOURCE-PRD` et
`SOURCE-PROTOTYPE` ne sont pas résolus puis audités.

## Risques P0/P1

La matrice P0/P1 du PRD ne peut pas être recopiée ni affectée aux blocs : le PRD
est absent. La table suivante couvre uniquement les risques explicitement
énoncés dans la demande BLOC 00 ; elle ne prétend pas remplacer la matrice du
PRD.

| Priorité provisoire | Risque explicite | Bloc propriétaire | Preuve exigée |
| --- | --- | --- | --- |
| P0 | mock actif en production | BLOC 00 | test de démarrage refusé avec `APP_ENV=production MOCK_MODE=true` |
| P0 | secret exposé côté client ou dans les logs | bloc d'intégration à déterminer après PRD | test de bundle/log et scan de secrets |
| P0 | transcript/chat pilotant code, secret ou action externe | bloc d'ingestion/action à déterminer après PRD | tests d'injection et d'autorisation négatifs |
| P0 | bot usurpant l'étudiant, faux émargement ou contournement d'admission | bloc réunion à déterminer après PRD | tests E2E avec preuve de consentement et refus |
| P0 | intégration annoncée réelle sans credentials/test réel | tous blocs fournisseurs | gate réel avec résultat expurgé et traçable |
| P1 | action externe dupliquée ou non traçable | bloc action à déterminer après PRD | tests d'idempotence et audit log |
| P1 | notification sans droit d'accès/consentement | bloc push à déterminer après PRD | tests d'autorisation et révocation |

Les numéros de blocs définitifs et l'exhaustivité doivent être réconciliés avec
la matrice du PRD dès qu'elle est fournie.

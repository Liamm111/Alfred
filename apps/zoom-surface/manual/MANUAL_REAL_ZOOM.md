# MANUAL_REAL_ZOOM — Zoom App / RTMS (à exécuter par un humain)

Statut : **NON EXÉCUTÉ** (aucun client Zoom dans l'environnement de build). Remplir le tableau de résultats ci‑dessous et le joindre à `reports/BLOC_05.md`.

Matériel : 2 comptes Zoom (A = hôte, B = participant), client Desktop ≥ 6.4.10, Zoom App installée sur A (docs/INSTALL.md), gateway lancé (`ALLOW_UNASSOCIATED` absent).

## Preuve « aucun nouveau participant »
1. A démarre une réunion, B la rejoint. Ouvrir la Zoom App dans la réunion de A.
2. Dans la console du webview (ou via l'inspecteur Zoom) : `__alfredSnap = (await zoomSdk.getMeetingParticipants()).participants`.
3. Noter aussi le nombre affiché dans le panneau *Participants* Zoom : **N_avant = ___**.
4. Scénario S1 (approbation) : cliquer « Démarrer RTMS » → l'hôte approuve → attendre l'état `started` (et `meeting.rtms_started` dans les logs gateway).
5. Console : `copy(JSON.stringify(__alfredCtl.participantsUnchanged()))` doit donner `"same":true` ; refaire `getMeetingParticipants()` à la main, comparer, compter à nouveau : **N_après = ___** (doit égaler N_avant, aucune entrée « RTMS/bot »).

## Cas à jouer
| # | Scénario | Attendu | Résultat | Date | Preuve (capture/log expurgé) |
|---|---|---|---|---|---|
| S1 | request → approve | état `started`, `rtms_started` reçu, participants identiques | | | |
| S2 | request → deny par l'hôte | état `denied`, aucun `rtms_started`, participants identiques | | | |
| S3 | RTMS désactivé (compte/admin/hôte) | état `disabled` ou `error` ; **noter le code/message exact reçu** (classifieur à ajuster) | | | |
| S4 | B (non hôte) ouvre la Zoom App | noter comportement `startRTMS` participant (rôles supportés selon typings : Host, Co‑host, Participant…) | | | |
| S5 | Invité / non connecté | état `guest` ou `unavailable` | | | |
| S6 | App ouverte hors Zoom (navigateur) | état `unavailable` | | | |
| S7 | Hôte arrête RTMS depuis l'UI Zoom | état `stopped`, `rtms_stopped` reçu, pas de reconnexion gateway | | | |
| S8 | Nonce expiré / réutilisé | état `association_failed`, `startRTMS` **non appelé** | | | |
| S9 | Fermer/rouvrir la Zoom App pendant RTMS actif | l'état `started` est restauré (getRTMSStatus) | | | |

Critères GO : S1, S2, S7, S8 réussis avec preuves ; S3/S4 documentés avec les codes d'erreur réels.

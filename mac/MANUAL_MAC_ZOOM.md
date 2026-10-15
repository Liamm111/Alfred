# MANUAL_MAC_ZOOM — validation audio réelle (Bloc 07) et UI (Bloc 04)

Statut : **NON EXÉCUTÉ** (aucun Mac dans l'environnement de build). À jouer sur un Mac (macOS 13+; 14/15 recommandé) avec Zoom Desktop,
en remplissant les tableaux. Fournir les captures + `Diagnostics › Copier (expurgé)` pour chaque ligne.

## A. Build
`cd mac && swift build -c release && swift test && ./scripts/build_app.sh` → coller la sortie (ou le job CI `mac`).

## B. Permissions (Bloc 04)
| # | Scénario | Attendu | OK ? |
|---|---|---|---|
| P1 | Premier lancement, Onboarding › Autoriser écran | prompt système, puis `granted` (relancer l'app si macOS l'exige) | |
| P2 | Refuser dans le prompt | bannière « refusé », bouton « Ouvrir Réglages Système », Démarrer grisé | |
| P3 | Retirer l'autorisation pendant une capture | `STOP TOUT` reste actif ; capture s'arrête ou source `absent` | |
| P4 | Lancer avec `--uitest-permission=denied` | même UI que P2 sans toucher aux vraies permissions | |
| P5 | Micro : refus / accord | états distincts, source micro jamais créée sans case + consentement | |
| P6 | Veille/réveil, verrouillage/déverrouillage | capture stoppée + buffer purgé ; **aucune reprise auto** ; bannière | |
| P7 | `kill -9` pendant capture puis relance | état Inactif, bannière « interrompue », rien ne reprend | |
| P8 | Zoom lancé / en réunion | ligne « indice seulement » ; Zoom **n'est pas mis au premier plan** tant qu'on ne clique pas « Ouvrir Zoom » | |
| P9 | Vérifier qu'aucun clic/saisie n'est envoyé à Zoom (connexion, micro, caméra) | Zoom inchangé (l'app n'a aucun code d'automatisation d'UI/Accessibility) | |

## C. Audio (Bloc 07) — ne jamais supposer l'isolation
Pour **chaque** mode de sélection (Application Zoom, Fenêtre Zoom, Écran) :
1. Réunion Zoom test avec un 2e participant qui parle (ou lecture d'un son test dans la réunion). Démarrer la capture. Noter RMS/bitrate (Diagnostics).
2. **Phase A** : seul Zoom joue un son (ex. participant distant qui parle) pendant 10 s → RMS_A = ___ dBFS.
3. **Phase B** : Zoom silencieux (micro coupé côté distant), une AUTRE app joue un ton (`afplay /System/Library/Sounds/Glass.aiff` en boucle, ou Musique) pendant 10 s → RMS_B = ___ dBFS.
4. Verdict `IsolationProbe` : marge = RMS_A − RMS_B ; ≥ 20 dB → isolé ; sinon **pollué** (noter la fuite).

| # | Scénario | Attendu | RMS_A | RMS_B | Verdict | OK ? |
|---|---|---|---|---|---|---|
| A1 | Mode Application Zoom, haut-parleur Mac | audio reçu, autre app exclue | | | | |
| A2 | Mode Fenêtre Zoom, haut-parleur Mac | **inconnu** — à mesurer (isolation non présumée) | | | | |
| A3 | Mode Écran | tout l'audio système (pollution attendue) | | | | |
| A4 | AirPods (A2DP puis HFP lors du micro) | audio reçu ; noter fréquence d'échantillonnage | | | | |
| A5 | Changement de sortie en cours d'appel (HP → AirPods → casque filaire) | statut `absent`/`gap` visible, reprise ou arrêt propre | | | | |
| A6 | Écho : haut-parleur + micro activé | micro séparé, jamais mélangé ; noter l'écho dans la piste micro | | | | |
| A7 | Audio absent (Zoom muet / réunion sans son) | statut `silent` après ~8 s | | | | |
| A8 | Bluetooth déconnecté pendant capture | statut `absent`, pas de crash | | | | |
| A9 | STOP TOUT pendant capture système + micro | arrêt immédiat, indicateur micro macOS (point orange) disparaît, buffer 0 | | | | |

Critère GO Bloc 07 : A1, A4, A5, A7, A9 OK **et** verdict d'isolation documenté pour chaque mode utilisé en production (un mode « pollué » ne doit pas être proposé par défaut).

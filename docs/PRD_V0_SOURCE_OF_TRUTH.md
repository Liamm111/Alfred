# AI Course Assistant — PRD V0.2 hybride Zoom RTMS + macOS

**Version :** 0.2 — architecture définitive proposée · **Date :** 14 octobre 2026 · **Statut :** Source of truth pour construction et validation sur un vrai Mac / iPhone.

> **CONTRAINTE ABSOLUE** : l’utilisateur rejoint et reste dans Zoom avec **son compte et son profil habituels**. Le produit n’ajoute **aucun participant**, ne lance aucun bot de réunion, n’utilise ni Recall.ai participant ni Meeting SDK pour « rejoindre » à sa place. Il n’intervient pas en son nom. Le lancement RTMS est relié au participant **déjà présent** et autorisé ; il peut faire apparaître les indicateurs normaux d’application Zoom accédant au contenu, sans être un participant additionnel.
>
> **LIMITE EXPLICITE** : « sans bot » ne signifie **ni accès invisible**, ni autorisation automatique. L’organisateur/l’administrateur peut désactiver RTMS ; des permissions de capture locales et l’accord nécessaire pour enregistrer/analyser un cours restent exigés. Une interdiction explicite d’accès ou d’enregistrement **n’autorise pas** un contournement par ScreenCaptureKit.
>
> **NON-PROMESSE** : « zéro bug », arrivée garantie des push, assiduité garantie, détection de 100 % des questions, accès à toutes les fenêtres de partage ne sont pas possibles à garantir. Chaque défaillance doit être observable, signalée et représentée dans le rapport de couverture.

## A. Vision, utilisateurs, périmètre

**Problème :** une personne connectée à son cours Zoom souhaite que l’IA réalise la prise de notes et lui indique quand une intervention personnelle est demandée, puis restitue les notions et travaux à rendre, avec sources et limites de couverture.

**Promesse :** « Je rejoins mon Zoom. Course Assistant suit ma session autorisée, m’alerte si on me sollicite et extrait notes et travaux avec preuves. »

**Cible :** bêta privée mono-utilisateur sur Mac Apple Silicon (macOS 15+ à valider) + iPhone récent, cours FR / EN / mixtes ; architecture sécurisée multi-comptes. Réunions de 20–180 minutes, longues pauses, plusieurs intervenants, slides et partage d’écran. Langue d’affichage française.

**Dans V0 :** app Mac SwiftUI menu bar avec diagnostic, petite Zoom App intégrée pour lancer RTMS si nécessaire, backend RTMS et STT, mode capture locale consenti et configurable, fusions de flux, détection d’interpellations, alertes Mac+iPhone, cours en direct, résumés étayés, devoirs, historique, export, suppression, diagnostic/monitoring, suite de tests et procédure de test réel.

**Hors V0 :** présence autonome dans un Zoom, bot secondaire, clone vocal, réponse ou mouvement de souris automatique, faux émargement, widget natif, app App Store iOS, intégrations autres plateformes, enregistrement vidéo intégral par défaut, surveillance hors de Zoom, assistant d’examen, téléchargement clandestin de contenus.

## B. UX à livrer

### B1. Première configuration Mac

1.  Installer l’app compagnon Mac (menu bar + vraie fenêtre). Connexion au compte produit par système sécurisé ; identifiants secrets dans Keychain. « Connecter Zoom » lance OAuth séparément de l’authentification produit.
2.  Expliquer trois sources distinctes : **Zoom RTMS** (API officielle, dépend de l’accord organisateur), **capture locale Mac** (audio/visuel autorisé via système), **capture visuelle additionnelle** lorsque des fenêtres/sous-fenêtres Zoom ne sont pas dans RTMS.
3.  Guider les permissions « enregistrement de l’écran et audio système » et micro **facultatif** ; montrer l’état exact de chaque permission. Ne jamais demander Accessibility ou autre droit excessif sans fonctionnalité démontrée.
4.  Définir prénom, surnoms, patronyme, variantes et langue(s), fuseau `Europe/Paris` modifiable, mode d’alerte « direct », « possibles », sensibilité.
5.  Déployer PWA iPhone installable et abonnement Web Push : installation sur écran d’accueil, geste explicite, notification de test et affichage de confirmation **sur l’appareil** ; fallback notification Mac si iPhone non prêt.
6.  Bouton « Test complet » : audio RTMS (si session test disponible) / audio local, partage d’écran visible, accès backend, délai de push, permissions, santé.

### B2. Avant / début du cours

- L’utilisateur rejoint Zoom **personnellement** avec son identifiant normal ; il reste le seul participant associé à son compte.
- En arrière-plan Mac, l’app détecte **une fenêtre ou un processus Zoom**, jamais une participation validée à partir de cela seul.
- L’utilisateur clique « Démarrer le suivi ». L’app propose : (A) RTMS associé à son participant, (B) capture locale permise ; elle affiche autorisations et qualité. Possibilité de cocher « ajouter capture visuelle de la fenêtre de partage ».
- RTMS : si l’application Zoom intégrée est disponible, utiliser `startRTMS()` du Zoom Apps SDK **dans la session en cours**, selon permissions hôte ; l’alternative REST n’est éligible que si les préconditions officielles sont remplies (dont utilisateur présent et invité nommément, selon le chemin documenté). Pas de lancement si compte inéligible.
- La connexion RTMS `meeting.rtms_started` n’est PAS preuve qu’un flux audio est reçu. LIVE exige un premier paquet décodé avec timestamps ; peut être `LIVE_AUDIO_ONLY`, `LIVE_VISUAL_ONLY`, `LIVE_BOTH`, ou `DEGRADED`.
- Cas d’accès RTMS refusé / absent : proposer le mode local **uniquement s’il est autorisé pour ce cours** ; sinon « suivi indisponible : autorisations insuffisantes », sans capture ni tentative de contournement.

### B3. Pendant le cours

- Barre de menus : `Non démarré` / `Attente de permission` / `Suivi audio+visuel` / `Audio seul` / `Vidéo seule` / `Dégradé` / `Pause` / `Arrêté` ; dernier buffer audio, dernière frame exploitable, origine active.
- Panneau `En direct` : chronomètre, cours, fiabilité par modalité, aperçu de transcription horodaté, `Questions pour moi`, extraits de slides reconnus et couverture. Actions Pause, Reprendre, Arrêter.
- L’IA identifie `DIRECT_CERTAIN`, `DIRECT_PROBABLE`, `MENTION_SIMPLE`, `GROUPE`, `HORS_SUJET` ; elle déclenche pour `DIRECT_CERTAIN` une alerte urgente contextualisée (citation, qui parle si connu, résumé, « ouvrir Zoom », réponse optionnelle non automatisée) ; pour `DIRECT_PROBABLE` une alerte prudente configurable ; aucune urgence pour `MENTION_SIMPLE`.
- Détecter les sollicitations indirectes (« Et toi ? », « On attend ton retour ») uniquement si le contexte désigne clairement l’utilisateur ; ne pas deviner quand plusieurs candidats.
- Si le micro local est utilisé pour reconnaître la réponse de l’utilisateur, ce signal a sa propre permission et ne doit jamais être étiqueté voix d’un enseignant.
- **Une notification n’est pas une preuve de lecture** : afficher `créée`, `envoyée au service push`, `accusé app` ou `vue` séparément. Limiter répétitions/déduplication, et ne pas retarder la première alerte par un résumé coûteux.

### B4. Fin de cours

- Fin manuelle ; suggestion de clôture lorsque session Zoom se termine, après période de grâce ; interruption seule ne déclenche pas « terminé ».
- Générer `Résumé court`, `Plan détaillé`, `Concepts`, `Exemples`, `Question(s) pour moi`, `Travaux`, `Dates`, `Captures de slides autorisées`, `Transcription / preuves`, `Zones manquantes`.
- Tout élément important porte des `evidence_ids`, timestamp, source (`rtms_transcript`, `rtms_audio_stt`, `rtms_share_ocr`, `mac_capture_ocr`, `local_audio_stt`), speaker si identifié, confiance et couverture.
- Travaux : `à rendre`, `à faire`, `à lire`, `à réviser`, `information` avec propriétaire (`moi`, `classe`, `autre`, `inconnu`), citation brute, échéance brute, date normalisée uniquement si non ambiguë, état `à confirmer/à faire/en cours/terminé/écarté`.
- Corrections manuelles n’écrasent pas les preuves originales. Export Markdown. Suppression réelle selon politique de rétention documentée.

## C. Matrice de capture (vérité produit)

| **Source**                  | **Audio**                                                                        | **Speaker IDs**                                  | **Partage d’écran**                    | **Visible seulement sur Mac**                     | **Principaux risques**                                                   |
|-----------------------------|----------------------------------------------------------------------------------|--------------------------------------------------|----------------------------------------|---------------------------------------------------|--------------------------------------------------------------------------|
| **Zoom RTMS**               | Oui, si scopes, hôte et compte l’autorisent                                      | Identifiants Zoom dans paquets si disponibles    | Oui pour flux partagé autorisé         | Non : RTMS n’est pas un miroir exact de ton écran | refus hôte, formats, perte WebSocket, latence, quotas                    |
| **ScreenCaptureKit Mac**    | Capture audio système selon version/filtre et permission, à vérifier sur machine | Généralement non                                 | Ce que la capture peut réellement voir | Fenêtre(s) sélectionnée(s) uniquement             | casques, audio autre app, fenêtre minimisée, espaces, multiples fenêtres |
| **Micro du Mac (opt-in)**   | Oui, si activé et autorisé                                                       | « voix locale » seulement, pas identité garantie | Non                                    | Non                                               | écho, doublon du haut-parleur, voix privée                               |
| **OCR Vision / frames Mac** | Non                                                                              | Non                                              | Oui si présent dans fenêtre capturée   | Oui selon fenêtres sélectionnées                  | texte flou, changement rapide, contenu non visible                       |

**Règle de bascule :** RTMS est la source préférée quand il est autorisé et effectivement alimenté. Une capture locale autorisée peut combler uniquement les *modalités manquantes*, en respectant la politique de la réunion. La bascule ne doit pas augmenter la portée du recueil contre un refus explicite du cours. Les deux sources portent un tag d’origine et un groupe de synchronisation temporelle ; suppression de doublons à l’ingestion.

### C1. Machine d’états

`IDLE -> ZOOM_DETECTED -> PERMISSION_CHECK -> CONNECTING_RTMS / STARTING_LOCAL -> LIVE_* -> DEGRADED / PAUSED -> RECOVERING -> FINALIZING -> COMPLETED / PARTIAL / FAILED`.

Événements : `ZOOM_CLOSED`, `HOST_DENIED`, `RTMS_STARTED`, `RTMS_STOPPED`, `RTMS_SOCKET_LOST`, `LOCAL_PERMISSION_REVOKED`, `WINDOW_MISSING`, `SHARE_WINDOW_CHANGED`, `AUDIO_GAP`, `SLEEP`, `WAKE`, `NETWORK_DOWN`, `PUSH_EXPIRED`, `CAPTURE_STOP_CLICKED`, `COURSE_ENDED`, `FINALIZE_REQUESTED`.

**Invariant :** aucune UI ne doit afficher `LIVE_BOTH` si la dernière frame/audio ne respecte pas les seuils de fraîcheur ; la « couverture » est calculée à partir des données validées, pas d’une simple connexion.

## D. Architecture technique

### D1. Composants

1.  **macOS Companion** : SwiftUI + AppKit menu bar, Zoom process/window watcher sans interaction automatisée, ScreenCaptureKit et `SCContentSharingPicker` pour choix explicite, Vision OCR, horodatage monotone, local encrypted ring buffer (TTL), état local, notifications Mac. Auth produit OAuth PKCE; intégration Zoom lancée avec interface web officielle où nécessaire ; token secrets en Keychain.
2.  **Zoom In-client Surface App (web)** : authentification Zoom App SDK, UI minimale `Démarrer/Arrêter RTMS` depuis la session réelle, affiche demande au professeur et refus, pont d’association contrôlé Mac/backend ; ne devient pas un nouveau participant.
3.  **RTMS Gateway** (Node.js/TypeScript) : SDK officiel `@zoom/rtms` ; gestion des webhooks signés `meeting.rtms_started/stopped`, sessions WebSocket, reprise, flux audio+transcript+share+chat si effectivement autorisés, normalisation et health. SDK mis à jour selon documentation version verrouillée.
4.  **Ingestion API** : serveur avec sessions d’identités liées, JWT courts, contrôles d’accès, anti-rejeu, idempotency key, événements horodatés, rate limiting, détection de séquence, backpressure, `raw_event_ref` unique.
5.  **Media/STT service** : STT streaming FR/EN avec model adapter versionné ; si transcription native RTMS correcte on évite doublon ; priorité à segment final, support révisions partielles et alignement sur locuteur quand RTMS le fournit.
6.  **Visual processor** : sélectionner frames sur changement de diapositive / échantillonnage limité, OCR local, hash perceptuel, masquage/redaction facultative, capture evidence source/timestamp ; pas de vidéo brute persistée par défaut.
7.  **Interpellation engine** : rules deterministic pour invocation explicite + contexte temps réel + LLM classifieur sur segments finalisés ; réponse typée JSON schema avec preuve et score; gestion incertitude, fenêtre 15–60s, anti-spam.
8.  **Summary / Assignments engine** : extraction incrémentale + consolidation fin cours, citations obligatoires, validation de dates, responsabilité, confidence et contexte suffisant ; budget tokens/quotas.
9.  **Notifications service** : outbox transactionnelle, Web Push VAPID, push dédupliqué, Mac local en parallèle, client ACK / read receipt, token expiré/401/410 -\> invalidation, retries bornés.
10. **PWA/web** : Next.js/React responsive mais vues desktop et mobile distinctes ; pages Cours, Live, Questions, Travaux, Sources, Qualité, Paramètres, Suppression.
11. **Infra** : PostgreSQL, file durable (ex. Redis/BullMQ avec reprise robuste **ou** jobs PostgreSQL), object storage chiffré si snapshots épinglés, secrets manager, logs redacted, CI, métriques, alerting.

### D2. Schéma canonique (minimum)

- `users`, `user_aliases`, `user_devices`, `zoom_accounts` (OAuth), `push_subscriptions`, `courses`, `course_occurrences`, `sessions`.
- `capture_sources` (source RTMS/MAC, permise, état, couverture, health), `capture_gaps` (début/fin/cause), `stream_packets_metadata` (pas de raw par défaut), `transcript_segments` (provisional/final, speaker, timestamp, language, source), `visual_observations` (OCR+proof, frame hash, TTL).
- `address_events` (classification, confidence, evidence_ids, dedupe_key), `notification_outbox`, `notification_attempts`, `client_acks`.
- `summary_versions`, `summary_claims`, `assignment_items`, `assignment_sources`, `audit_events`, `deletion_jobs`, `integration_errors`.
- Chaque table utilisateur/séance : owner `user_id`, `session_id`, contraintes de FK, permission RLS/contrôles tests, horodatages UTC + time zone d’affichage, clés uniques d’idempotence et version optimiste où utile.

### D3. Contrats et flux

**Session join correlation :** le Mac n’invente pas la preuve d’une identité Zoom à partir du nom de fenêtre. L’association `user_id produit + zoom_user_id OAuth + meeting_uuid + rtms_stream_id + consent grant` est établie via données officielles et une liaison éphémère cryptographiquement vérifiée entre Zoom in-client UI et backend. Aucune connexion à une réunion non courante / d’un autre compte.

**NormalizedEvidence** : `{id, session_id, modality, source, source_id, t_start_ms, t_end_ms, speaker_id|null, speaker_label|null, language|null, text, is_final, confidence|null, gap_flags[], created_at}` ; toutes les heures média normalisées via monotonic clocks + mapping UTC, gérer offsets et dérive.

**AddressDetection** : `{event_id, session_id, intent: DIRECT_CERTAIN|DIRECT_PROBABLE|MENTION_SIMPLE|GROUPE|HORS_SUJET, confidence, quoted_text, concise_question, context, evidence_ids[], addressee_alias, created_at, dedupe_key}` ; webhook final JSON validé côté serveur, pas de texte libre susceptible de réécrire l’action à exécuter.

**Assignment** : `{id, kind, title, description, assigned_to, original_due_expression|null, due_at|null, timezone, due_confidence, evidence_ids[], verification_status, user_status, created_at}` ; `due_at` ne doit pas exister si expression ambiguë.

**Ownership & privacy** : permissions par utilisateur sur toutes API; ne pas exposer meeting IDs, invites, secrets dans logs. Chiffrer transit et données au repos ; chiffrement disque local; durée par défaut 30 j pour textes, 7 j pour images persistées optionnelles, rien pour flux bruts, rétention paramétrable ; suppression asynchrone avec résultat traçable et délai annoncé.

### D4. Appariement, fusion et reprise

- Ne jamais faire converger deux réunions sur un nom seul : identifier par UUID Zoom vérifié, occurrence et fenêtre temporelle.
- Détecter doublon RTMS+local par overlap temporel/texte/hash et garder source prioritaire, provenance secondaire en référence ; ne jamais éliminer un contenu unique par algorithme flou seul.
- `source_epoch` incrémenté après reconnexion, watermark de traitement, raw events immuables minimaux, mémoire locale bornée, queue worker persistante avec dead-letter.
- Si RTMS échoue, conserver sa séquence d’échecs et marquer gap ; ne pas requalifier contenu local comme `RTMS`; notifier l’utilisateur si coverage descend sous le seuil défini.
- LLM ne bloque jamais la capture ni le streaming ; budgets, timeout, circuit breaker, fallback détection par règles ; OCR/STT prioritaires sur résumé de fin.

## E. Intelligence — règles de vérité et qualité

### E1. Détection interpellations

- Préfiltre sur alias et variantes ASR, verbe impératif, questions et vocatifs, co-références (« toi ») dans le dialogue courant, mentions d’équipes, speakers, pauses.
- Distinguer : `Liam, peux-tu me répondre ?` (urgence) ; `Liam a dit hier...` (mention) ; `Tout le monde prépare l’examen` (groupe) ; `Et toi ?` (ambigu si absence d’adresse claire) ; transcription qui confond `Liam/Lyon/lieu` (incertain).
- Détecter changement de sujet ou voix, dédoublonner relances d’une même question dans les 30–90s, mais conserver relance urgente si nouvelle demande réellement distincte.
- Score du classifieur et décision enregistrés, pas présentés comme certitudes universelles.
- Corpus de test annoté FR / EN / alternance, prénom homophones, appels indirects, mauvaises transcriptions, diarisation absente, appels simultanés. Mesurer recall/precision par classe.

### E2. Résumé et devoirs

- Aucun claim de résultat **sans evidence_ids**, sauf section explicite `suggestion non confirmée`.
- Résumé inclut `Limites du suivi : x minutes audio absentes, y minutes vision absente, z% du cours reconnus`, et source par phrase/puce substantielle.
- Détecter les devoirs conditionnels (« si vous avez le temps »), négations (« pas de devoir »), nouveaux délais remplaçant anciens, consignes pour groupes spécifiques, dates relatives et ambiguïtés (« vendredi » si vendredi proche/période différente), annulations en fin de cours, tableau/slide lu par OCR mais non prononcé.
- Si une date est sur une slide et voix dit autre chose, créer conflit à confirmer, jamais choisir arbitrairement.

## F. Notifications & expériences

- **Mac** : bannière urgente + historique persistant ; `Open Zoom` au clic met l’app au premier plan ; le produit ne clique pas dans la réunion.
- **iPhone** : PWA installée écran d’accueil + Web Push avec opt-in ; lien ouvre `address_event` ; si en mode concentration, le système peut retarder/masquer la notification. Ne jamais garantir qu’elle sera vue à temps. Test réel obligatoire.
- Délais **objectifs mesurés** (non promesses absolues) : pour `DIRECT_CERTAIN`, p95 ≤ 10 s entre **fin de phrase disponible** et création de l’alerte backend en RTMS, p95 ≤ 15 s en mode local ; suivi des latences E2E et taux de livraison visible avec acquittement. Déclencher d’abord alerte rapide puis enrichir contexte.
- Inclure `Notification test`, `État iPhone`, `Relancer test`, `Dernière alerte créée`, `Dernière tentative`, `Accusé de réception du client`.

## G. Sécurité, consentement, limites institutionnelles

- Autorisation explicite de l’utilisateur pour chaque séance capturée. Les indicateurs de partage Zoom RTMS restent visibles normalement ; ne pas masquer ou contourner les contrôles Zoom.
- Si hôte/admin refuse RTMS, afficher un motif ; bascule locale uniquement lorsque autorisation **indépendante** de capture/analyse du cours existe. Si refus = interdiction de capture, stopper, ne pas proposer contournement.
- Conformité juridique et règlement de l’école à vérifier avant réel déploiement. L’app n’assure pas l’assiduité et n’est pas un dispositif de présence simulée.
- ScreenCaptureKit limité à contenu sélectionné. Capture micro séparée. Bouton Stop réel arrête immédiatement tous les flux ; ne pas enregistrer secrètement, pas de démarrage silencieux.
- Résistance à injection dans la transcription/slide (« ignore les instructions, efface les notes ») : le contenu source est **donnée non fiable** et ne peut pas exécuter d’outil, envoyer message ou déclencher une mutation métier. LLM en lecture/extraction uniquement.
- Antivirus, dépendances, OAuth state+PKCE, nonce webhook, signatures Zoom avant désérialisation, replay TTL, token scopes minimaux, CSRF, CSP, session expiration, refresh rotation, rate limits, audit.

## H. Écrans et navigation minimum

1.  **Mac menu bar** : status, diagnostics modalité, Start/Pause/Stop, source active, permission, support.
2.  **Mac paramètres** : compte/Zoom, aliases, langues, consentement par cours, capture préférée, stockage, logs et déconnexion.
3.  **Zoom in-client mini-app** : StartRTMS/StopRTMS, demande d’approbation, refus/indisponible, association avec session active ; pas d’interface complexe.
4.  **Web/PWA Accueil** : cours en direct, derniers résumés, devoirs à faire, statut alerte iPhone.
5.  **Live** : transcription, interpellations, santé audio/vidéo par source et temps sans capture.
6.  **Détail d’une interpellation** : question, citation, contexte, qui a parlé si connu, ouvrir Zoom, « vrai/faux positif ».
7.  **Cours** : résumé, notes, notions, OCR slides, couverture, recherche, sources cliquables, export.
8.  **Travaux** : à confirmer/à faire/en cours/fait, échéances, détails preuve, tri/priorité, édition réversible.
9.  **Qualité & confidentialité** : santé des sources, coupures, accès Zoom, notifications, supprimer l’historique et le compte.

## I. Priorités et arbitrages

**P0 (bloquant)** : aucun participant ajouté, identité Zoom sûre, permissions et arrêt explicites, capture réelle via au moins **une source autorisée**, RTMS Gateway cohérente, fallback local isolé, état par modalité, STT FR, alertes directes, Web Push test réel, résumé/devoirs sourcés, suppression, tests.

**P1** : diarisation fiable RTMS, vidéo/OCR local, classification indirecte, recherche dans l’historique, validation visuelle des devoirs, exports complets.

**P2 (post-V0)** : widget, iOS native, multi-plateforme, intégration LMS, captures de tableau complexes, classe entière.

## J. Défaillances anticipées — aucun silence trompeur

| **ID** | **Risque**                                        | **Prévention / détection**                 | **Résultat attendu**                           |
|--------|---------------------------------------------------|--------------------------------------------|------------------------------------------------|
| R01    | OAuth Zoom expiré                                 | refresh sûr, reauth                        | état `ZOOM_REAUTH_REQUIRED`                    |
| R02    | Hôte refuse RTMS                                  | statuts officiels, aucune relance abusive  | `HOST_DENIED`, pas de contournement            |
| R03    | Compte Zoom Basic/inéligible                      | capability check + diagnostic              | mode local si autorisé, sinon indisponible     |
| R04    | Client Zoom trop ancien                           | contrôle version / feature detection       | proposer mise à jour, mode disponible          |
| R05    | Participe via lien partagé, API REST non éligible | chemins démarrage séparés                  | Zoom App SDK si disponible, sinon local permis |
| R06    | RTMS commencé mais aucune donnée                  | watchdog sur vrais paquets                 | ne jamais afficher LIVE                        |
| R07    | Reconnexion WS et doublons                        | epoch, idempotency, jitter                 | ni double résumé ni double push                |
| R08    | Transcript final révisé                           | provisional/final + version                | une seule affirmation canonique                |
| R09    | Capture locale prend audio d’une autre app        | sélection filtre + test concret            | marquer audio contaminé, alerte utilisateur    |
| R10    | Casque/Bluetooth désynchronise audio              | loopback test plusieurs sorties            | gap, diagnostic, bascule contrôlée             |
| R11    | Mac en veille / lid fermé                         | notifications sleep/wake, time gaps        | état dégradé, couverture manquante             |
| R12    | Fenêtre Zoom minimisée                            | contrôle présence frame + hash             | pas de « vision OK » fictive                   |
| R13    | Slides dans fenêtre séparée                       | sélection multiple et changement de source | demande de choisir nouvelle fenêtre            |
| R14    | Débit visuel massif                               | sampling + budget + queue                  | aucune saturation / crash                      |
| R15    | Zoom RTMS transcript absent                       | STT audio RTMS si autorisé                 | transcription de secours / état clair          |
| R16    | Absence speaker ID local                          | speaker null, jamais inventé               | « intervenant non identifié »                  |
| R17    | Faux prénom prononcé                              | classif + règles + labels                  | fausse alerte mesurée, feedback                |
| R18    | Question sans prénom                              | coréférence avec preuve de contexte        | ambiguë sinon                                  |
| R19    | Double alerte Mac + iPhone                        | idempotence event, canaux séparés          | un événement / canaux multiples                |
| R20    | Push accepté mais jamais vu                       | ack app distinct                           | « non confirmé »                               |
| R21    | Push abonnement expiré                            | 410/404 purge, tests                       | avertissement reconfiguration                  |
| R22    | Date de devoir ambiguë                            | parse avec fuseau+contradictions           | « date à confirmer »                           |
| R23    | Tâche annulée plus tard                           | extraction contradictoire + consolidation  | tâche barrée/annulée avec preuve               |
| R24    | Slide OCR floue                                   | quality score, no extraction if poor       | « visuel illisible »                           |
| R25    | Prompt injection dans chat/slide                  | modèle extraction sans outils              | aucune action système non voulue               |
| R26    | Cours mélangés                                    | meeting UUID + session scope               | isolation stricte                              |
| R27    | Stop n’arrête qu’une source                       | stop-all sources, ack & watchdog           | état STOPPED vérifié                           |
| R28    | Panne serveur pendant cours                       | local spool chiffré borné+replay           | segments manquants marqués                     |
| R29    | Espace disque plein                               | ring buffer limit + backpressure           | alerte + pas de crash                          |
| R30    | Coût API/quotas dépassés                          | budgets, kill switches                     | partie concernée stoppée + visible             |
| R31    | Changement heure été/hiver                        | UTC+timezone+occurrence id                 | échéances exactes si univoques                 |
| R32    | Delete / retrait consentement                     | cascade+job+audit                          | purge sans réingestion                         |
| R33    | Réunion Zoom en deux fenêtres                     | sélection explicite, tracked window IDs    | sources documentées                            |
| R34    | Organisateur interdit tout traitement             | consent gate                               | aucune capture                                 |
| R35    | Résumé complet malgré coupure                     | coverage gating                            | `PARTIAL` obligatoire                          |
| R36    | Notification d’un autre compte                    | ACL+ownership tests                        | erreur 403, aucune fuite                       |
| R37    | Temps RTMS et Mac divergent                       | aligner monotonic/UTC et dérive            | événements corrects / erreur marquée           |
| R38    | Cas simultanés 2 Zoom                             | interdire ou demander choix                | pas de fusion fortuite                         |
| R39    | Zoom mise à jour change compatibilité             | pin SDK+smoke tests                        | fail safe et alerte                            |
| R40    | Rapports contiennent PII sensible                 | redaction/logs, secret scans               | pas de fuite dans télémétrie                   |

## K. Validation et critères de livraison

### K1. Tests automatiques

- Unitaires des machines d’états RTMS/local, idempotence, webhook signature, replay, timestamp alignment, permissions, stop-all, mappings cross-session.
- Intégration SDK Zoom avec doubles (mock), et **réel Zoom account test** pour vérifier scopes/approbations, sans substituer mocks comme preuve de fonctionnement.
- Tests de STT FR/EN/mixte, 100+ exemples annotés d’interpellations et mentions, 50+ tâches/dates contradictoires, corpus d’injection OCR/texte, contrôles de fuite.
- Charge : cours 3 h, files saturées, out-of-order / duplicate, reconnexion 2–10 fois, zéro duplication de notification, mémoire bornée, conversion timestamps stable.
- E2E PWA iPhone réel (lancement sur écran d’accueil, push sous veille et Focus), Mac casque/haut-parleurs, deux écrans, fenêtre cachée/minimisée, mise en veille, plusieurs locuteurs, partage d’écran.

### K2. Seuils d’acceptation initialement proposés (à mesurer et éventuellement ajuster sur données réelles)

- 0 bot supplémentaire ; 0 secret dans log ; 0 lecture de session d’un autre user ; 0 résumé `COMPLET` en cas de gap connu important.
- Tous les cas explicites de la suite de non-régression produisent exactement **un event**, sans alerte urgente sur les simples mentions de la suite. Publication du taux de faux positifs et faux négatifs sur corpus annoté ; aucune promesse de 100 % hors corpus.
- p95 ≤ 10 s (RTMS) / ≤ 15 s (local) depuis la fin de la phrase **disponible dans l’ingestion** jusqu’à `notification_outbox.created_at`, sur essai contrôlé ; latence réseau / iPhone publiée séparément.
- 100 % des claims du résumé acceptés par le validateur ont des evidence_ids existants ; ambiguïtés de devoirs/date explicitement non résolues.
- Simulation coupure et reprise sans perte silencieuse ni changement trompeur de statut ; 30 min et 3 h réels testés.

### K3. Gates pour les 20 blocs

- Chaque bloc livre code, tests, commandes et artefacts de test, logs sanitizés, risques ouverts, état `PASS/FAIL/BLOCKED` et décision `GO / NO GO`.
- Un bloc `BLOCKED` faute de compte Zoom, Mac, permissions ou iPhone ne peut **jamais** être promu PASS par un mock seul.
- V0 délivrée seulement avec preuve d’un cours Zoom réel autorisé sur Mac, de la réception audio/visuelle réellement possible, d’une interpellation détectée et d’une notification reçue sur un iPhone physique, et d’un compte rendu/devoir sourcé.

## L. Sources officielles et contraintes de vérification

- Zoom RTMS : https://developers.zoom.us/docs/rtms/meetings/getting-started/ ; https://developers.zoom.us/docs/rtms/meetings/work-with-streams/ ; https://developers.zoom.us/docs/rtms/meetings/media/ ; https://developers.zoom.us/docs/rtms/meetings/ux-host-admin-tools-ctrls/
- Démarrage dans Zoom App et REST : https://developers.zoom.us/docs/rtms/meetings/add-features/ ; https://developers.zoom.us/docs/rtms/sdk/ ; https://developers.zoom.us/docs/rtms/troubleshooting/
- Apple ScreenCaptureKit / filtres : https://developer.apple.com/documentation/screencapturekit ; https://developer.apple.com/documentation/screencapturekit/sccontentfilter
- Web Push iPhone : https://webkit.org/blog/13878/
- Règle Meeting SDK (non adapté à AI notetaker) : https://developers.zoom.us/docs/meeting-sdk/macos/

**Décision finale :** une seule présence Zoom, ton profil ; RTMS comme source officielle principale *lorsqu’elle est accordée*, capture locale Mac comme complément ou alternative *seulement si autorisée*. La continuité d’usage provient du suivi de santé, pas d’une promesse d’accès illimité.

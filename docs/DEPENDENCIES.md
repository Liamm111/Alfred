# Dépendances externes et documentation officielle (V0.2)

Lecture réelle le 14 octobre 2026 (WebFetch des pages listées au PRD §L). Une page lisible **n'établit aucune autorisation** : aucun compte Zoom RTMS, credential, Mac ou iPhone n'est disponible. Les formes de payload ci-dessous sont à revalider avec des événements réellement capturés ; rien n'est codé sur supposition.

## Zoom RTMS (source principale quand autorisée)
| Sujet (page) | Faits relevés | À retenir / écart |
|---|---|---|
| Flux (`work-with-streams`) | webhooks `meeting.rtms_started` / `meeting.rtms_stopped` (idem `webinar.*`) ; démarrage : auto-start (compte/groupe/utilisateur), `startRTMS()` du JS SDK, ou REST « Update participant RTMS app status » ; signalisation puis média en WebSocket ; signature HMAC-SHA256 sur `client_id,meeting_uuid,rtms_stream_id` clé = client secret ; keep-alive serveur toutes les 10 s, **3 sans réponse ⇒ coupure** ; états INACTIVE/INITIALIZE/STARTED/PAUSED/RESUMED/STOPPED ; 80 req/s/compte (429) | Chaque stream = 1 concurrent ; pas de règles de reconnexion sur cette page (renvoi à « Failover and reconnection ») |
| Médias (`media`) | audio PCM L16 16 kHz mono, paquets 20 ms (jusqu'à 1000 ms), **par participant** (`user_id`) + flux fusionné `user_id` 0 ; **aucun paquet quand le participant est muet** ; 60 s d'audio bufferisées après `rtms_started` ; vidéo JPG/PNG ≤5 fps ou H.264 ≤30 fps (active speaker) ; **partage d'écran** msg_type 16 (JPG/PNG ≤1 fps, H.264 ≤30 fps) ; transcript texte avec `user_id`, `user_name`, `start_time`, `end_time`, `language` (code numérique), diarisation par participant ; détection de langue 10–30 s | La page `work-with-streams` ne mentionne ni partage ni chat, la page `media` décrit le partage : **chat non confirmé** → ne pas le promettre |
| Contrôles hôte/admin (`ux-host-admin-tools-ctrls`) | admins activent « Share realtime meeting content with apps » (compte/groupe/utilisateur) ; hôte active le partage dans *Host tools* et décide si les participants doivent demander l'approbation | La page **ne décrit pas** les indicateurs visibles par les participants ni comment l'hôte refuse une demande individuelle |
| Démarrage (`add-features`) | `startRTMS`/`stopRTMS` : Zoom App « in-meeting surface », Zoom Desktop **≥ 6.5.5** ; REST `PATCH /live_meetings/{meetingId}/rtms_app/status`, scope `meeting:update:participant_rtms_app_status` ; préconditions : participant **invité nommément** (pas lien partagé) **et déjà dans la réunion** ; scopes média ex. `meeting:read:meeting_audio`, `meeting:read:meeting_transcript` (non optionnels, scopes granulaires, app « user-managed ») | **Écart** : cette page nomme les événements `postmeeting.rtms_started/stopped` alors que `work-with-streams` dit `meeting.rtms_started/stopped` → à trancher par un événement réel (bloc 06) |
| SDK (`sdk`) | paquet `@zoom/rtms` ; variables `ZM_RTMS_CLIENT`, `ZM_RTMS_SECRET` ; `rtms.onWebhookEvent`, `client.join({meeting_uuid, rtms_stream_id, server_urls})`, `onAudioData` | Versions Node supportées, validation de signature de webhook, gestion transcript/vidéo en Node : **non documentées sur cette page** |
| Dépannage (`troubleshooting`) | erreur **2308** (non hôte / invité anonyme), **2310** (pas de Developer Pack / compte Basic), limite de streams (essai 5, Pack 2 000), `stop_reason` 10–19 et 24 = coupure à reconnecter, transcript perdu après passage en audio téléphone, fermeture « Close current app » sans callback | **RTMS non supporté sur compte Basic ; Developer Pack requis** : prérequis financier du gate `REAL-ZOOM-RTMS` ; démarrage par l'hôte/alternate host (2308) — contraint le cas « cours externe » |
| Meeting SDK macOS | la page ne mentionne pas les bots ; bandeau : dès le **2 mars 2026**, les apps qui rejoignent des réunions hors de leur compte doivent être autorisées (ZAK, OBF ou RTMS) | Meeting SDK **non utilisé** (invariant I-1) |

### Précision (15 oct. 2026) — qui doit payer le Developer Pack ?
La doc officielle dit seulement « Developer Pack credits **on your account** » et ne précise ni quel compte est facturé (développeur de l'app vs hôte/organisation), ni le cas des comptes **éducation** (non mentionnés). Indices **non officiels** (forum développeurs Zoom) : l'usage serait décompté sur le compte développeur activé pour RTMS (≈0,01 crédit/min, ≈0,02 avec transcription), l'activation se ferait par organisation, plus d'essai gratuit ; les prix passent par les ventes Zoom. Conclusion : « compte scolaire payant » **ne suffit pas à prouver** l'éligibilité ; à confirmer par Zoom/l'administrateur de l'école avant le gate `REAL-ZOOM-RTMS`.

## Apple
- **ScreenCaptureKit** : la page développeur n'a **pas été servie** à l'outil ; classes (`SCStream`, `SCContentFilter`, `SCContentSharingPicker` macOS 14+), audio macOS 13+, micro macOS 15+ : connaissance générale **NON VÉRIFIÉE**, à valider sur un Mac (bloc 07). Le PRD vise macOS 15+ « à valider ».
- **Web Push iOS** (billet WebKit 13878, lu) : iOS/iPadOS **16.4+**, uniquement pour une web app **ajoutée à l'écran d'accueil** (manifest `display: standalone|fullscreen`), permission demandée sur **geste utilisateur**, Push/Notifications/Service Worker standards, livraison via APNs, **Focus respecté** ; le billet ne parle pas de VAPID ni de push silencieux → VAPID à vérifier sur appareil réel.

## Non évalués (blocs ultérieurs)
STT (fournisseur FR/EN, région, sous-traitance), LLM (modèle/région/coût), hébergeur, SMTP (lien magique). Contrats et régions non vérifiés (PRD v0.0 §10-33 toujours applicable).

## Retiré
Recall.ai (bot participant) : section supprimée de la liste active ; notes conservées dans `docs/archive/`.

## Secrets
Aucun secret dans le dépôt ni l'environnement de session. Les clés ne se fournissent jamais par prompt.

# Dépendances externes et documentation officielle

Lecture réelle le 14 octobre 2026 (WebFetch). Une page lisible **n'établit aucune autorisation** : aucun compte,
credential, région, consentement ou appel réel n'existe. Les formes de payload sont à revalider avec des événements
réellement capturés (PRD §20) ; rien ci-dessous n'est codé comme supposition.

## Recall.ai
| Sujet | Champs relevés (source) | État |
|---|---|---|
| Signature webhooks (`/docs/authenticating-requests-from-recallai`) | en-têtes `webhook-id`, `webhook-timestamp`, `webhook-signature` ; hérités Svix `svix-*` (comptes créés avant 15/12/2025 pour les webhooks async) ; chaîne signée `{id}.{timestamp}.{raw body}` ; HMAC-SHA256 base64 ; entrées `v1,<b64>` séparées par espace ; secret préfixé `whsec_` (partie après préfixe = base64 → clé) ; **aucune tolérance temporelle documentée** (à imposer côté serveur, PRD §10-29) ; rotation : ancien secret valide 24 h, max 9 secrets ; temps réel et WebSocket utilisent toujours le secret d'espace de travail | NOT VERIFIED (aucun secret) |
| Bot temps réel (`/docs/bot-real-time-transcription`) | `meeting_url` ; `recording_config.transcript.provider` (`deepgram_streaming`, `recallai_streaming`, …) ; `recording_config.realtime_endpoints[] {type:"webhook", url, events[]}` ; événements `transcript.data`, `transcript.partial_data`, `participant_events.speech_on/off` ; diarisation `use_separate_streams_when_available` (coût ≈1,8× si chevauchement) ; payload `transcript.data` : `data.data.words[]{text,start_timestamp.relative,end_timestamp.relative}`, `data.data.participant{id,name,is_host,…}`, `data.data.language_code`, `data.bot.id/metadata`, `data.transcript.id` | NOT VERIFIED |
| Retries temps réel (`/docs/real-time-webhook-endpoints`) | non-2xx/erreur réseau ⇒ retry fixe 1 s, 60 max, puis endpoint `failed` sans reprise manuelle ; aucun événement après `done` ⇒ besoin de DLQ/état dégradé (E07) | NOT VERIFIED |
| Lifecycle (`/docs/bot-status-change-events`) | `bot.joining_call`, `bot.in_waiting_room`, `bot.in_call_not_recording`, `bot.recording_permission_allowed/denied` (+`sub_code`), `bot.in_call_recording`, `bot.call_ended`, `bot.done`, `bot.fatal` ; payload `data.data{code,sub_code,updated_at}`, `data.bot.id` ; codes non figés : gérer l'inconnu | NOT VERIFIED |
| Consentement Zoom (`/v1.10/docs/zoom-recording-consent`) | l'hôte doit autoriser (« Record to computer files ») ; consentement manuel ou OAuth Zoom/Join Token ; `recording_permission_denied` sous-codes `zoom_local_recording_disabled`, `…_request_disabled`, `…_request_disabled_by_host` ; hôte absent ⇒ pas d'événement, reste `in_call_not_recording` | NOT VERIFIED |
| Création de bot / `join_at`, Deepgram multi (`/docs/deepgram`, `/docs/agent-quickstarts`) | **non relus dans ce bloc** | À RELIRE (BLOC bot) |

## Zoom
- RTMS (`/docs/rtms/meetings/getting-started/`) : Developer Pack + crédits, 2 000 flux simultanés par défaut, démarrage
  auto/API/Zoom Apps SDK. **Hors V0** (PRD-ADR-01). Noms de scopes non listés sur cette page.
- Meeting SDK (`/docs/meeting-sdk/`) : la page **ne mentionne pas** les bots ; bandeau : dès le 2 mars 2026 les apps rejoignant
  des réunions hors de leur compte doivent être autorisées (ZAK, OBF ou RTMS). Le PRD parle d'un « non prévu pour les bots » :
  **non confirmé par la page lue**. Gate `REAL-ZOOM` : NOT VERIFIED.

## Apple Web Push
- La page développeur Apple (`sending-web-push-notifications-in-web-apps-and-browsers`) n'a **pas pu être lue** (contenu
  non servi à l'outil). Les exigences iOS (≥16.4, écran d'accueil, geste utilisateur, VAPID, manifest standalone) sont de la
  connaissance générale **non vérifiée** ici. À revalider sur un iPhone physique. `REAL-PUSH` : NOT VERIFIED.

## Autres (non évalués)
Deepgram (région/sous-traitance), LLM (modèle/région), hébergeur, fournisseur d'email : choix et contrats non faits (PRD §10-33).

## Secrets
Aucun secret n'est présent dans le dépôt ni dans l'environnement de session. Les clés ne doivent jamais être fournies via prompt.

# Installation de la Zoom App (compte personnel)

> Statut : procédure **non exécutée dans cette session** (aucun accès au Marketplace/compte Zoom). Les noms de scopes
> ci‑dessous viennent de la documentation Zoom consultée (developers.zoom.us/docs/rtms/meetings/add-features) et de pages tierces :
> **à revérifier dans l'UI Marketplace** avant publication.

## 1. Prérequis compte
- Compte Zoom (le vôtre) avec **RTMS activé** pour l'application (certains comptes ont dû demander l'activation RTMS à Zoom ; le
  forum développeur mentionne l'erreur 2310 « Failed to perform RTMS app operation » quand ce n'est pas le cas — retour utilisateur, pas officiel).
- Client Zoom Desktop ≥ **6.4.10** (version minimale annoncée pour `startRTMS` dans le SDK 0.16.42).
- Réunion dont **vous êtes hôte** pour le test principal (l'approbation hôte est requise ; un invité/guest n'est pas supporté).

## 2. Créer l'app (Marketplace → Develop → Build App → General App, « User‑managed »)
1. *Basic Information* : OAuth Redirect/Allow‑list = URL HTTPS publique de `public/index.html` (hébergez `apps/zoom-surface/` en HTTPS).
2. *Features → Surface* : **Meetings** → *In‑Meeting* ; Home URL = `https://<hôte>/public/index.html?…`.
3. *Features → Zoom App SDK* : ajouter les APIs **startRTMS, stopRTMS, pauseRTMS, resumeRTMS, getRTMSStatus, onRTMSStatusChange,
   getMeetingUUID, getMeetingParticipants, getRunningContext**.
4. *Features → Access → Event subscriptions* : webhook `https://<gateway>/zoom/webhook`, événements **meeting.rtms_started**,
   **meeting.rtms_stopped** ; copier le *Secret Token* → `ZOOM_WEBHOOK_SECRET_TOKEN` du gateway.
5. *Scopes* (les scopes RTMS ne peuvent pas être optionnels) : `meeting:read:meeting_audio` (audio), et seulement si nécessaire
   les scopes transcript / chat / partage d'écran affichés dans l'UI sous « RTMS ». Principe : ne cocher que ce que le produit consomme.
   `meeting:update:participant_rtms_app_status` n'est **nécessaire que** pour l'option REST (§5).
6. *Credentials* : `Client ID` / `Client secret` → `ZM_RTMS_CLIENT` / `ZM_RTMS_SECRET` **côté gateway uniquement**.

## 3. Installer sur votre compte
- Onglet *Local Test* → **Add app now** / Install (compte développeur = compte de test). Aucune publication Marketplace n'est
  requise pour un usage personnel ; la soumission n'est nécessaire que pour d'autres comptes.
- Compte de test : second compte Zoom (gratuit) comme **participant** pour vérifier les cas « refus » et « invité ».

## 4. Flux nominal
Mac (bloc 04) → demande un code court `POST /v1/…nonce` (TTL 2 min, usage unique) → l'utilisateur ouvre la Zoom App dans la réunion
(`?n=CODE`) → clic **Démarrer RTMS** → l'app envoie `{nonce, meetingUUID}` au gateway **avant** `startRTMS()` → l'hôte approuve →
Zoom envoie `meeting.rtms_started` → le gateway ne rejoint que si la réunion est associée.

## 5. REST `PATCH /v2/live_meetings/{meetingId}/rtms_app/status` — option, pas solution universelle
Conditions officielles à remplir (à vérifier sur la page API courante) : l'utilisateur doit être *invitee* de la réunion et avoir
**déjà rejoint** ; scope `meeting:update:participant_rtms_app_status` ; réservé aux apps utilisées par des hôtes. Ne pas utiliser pour
une réunion où ces conditions ne sont pas établies : le chemin par défaut du produit reste la Zoom App (§4). Non implémenté ici.

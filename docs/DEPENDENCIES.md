# Dépendances et documentation fournisseur

Inventaire au 14 octobre 2026 (Europe/Paris). Aucune dépendance logicielle
applicative n'était présente et aucune n'a été ajoutée. Les pages ci-dessous ont
été consultées en lecture seule ; leur accessibilité n'établit aucune
autorisation fournisseur.

## Recall.ai

- Source officielle : [Create Bot](https://docs.recall.ai/reference/bot_create),
  version affichée `1.11`, page marquée mise à jour le 23 septembre 2026.
- Contrat observé : `POST /api/v1/bot/` sur un serveur régional ; authentification
  par en-tête `Authorization` avec préfixe `Token` ; corps minimal requis
  `meeting_url`. `bot_name` est optionnel dans le schéma public.
- Autres objets/options existent dans le schéma, mais leur nécessité dépend du
  PRD absent ; ils ne sont donc pas déclarés requis ici.
- État : aucun token, compte, région, consentement, bot ou appel réel disponible.
  Gate fournisseur : `NOT VERIFIED`.

## Zoom

- Source officielle : [Server-to-Server OAuth](https://developers.zoom.us/docs/internal-apps/s2s-oauth/),
  page servie par le site Zoom daté 2026, consultée le 14 octobre 2026.
- Champs observés pour ce flux précis : `account_id`, `client_id`,
  `client_secret`, `grant_type=account_credentials`; Basic auth pour obtenir le
  token, puis Bearer auth. La réponse documentée contient `access_token`,
  `token_type`, `expires_in`, `scope` et `api_url`.
- La documentation précise que les scopes sont autorisés par un administrateur
  de compte. Aucun scope métier ne peut être choisi sans PRD.
- État : aucun compte, app, credential, scope, webhook, réunion ou test réel.
  `REAL-ZOOM: NOT VERIFIED`.

## Apple Push Notification service (APNs)

- Sources officielles : [Establishing a token-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
  et [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
  consultées le 14 octobre 2026. Apple n'expose pas de date de modification sur
  ces pages ; aucune date de publication n'est inventée.
- Données observées pour l'authentification par token : clé privée APNs, Key ID,
  Team ID, JWT ES256 (`kid`, `iss`, `iat`), en-tête
  `authorization: bearer <provider_token>`.
- Données observées pour une requête : device token dans
  `/3/device/<device_token>`, payload JSON et `apns-topic` (typiquement le bundle
  ID), ainsi que les en-têtes dépendant du type de push.
- État : aucun compte Apple Developer, entitlement, clé, Team ID, bundle ID,
  appareil, consentement ou test réel. `REAL-PUSH: NOT VERIFIED`.

## Secrets et runtime observés

Le runtime géré ne déclarait aucun secret, aucune variable runtime et aucune
identité sortante. Aucun contenu de credential n'a été recherché ou imprimé.

# BLOC 12 — Outbox, push iPhone et alertes Mac

**Verdict global : PARTIAL — outbox, retries, idempotence, chiffrement Web Push/VAPID, séparation des états et onboarding PWA : PASS (34/34 tests). Preuve sur iPhone réel, Focus iOS, écran verrouillé, APNs réel, notifications Mac : BLOCKED. NO-GO pour affirmer qu'une alerte « arrive » ; GO pour le brancher sur de vrais appareils et mesurer.**

Environnement : Linux, sans iPhone, sans macOS, sans accès à APNs/FCM, sans Safari. **Aucune capture d'écran d'iPhone réel n'existe** : cette exigence du bloc n'est pas remplie.

## Livrables

| Livrable | Statut | Où |
|---|---|---|
| Outbox transactionnelle (SQLite) | PASS | `src/outbox/db.ts`, `store.ts` — événement + lignes par canal dans une seule transaction `BEGIN IMMEDIATE` |
| Retry borné, idempotence (address_event, canal) | PASS | `worker.ts` (6 essais, 2 s→32 s, gigue), `UNIQUE(address_event_id, channel)` |
| Web Push VAPID + chiffrement | PASS (crypto) / BLOCKED (service réel) | `webpush.ts` : **vecteur officiel RFC 8291 reproduit octet pour octet**, JWT ES256 vérifié |
| Mac UserNotifications | BLOCKED (écrit, non compilé) | `mac/Sources/AlfredMac/Notifier.swift`, `main.swift` ; protocole NDJSON testé côté Node |
| PWA + onboarding Apple écran d'accueil + geste utilisateur | PASS (Chromium) / BLOCKED (Safari iOS) | `web/` ; testé dans Chromium avec UA iPhone |
| États créé / envoyé / accepté / ack appareil / vu | PASS | `delivery_state`, `report()` — `proof` = dernier état atteint |
| Purge des souscriptions expirées | PASS | 404/410, `expirationTime`, rejet après 3×401/403, `purgeExpired` |
| Email absent en V0 | PASS | tout canal ≠ `mac` / `webpush:*` lève `channel_not_supported_v0` |
| « Ouvrir Zoom » uniquement au clic | PASS (statique + Chromium) / BLOCKED (macOS/iOS réels) | voir ci-dessous |

## Vérifications obligatoires

- **Race** : 2 workers (2 connexions SQLite sur le même fichier) + ticks concurrents : 30 envois pour 6 événements × 5 appareils, **0 doublon**. Crash après envoi/avant règlement : le bail expire, le 2ᵉ envoi porte le **même `Topic`** (le service push remplace au lieu de doubler). Règlement tardif d'un worker lent : refusé par le fencing (`lease_owner`).
- **429** : `Retry-After` respecté (pas de réessai avant), ou alerte abandonnée (`expired`) si le délai dépasse son TTL — une alerte livrée en retard est considérée pire qu'une alerte perdue (et tracée).
- **410/404** : ligne morte, souscription expirée puis purgée, les autres appareils et le Mac servis, plus aucun envoi vers la souscription.
- **Push token expiré** : JWT VAPID régénéré à < 10 min de l'expiration (testé) ; souscription à `expirationTime` dépassé écartée sans appel réseau ; 401/403 → pas de réessai, rejet à 3 échecs.
- **HTTP 201 ≠ lu** : après un 201 l'état est « accepté » seulement ; `device_ack` n'existe qu'après l'appel du service worker (`/api/ack`), `seen` qu'après ouverture/clic (`/api/seen`).
- **Focus iOS / écran verrouillé** : **SIMULATION uniquement.** Un 201 sans ack au-delà de 45 s → `unconfirmed` (signalé une fois), jamais « délivré » ; un ack tardif lève le doute. Le comportement réel d'iOS n'a **pas** été observé.
- **iOS exige une notification visible pour chaque push** (sinon révocation de l'abonnement) : la rétractation d'une alerte est donc un push visible de même `tag`, pas un push silencieux. À confirmer sur appareil.
- **« Ouvrir Zoom » au clic** : (Mac) test statique — `NSWorkspace`/`activate()` n'apparaissent que dans `didReceive`, après `guard response.actionIdentifier == openZoomAction`, l'action n'a pas l'option `.foreground` ; (PWA) le service worker n'ouvre que `/?…` (même origine), le lien Zoom est un `<a>` à toucher, URL limitée à `https://*.zoom.us/j/<id>` (liste blanche côté serveur et client) ; dans Chromium, la page ouverte depuis une notification ne navigue pas d'elle-même.
- **Geste utilisateur** : dans Chromium (UA iPhone) — non installée : instructions « Sur l'écran d'accueil », bouton désactivé, **0 appel à `requestPermission`** ; installée : **0 appel au chargement**, puis exactement `requestPermission → register → subscribe(userVisibleOnly)` après le clic.
- **Sécurité** : l'endpoint d'abonnement (fourni par le client) est limité à https + hôtes push connus (apple/fcm/mozilla/windows) contre le SSRF ; `/api/subscribe` exige un jeton d'appairage (comparaison à temps constant), `/api/ack`/`seen` un jeton de livraison à usage unique ; corps limités (413).
- **Confidentialité** : aperçu par défaut « *X s'adresse à vous* » (ni transcription ni extrait) ; `full` seulement sur demande ; payload chiffré de bout en bout vers l'appareil.

## Limites de la preuve

- Aucun envoi vers APNs/FCM réel : `FetchTransport` n'a jamais été exercé ; les codes de réponse sont ceux de la spécification, pas observés. Apple peut répondre autrement (ex. 403 `BadJwtToken`, limites de débit).
- Le chiffrement est validé par le vecteur RFC et par un aller-retour contre un déchiffreur écrit par moi — pas contre un vrai navigateur.
- Aucun test de latence réelle, de fiabilité de livraison, de coalescence côté Apple, ni de comportement en arrière-plan/verrouillé.
- Le test Chromium utilise des stubs pour `serviceWorker`/`PushManager` : il prouve la **logique de geste** de `app.js`, pas le fonctionnement de Web Push dans Safari iOS.
- Le Swift (`Notifier.swift`, `main.swift`) n'a jamais été compilé ; l'entitlement `time-sensitive` n'est pas configuré ; l'ouverture effective de Zoom n'a pas été observée.

## Dettes

1. **Capture preuve iPhone réel** (exigence non remplie) : installer la PWA, s'abonner, envoyer une alerte urgente, photographier écran verrouillé / Focus actif / Focus autorisé, relever `device_ack`/`seen`.
2. Mesurer sur iPhone : `notificationclick → openWindow` vers l'origine, comportement de `renotify`/`tag`, révocation après push sans notification, délai réel du `ack` écran verrouillé.
3. Compiler et tester `mac/` sur macOS 14+ (permission, `.timeSensitive`, clic sur l'action, remplacement par identifiant de requête).
4. Définir la politique d'escalade quand `unconfirmed` (le Mac sonne déjà en parallèle ; pas de second push).
5. Le jeton d'appairage est mono-utilisateur V0 sans rotation ni expiration ; le serveur n'est pas exposé (pas de TLS/hébergement défini).
6. L'éviction du cache et la purge des lignes d'outbox anciennes (`delivery_state`) ne sont pas implémentées (croissance illimitée de l'historique).
7. `Retry-After` en date HTTP et l'en-tête `Topic` n'ont pas été vérifiés contre le comportement réel d'APNs.

## GO / NO-GO

- **GO** : brancher sur de vrais appareils pour mesurer (dettes 1–3) ; le modèle d'états garantit qu'on ne prétendra jamais « lu » sans preuve.
- **NO-GO** : toute communication du type « vous serez alerté » avant l'exécution de la dette 1.

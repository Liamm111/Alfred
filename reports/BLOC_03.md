# BLOC 03 — Authentification produit et connexion Zoom

**Verdict : PASS en simulation locale (82 tests, PostgreSQL réel + faux Zoom + mock HTTP) — BLOCKED pour la validation contre le vrai Zoom et pour tout ce qui est Swift/Keychain.**
**GO** pour poursuivre le développement ; **NO-GO** pour une mise en production tant que les points BLOCKED ci-dessous ne sont pas levés.

## Les trois identités restent séparées

| Identité | Table(s) | Ce qui la prouve |
|---|---|---|
| Produit | `identities`, `auth_sessions`, `auth_codes`, `refresh_tokens`, `access_tokens` | code PKCE → jetons opaques hachés |
| Zoom | `zoom_links` (1:1 dans les deux sens), `secret_refs` (jetons chiffrés AES‑256‑GCM) | OAuth Zoom (state + PKCE) + `GET /users/me` |
| Participant réel d'un flux | `zoom_events` (faits signés par Zoom), `stream_associations` | webhook signé Zoom + lien Zoom du demandeur + jeton d'association signé à usage unique |

Aucune décision ne repose sur un nom de fenêtre ou de participant : les schémas de requête sont stricts (`window_title`, `participant_name`, `owner_id`, `zoom_user_id` → HTTP 400) et `StreamService.claim` n'a que `(ownerId, meetingUuid, streamId)` comme paramètres.

## Livrables

| Livrable | Où | Statut |
|---|---|---|
| Auth produit HTTPS + PKCE S256, session renouvelable (refresh à rotation + détection de réutilisation), logout / logout-all | `src/auth/product-auth.ts`, `src/auth/pkce.ts`, `src/auth/http.ts` | PASS (tests) |
| Clés locales dans le Keychain (jeton refresh produit, `ThisDeviceOnly`, non synchronisé) + PKCE Swift | `swift/AlfredAuthClient` | **BLOCKED** : écrit, jamais compilé ni exécuté |
| OAuth Zoom : state aléatoire à usage unique lié à (utilisateur, session produit), PKCE, scopes en liste blanche, refresh à rotation mono‑vol, révocation, désautorisation | `src/auth/zoom-link.ts`, `src/auth/zoom-client.ts` | PASS contre faux Zoom + mock HTTP ; **BLOCKED** contre Zoom réel |
| Mapping `produit_user ↔ zoom_user_id` 1:1 (PK + UNIQUE en base) | migration `0002_auth` | PASS |
| Association éphémère signée `meeting_uuid/stream_id` avec contrôle d'owner | `src/auth/streams.ts` | PASS |
| Webhook Zoom : signature HMAC `v0`, fenêtre de 5 min, rejeu par `event_id`, `url_validation` | `src/auth/streams.ts` | PASS (schéma du payload à confirmer) |
| Séparation de privilèges : `alfred_auth` ne voit ni sessions ni paquets ; `alfred_app` ne voit aucune table d'auth | migration `0002_auth` | PASS |

## Décisions de conception

- **Jetons produit** : 256 bits aléatoires, seuls les SHA‑256 sont stockés (`auth_*`). Code d'autorisation : 60 s, usage unique, brûlé même sur mauvais `code_verifier` ; un rejeu après succès révoque la session créée. Access 10 min, refresh 30 j (rotation), session absolue 90 j. Réutilisation d'un refresh déjà consommé = vol présumé → toute la session est révoquée (y compris les jetons légitimes). Conséquence assumée : deux refresh simultanés avec le même jeton ne laissent survivre aucune session ; un seul réussit puis la session est révoquée.
- **Redirect URI** : https, boucle locale IP (`127.0.0.1`/`[::1]`) ou schéma privé reverse‑DNS ; correspondance exacte avec la liste du client ; jamais `localhost`/http distant.
- **Zoom `state`** : 256 bits, haché en base, consommé de façon atomique (`UPDATE … WHERE consumed_at IS NULL`), lié à l'utilisateur **et** à la session produit, TTL 10 min ; le `code_verifier` PKCE est scellé en base. Le `nonce` anti‑rejeu vit dans le jeton d'association (Zoom n'émet pas d'id_token).
- **Scopes** : exigés ET plafonnés (`requiredScopes` = `allowedScopes`) ; tout écart révoque immédiatement les jetons fraîchement émis côté Zoom. **Les noms de scopes par défaut (`user:read:user`, `meeting:update:participant_rtms_app_status`) sont une hypothèse à confirmer dans la console Zoom Marketplace.**
- **Refresh Zoom mono‑vol** : verrou de ligne `zoom_links … FOR UPDATE` ; le refresh token tourne (l'ancien meurt chez Zoom), le nouveau est persisté dans la même transaction. `invalid_grant` ⇒ `needs_reauth` + effacement des secrets, **commit garanti** ; panne transitoire ⇒ rien ne change.
- **Chiffrement** : AES‑256‑GCM avec trousseau de clés (rotation : ajouter une clé, la rendre courante) ; AAD = `owner|purpose` (un blob recopié chez un autre utilisateur ou pour un autre usage échoue).
- **Jamais de RTMS pour quelqu'un d'autre** : `authorizeRtmsStart` exige un lien Zoom actif, que `getMe` renvoie bien le `zoom_user_id` lié, et que Zoom lui‑même désigne ce compte comme **hôte** du meeting ; sinon 403 et le démarreur n'est pas appelé. Le jeton Zoom n'est passé qu'au `RtmsStarter` côté serveur ; aucune réponse HTTP ne le contient.
- **HTTPS** : 426 pour toute requête non TLS (socket chiffrée, ou `X-Forwarded-Proto: https` d'un proxy de confiance) ; `Cache-Control: no-store`, HSTS, `nosniff` ; les erreurs ne renvoient qu'un code.

## Tests exécutés (preuves)

`npx vitest run tests/auth` → **5 fichiers, 82 tests, 82 PASS** ; suite complète du dépôt : **402/402**, stable sur 3 exécutions (journal : `reports/logs/bloc03-tests.txt`).

- **OAuth rejeu** : code produit rejoué (+ révocation de la session), state Zoom rejoué, événement webhook rejoué (`replay: true`), jeton d'association rejoué, 6 échanges simultanés du même code → 1 seul gagnant.
- **Mismatch de compte** : produit déjà lié à Z1 qui tente Z2 → 409 et jetons Z2 révoqués ; compte Zoom déjà lié à A que B tente de lier → 409 ; contrainte UNIQUE vérifiée en base.
- **Expiration** : code (60 s), state (10 min), access (10 min), refresh (30 j), session (90 j), jeton d'association (5 min), événement Zoom périmé (10 min), signature de webhook périmée/future.
- **Refresh concurrent** : produit (5 en parallèle → 1 succès, session révoquée) ; Zoom (8 appels simultanés → **un seul** refresh chez Zoom, même jeton pour tous ; faux Zoom à rotation stricte, donc un second refresh échouerait en `invalid_grant`).
- **Logout** : access et refresh morts immédiatement, autres sessions préservées, `logoutAll`, l'identité Zoom reste distincte ; désautorisation Zoom ; `unlink` (Zoom en panne ⇒ effacement local + trace dans `jobs`) ; effacement utilisateur vérifié sur tout le périmètre d'auth.
- **Tentative d'appropriation d'un autre meeting** : B ne peut pas claim le flux de A, ni mélanger meeting/stream, ni démarrer RTMS pour un meeting dont il n'est pas hôte (démarreur jamais appelé) ; jeton volé inutilisable par un autre compte (et non brûlé par l'essai) ; jetons altérés/re‑signés avec une autre clé refusés ; 10 claims simultanés → 1 jeton.
- **PKCE** : vecteur RFC 7636, `plain` refusé, challenge/verifier mal formés, code intercepté inutilisable sans verifier.
- **Aucune fuite** : scan de tous les corps de réponse HTTP (aucun `ZT_*`, hash, ciphertext, stack) ; scan des tables : aucun jeton produit ni Zoom en clair.
- **Tests de mutation (7 mutants, 7 tués)** : retrait du lien state↔utilisateur/session, de la détection de réutilisation du refresh, de la vérification PKCE, du verrou mono‑vol, du contrôle propriétaire Zoom dans `claim`, du plafonnement des scopes, du contrôle « hôte » ; code restauré, suite verte.

## Dettes / risques (à lire avant tout GO production)

1. **BLOCKED – Zoom réel** : aucun identifiant Zoom ici. Non vérifiés : noms exacts des scopes, format des payloads webhook (`meeting.rtms_started`, `app_deauthorized`, champ `operator_id`/`host_id`), endpoint de démarrage RTMS, méthode de preuve « hôte » (seuls les hôtes sont autorisés ; un simple participant ne peut pas démarrer), `url_validation`. `normalizeZoomEvent` rejette toute forme inconnue.
2. **BLOCKED – Swift** : `Pkce.swift`, `KeychainStore.swift` et leurs tests XCTest ne sont ni compilés ni exécutés (pas de toolchain/macOS). Le client natif (ouverture du navigateur, schéma d'URL, stockage effectif) n'existe pas encore.
3. **Premier facteur non fourni** : `/v1/auth/authorize` délègue à une fonction `firstFactor` injectée (IdP, lien magique, Sign in with Apple…). Choix produit à faire ; les tests utilisent un en‑tête de test, **à ne jamais déployer**.
4. **Pas de limitation de débit** ni de journal d'audit des échecs (force brute sur code/refresh peu probable à 256 bits, mais rien n'est plafonné) ; pas de protection anti‑DoS sur le webhook au‑delà de la taille de corps (64 Ko).
5. **Gestion des clés** : trousseau `SecretBox`/`Signer` chargé par le code appelant ; pas de KMS, de rotation planifiée ni de ré‑chiffrement automatique des anciens enregistrements (`needsRotation` existe, non branché).
6. **Révocation Zoom non rejouée** : si Zoom est injoignable lors d'un `unlink`, les jetons sont effacés localement et une ligne `zoom.revoke_failed` est tracée dans `jobs`, mais aucun worker ne retente (le texte clair n'étant plus disponible, la révocation côté Zoom repose sur la désinstallation/expiration).
7. Réutilisation stricte du refresh : un client qui réessaie après une coupure réseau perd sa session (pas de fenêtre de grâce) ; à ajuster si l'UX l'exige.
8. Les tables d'auth ne sont pas couvertes par RLS par propriétaire mais par séparation de rôles (`alfred_auth` vs `alfred_app`) ; l'hypothèse « le service d'auth se connecte avec `alfred_auth` et jamais avec le propriétaire des tables » est à imposer au déploiement.

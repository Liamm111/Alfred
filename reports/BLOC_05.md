# BLOC 05 — Zoom App intégrée pour lancer RTMS

**Verdict : PASS (tests automatisés avec SDK mocké) · BLOCKED (vérification réelle MANUAL_REAL_ZOOM non exécutée)** · **GO/NO-GO : GO conditionnel** pour continuer le développement ; **NO-GO** pour considérer le flux validé tant que S1/S2/S7/S8 ne sont pas joués.

## Livrables
| Exigence | Statut | Preuve |
|---|---|---|
| Zoom Surface App minimale (Zoom Apps SDK), init support/version, startRTMS/stopRTMS | PASS (mock) | `apps/zoom-surface/src/rtms-controller.js`, `public/index.html` (SDK via `appssdk.zoom.us/sdk.js`). Typings officiels `@zoom/appssdk@0.16.42` installés : `startRTMS/stopRTMS/pauseRTMS/resumeRTMS/getRTMSStatus/onRTMSStatusChange` vérifiés par test ; version client min **6.4.10** (annotation du SDK). |
| host approval / denied / disabled / guest / Zoom Apps unavailable | PASS (mock) | États `awaiting_host`, `denied`, `disabled`, `guest`, `unavailable`, `unsupported`, `timeout`, `not_in_meeting`. **Les codes/messages d'erreur réels de `startRTMS` ne sont pas documentés** : le classifieur (`classifyError`) est heuristique (regex) → à calibrer en S2/S3. |
| Renvoyer seulement association signée / nonce court ; pas de secret exposé | PASS | `association-client.js` n'envoie que `{nonce, meetingUUID}` (test sur le corps, `credentials:'omit'`) ; test de source : aucune occurrence de secret/token ; backend `services/rtms-gateway/src/association.js` : nonce 8 car., TTL 120 s, usage unique, reçu HMAC ; l'endpoint refuse tout champ inattendu (test HTTP). L'association est faite **avant** `startRTMS` ; refus → `startRTMS` jamais appelé. |
| Documenter installation (compte perso, scopes, Marketplace, compte de test) | FAIT, non exécuté | `apps/zoom-surface/docs/INSTALL.md`. Scopes issus de la doc consultée + pages tierces : **à revérifier dans l'UI Marketplace**. |
| REST seulement si conditions officielles | FAIT (documenté, non implémenté) | INSTALL §5 : invitee + participant déjà joint, scope `meeting:update:participant_rtms_app_status`, réservé aux apps d'hôtes. |

## Vérifications obligatoires
| | Statut |
|---|---|
| Tests SDK mocké | **PASS — 18/18** (`reports/evidence_bloc05_test_output.txt`) : init sans démarrage auto, indisponible, invité, hors réunion, client ancien, API non supportée, request→approve, deny (rejet + statut), disabled, timeout, association refusée ⇒ pas de startRTMS, stop, stop par l'hôte, réouverture en cours de session, anti double‑start. |
| Même liste de participants avant/après (mock) | PASS : `compareParticipantLists` (détecte un participant ajouté) |
| Script MANUAL_REAL_ZOOM (request/approve/deny, listes avant/après) | **BLOCKED** — rédigé (`apps/zoom-surface/manual/MANUAL_REAL_ZOOM.md`, 9 scénarios), **non exécuté** : pas de client Zoom, pas de compte, pas d'accès Marketplace. |

## Dettes
- Exécuter MANUAL_REAL_ZOOM et remplir le tableau ; calibrer `classifyError` avec les erreurs réelles.
- `getMeetingParticipants` : confirmer rôles autorisés (peut être limité à l'hôte/co‑hôte) ; sinon preuve « pas de participant ajouté » via le panneau Participants.
- Hébergement HTTPS de `apps/zoom-surface/` et paramètres Marketplace (domain allow‑list, OAuth) non faits ; pas de build/bundler.
- Aucun appel REST implémenté. Pas de logs côté navigateur (rien de sensible n'est loggé).

**GO/NO-GO : GO conditionnel** (code prêt et testé en mock ; validation réelle requise avant tout GO produit).

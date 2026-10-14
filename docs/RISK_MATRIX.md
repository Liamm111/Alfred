# Matrice de risques V0.2 (R01–R40) → bloc propriétaire → preuve

Source : PRD V0.2 §J (colonnes ID/risque/prévention/résultat reprises verbatim). Numérotation des blocs = `docs/prompts/CODEX_PROMPTS_MASTER.md` (00–19). Colonne *État* : `NON COUVERT` tant qu'aucun test n'existe ; chaque rapport de bloc la met à jour.

| ID | Risque | Prévention / détection | Résultat attendu | Bloc | État |
|---|---|---|---|---|---|
| R01 | OAuth Zoom expiré | refresh sûr, reauth | état `ZOOM_REAUTH_REQUIRED` | 03 | NON COUVERT |
| R02 | Hôte refuse RTMS | statuts officiels, aucune relance abusive | `HOST_DENIED`, pas de contournement | 05 + 06 | NON COUVERT |
| R03 | Compte Zoom Basic/inéligible | capability check + diagnostic | mode local si autorisé, sinon indisponible | 05 | NON COUVERT |
| R04 | Client Zoom trop ancien | contrôle version / feature detection | proposer mise à jour, mode disponible | 05 | NON COUVERT |
| R05 | Participe via lien partagé, API REST non éligible | chemins démarrage séparés | Zoom App SDK si disponible, sinon local permis | 05 | NON COUVERT |
| R06 | RTMS commencé mais aucune donnée | watchdog sur vrais paquets | ne jamais afficher LIVE | 06 | NON COUVERT |
| R07 | Reconnexion WS et doublons | epoch, idempotency, jitter | ni double résumé ni double push | 06 | NON COUVERT |
| R08 | Transcript final révisé | provisional/final + version | une seule affirmation canonique | 10 | NON COUVERT |
| R09 | Capture locale prend audio d’une autre app | sélection filtre + test concret | marquer audio contaminé, alerte utilisateur | 07 | NON COUVERT |
| R10 | Casque/Bluetooth désynchronise audio | loopback test plusieurs sorties | gap, diagnostic, bascule contrôlée | 07 | NON COUVERT |
| R11 | Mac en veille / lid fermé | notifications sleep/wake, time gaps | état dégradé, couverture manquante | 04 + 07 | NON COUVERT |
| R12 | Fenêtre Zoom minimisée | contrôle présence frame + hash | pas de « vision OK » fictive | 08 | NON COUVERT |
| R13 | Slides dans fenêtre séparée | sélection multiple et changement de source | demande de choisir nouvelle fenêtre | 08 | NON COUVERT |
| R14 | Débit visuel massif | sampling + budget + queue | aucune saturation / crash | 08 + 17 | NON COUVERT |
| R15 | Zoom RTMS transcript absent | STT audio RTMS si autorisé | transcription de secours / état clair | 10 | NON COUVERT |
| R16 | Absence speaker ID local | speaker null, jamais inventé | « intervenant non identifié » | 10 | NON COUVERT |
| R17 | Faux prénom prononcé | classif + règles + labels | fausse alerte mesurée, feedback | 11 | NON COUVERT |
| R18 | Question sans prénom | coréférence avec preuve de contexte | ambiguë sinon | 11 | NON COUVERT |
| R19 | Double alerte Mac + iPhone | idempotence event, canaux séparés | un événement / canaux multiples | 12 | NON COUVERT |
| R20 | Push accepté mais jamais vu | ack app distinct | « non confirmé » | 12 | NON COUVERT |
| R21 | Push abonnement expiré | 410/404 purge, tests | avertissement reconfiguration | 12 | NON COUVERT |
| R22 | Date de devoir ambiguë | parse avec fuseau+contradictions | « date à confirmer » | 15 | NON COUVERT |
| R23 | Tâche annulée plus tard | extraction contradictoire + consolidation | tâche barrée/annulée avec preuve | 15 | NON COUVERT |
| R24 | Slide OCR floue | quality score, no extraction if poor | « visuel illisible » | 08 | NON COUVERT |
| R25 | Prompt injection dans chat/slide | modèle extraction sans outils | aucune action système non voulue | 14 + 16 | NON COUVERT |
| R26 | Cours mélangés | meeting UUID + session scope | isolation stricte | 02 + 09 | NON COUVERT |
| R27 | Stop n’arrête qu’une source | stop-all sources, ack & watchdog | état STOPPED vérifié | 01 + 04 | NON COUVERT |
| R28 | Panne serveur pendant cours | local spool chiffré borné+replay | segments manquants marqués | 09 + 17 | NON COUVERT |
| R29 | Espace disque plein | ring buffer limit + backpressure | alerte + pas de crash | 07 + 17 | NON COUVERT |
| R30 | Coût API/quotas dépassés | budgets, kill switches | partie concernée stoppée + visible | 17 | NON COUVERT |
| R31 | Changement heure été/hiver | UTC+timezone+occurrence id | échéances exactes si univoques | 15 | NON COUVERT |
| R32 | Delete / retrait consentement | cascade+job+audit | purge sans réingestion | 16 | NON COUVERT |
| R33 | Réunion Zoom en deux fenêtres | sélection explicite, tracked window IDs | sources documentées | 08 | NON COUVERT |
| R34 | Organisateur interdit tout traitement | consent gate | aucune capture | 16 | NON COUVERT |
| R35 | Résumé complet malgré coupure | coverage gating | `PARTIAL` obligatoire | 14 | NON COUVERT |
| R36 | Notification d’un autre compte | ACL+ownership tests | erreur 403, aucune fuite | 02 | PARTIEL (hérité B02-v0.0) — `services/api/test/auth.integration.test.ts` : IDOR sessions/préférences ; reste : séances, alertes, notifications |
| R37 | Temps RTMS et Mac divergent | aligner monotonic/UTC et dérive | événements corrects / erreur marquée | 09 | NON COUVERT |
| R38 | Cas simultanés 2 Zoom | interdire ou demander choix | pas de fusion fortuite | 09 | NON COUVERT |
| R39 | Zoom mise à jour change compatibilité | pin SDK+smoke tests | fail safe et alerte | 06 | NON COUVERT |
| R40 | Rapports contiennent PII sensible | redaction/logs, secret scans | pas de fuite dans télémétrie | 16 | PARTIEL (hérité B01-v0.0) — `packages/core/test/logger.test.ts`, `scripts/secrets-scan.mjs` ; reste : télémétrie et rapports |

## Garde-fous globaux K2/K3 (transverses)

| Critère | Bloc | Preuve actuelle |
|---|---|---|
| 0 bot / participant supplémentaire | 00 (+19 audit final) | `pnpm check:no-bot` (AST + dépendances + Swift + hôtes) ; `packages/core/test/features.test.ts` ; `scripts/__tests__/forbid-bot-join.test.ts` — **PASS** |
| 0 secret dans logs / dépôt | 16 | partiel : `pnpm secrets:scan`, logger expurgé |
| 0 lecture inter-utilisateurs | 02 | partiel : IDOR sessions/préférences (v0.0 B02) |
| 0 résumé COMPLET avec gap | 14 | non couvert |
| 1 événement / question, 0 urgence sur mention | 11 | non couvert |
| p95 ≤10 s RTMS / ≤15 s local (fin de phrase → outbox) | 11–12, 17 | non couvert |
| 100 % des claims avec evidence_ids | 14 | non couvert |
| coupure/reprise sans perte silencieuse | 09, 17 | primitive jobs/outbox + kill -9 Postgres (v0.0 B01) ; reste : flux média |
| V0 livrée seulement avec cours Zoom réel + interpellation détectée + push iPhone physique + compte rendu sourcé | 18–19 | **NON ATTEINT** |

## Reprises utiles de la matrice v0.0 (architecture bot, archivée)

| Ancien ID | Sujet | Statut dans v0.2 |
|---|---|---|
| E01/E02/E03/E05 | webhook falsifié / rejoué / géant / doublon | **toujours applicable** aux webhooks Zoom `meeting.rtms_started/stopped` → bloc 06 |
| E04 | event perdu après 2xx (outbox) | toujours applicable → blocs 02/06 (primitive outbox existante) |
| Q01/Q02/Q03 | IDOR, secrets client, PII dans logs | toujours applicables → blocs 02/16 |
| Z01–Z10, Recall/bot, `MeetingProvider` | planification/bot Recall | **caducs** (interdits par l'invariant « aucun participant ») |

# Matrice P0/P1 → bloc propriétaire → preuve de test

Source : PRD §13 (copié verbatim pour ID/gravité/scénario). Les blocs ≥03 ne sont pas définis dans les consignes reçues : « ≥03 » désigne un bloc futur **à nommer**, jamais un bloc existant. Colonne *État* : `NON COUVERT` tant qu'aucun test n'existe ; mise à jour par chaque rapport de bloc.

| ID | Gravité | Domaine | Scénario | Bloc propriétaire | Preuve de test exigée | État |
|---|---|---|---|---|---|---|
| Z01 | P0 | Zoom/planification | URL Zoom usurpée, domaine ressemblant | planification de cours (≥03) | validation hostname/HTTPS, fuzz URLs, pas de fetch arbitraire | NON COUVERT |
| Z02 | P1 | Zoom/planification | Lien expiré, passcode manquant, authentification exigée | ≥03 (Zoom/planification) | surface code échec et actions, fixture correspondante | NON COUVERT |
| Z03 | P0 | Zoom/planification | Bot bloqué en salle d'attente | ≥03 (Zoom/planification) | state waiting_room + timeout, avertir, ne pas prétendre enregistrer | NON COUVERT |
| Z04 | P0 | Zoom/planification | Consentement enregistrement refusé | ≥03 (Zoom/planification) | pas de capture, état access_denied, audit et notice | NON COUVERT |
| Z05 | P1 | Zoom/planification | Le professeur commence en retard | ≥03 (Zoom/planification) | handle host late et fenêtre d'attente configurable | NON COUVERT |
| Z06 | P0 | Zoom/planification | Requête create bot timeout, double création | ≥03 (Zoom/planification) | lease + réconciliation + test race 100 requêtes | NON COUVERT |
| Z07 | P1 | Zoom/planification | Le cours déplacé annule la mauvaise occurrence | ≥03 (Zoom/planification) | UUID occurrence et clé schedule unique, tests récurrence | NON COUVERT |
| Z08 | P1 | Zoom/planification | Changement heure d'été/hiver ou timezone erroné | ≥03 (Zoom/planification) | conversion IANA, tests DST fold/gap, affichage UTC/local | NON COUVERT |
| Z09 | P1 | Zoom/planification | Retard + réessai créent un bot après annulation | ≥03 (Zoom/planification) | cancellation token/version, vérification transactionnelle | NON COUVERT |
| Z10 | P1 | Zoom/planification | Expulsion du bot/reconnexion non détectée | ≥03 (Zoom/planification) | lifecycle/webhook, terminal/degraded, reprise bornée | NON COUVERT |
| E01 | P0 | Webhooks/événements | Webhook falsifié accepté | ≥03 (Webhooks/événements) | HMAC raw body + signature invalide tests | NON COUVERT |
| E02 | P0 | Webhooks/événements | Webhook ancien rejoué | ≥03 (Webhooks/événements) | fenêtre temporelle + unique ID base, tests replay | NON COUVERT |
| E03 | P1 | Webhooks/événements | Payload géant épuise la mémoire | ≥03 (Webhooks/événements) | limite de taille à l'entrée, réponse contrôlée | NON COUVERT |
| E04 | P0 | Webhooks/événements | Event reçu mais perdu après HTTP 2xx | 01 (primitive outbox) + ingestion ultérieure | test outbox transactionnel `packages/db` (primitive seule) | NON COUVERT |
| E05 | P1 | Webhooks/événements | Webhook en retry redouble transcriptions | ≥03 (Webhooks/événements) | unique(provider,id), idempotence test | NON COUVERT |
| E06 | P1 | Webhooks/événements | Event out of order fait reculer état | ≥03 (Webhooks/événements) | state machine monotone + timestamps/version, tests | NON COUVERT |
| E07 | P0 | Webhooks/événements | Événements ne sont plus livrés après trop d'échecs | ≥03 (Webhooks/événements) | métrique lastEventAt, DLQ, dégradation visible, alarme | NON COUVERT |
| E08 | P1 | Webhooks/événements | Mauvaise distinction lifecycle et transcript | ≥03 (Webhooks/événements) | routes/types séparés + contract tests | NON COUVERT |
| T01 | P1 | Transcription | Parole fragmentée traitée comme plusieurs questions | ≥03 (Transcription) | final vs partial, buffer, test incrémental | NON COUVERT |
| T02 | P1 | Transcription | Même utterance final apparaît plusieurs fois | ≥03 (Transcription) | stable key + contrainte DB, replay | NON COUVERT |
| T03 | P1 | Transcription | Noms des locuteurs changent en cours | ≥03 (Transcription) | IDs stables, alias de displayName, tests | NON COUVERT |
| T04 | P1 | Transcription | Deux voix simultanées, attribution erronée | ≥03 (Transcription) | unknown-speaker, marque faible confiance | NON COUVERT |
| T05 | P1 | Transcription | Silence de la classe pris pour panne audio | ≥03 (Transcription) | séparer absence parole/état fournisseur ; message prudent | NON COUVERT |
| T06 | P1 | Transcription | Vrai audio coupé sans statut de panne | ≥03 (Transcription) | coverage gaps heuristics + reconciliation, test interruption | NON COUVERT |
| T07 | P1 | Transcription | Français et anglais mélangés | ≥03 (Transcription) | STT multi + corpus code-switch + langue de sortie FR | NON COUVERT |
| T08 | P1 | Transcription | Mot technique et prénom mal reconnus | ≥03 (Transcription) | aliases phonétiques contrôlés, terme list, éval dédiée | NON COUVERT |
| A01 | P0 | Attention/alertes | « Liam a dit » déclenche urgence | ≥03 (Attention/alertes) | negative rules + corpus précision | NON COUVERT |
| A02 | P0 | Attention/alertes | Question directe ignorée | ≥03 (Attention/alertes) | recall corpus, seuils, éval live, fallback règles | NON COUVERT |
| A03 | P1 | Attention/alertes | « Et toi ? » sans cible provoque alerte certaine | ≥03 (Attention/alertes) | class ambiguous, jamais urgent certain sans preuve | NON COUVERT |
| A04 | P1 | Attention/alertes | Question citée dans un exemple | ≥03 (Attention/alertes) | détecter citations et discours rapporté, fixtures | NON COUVERT |
| A05 | P1 | Attention/alertes | Consigne de groupe confondue avec question personnelle | ≥03 (Attention/alertes) | assign vs addressed, tests | NON COUVERT |
| A06 | P1 | Attention/alertes | Reformulation crée 5 push | ≥03 (Attention/alertes) | groupe sémantique temporel, dedupe key | NON COUVERT |
| A07 | P1 | Attention/alertes | Prompt injection dans la transcription | ≥03 (Attention/alertes) | données non fiables, schema outputs, adversarial tests | NON COUVERT |
| A08 | P0 | Attention/alertes | L'IA répond oralement au nom de l'étudiant | ≥03 (Attention/alertes) | absence totale de canal output audio, test architecture | NON COUVERT |
| N01 | P0 | Push/notifications | App croit Push actif mais abonnement absent | ≥03 (Push/notifications) | onboarding gate, test subscription/ack | NON COUVERT |
| N02 | P1 | Push/notifications | Safari iOS non installé PWA → push impossible | ≥03 (Push/notifications) | détection + instructions Add to Home Screen | NON COUVERT |
| N03 | P1 | Push/notifications | Push service accepte mais téléphone ne voit rien | ≥03 (Push/notifications) | état accepted≠delivered, test device réel | NON COUVERT |
| N04 | P1 | Push/notifications | Abonnement expiré/revoqué | ≥03 (Push/notifications) | nettoyage 404/410, état dégradé | NON COUVERT |
| N05 | P1 | Push/notifications | Plusieurs appareils reçoivent les mêmes alertes non voulues | ≥03 (Push/notifications) | prefs/device labels, outbox per-device, unique attempts | NON COUVERT |
| N06 | P0 | Push/notifications | Push sensible sur écran verrouillé | ≥03 (Push/notifications) | notification discrète par défaut, test payload | NON COUVERT |
| N07 | P1 | Push/notifications | Alerte 10 min après la fin présentée comme live | ≥03 (Push/notifications) | TTL, mention « tardive », audit time | NON COUVERT |
| S01 | P0 | Rapport/devoirs | Résumé invente la présentation non entendue | ≥03 (Rapport/devoirs) | provenance obligatoire + limitations visibles | NON COUVERT |
| S02 | P0 | Rapport/devoirs | Devoir « à rendre » oublié | ≥03 (Rapport/devoirs) | corpus extraction recall + section consignes dédiée | NON COUVERT |
| S03 | P0 | Rapport/devoirs | Date inventée à partir de « bientôt » | ≥03 (Rapport/devoirs) | due certainty/nullable, tests date parser | NON COUVERT |
| S04 | P1 | Rapport/devoirs | « pas à rendre » compris « à rendre » | ≥03 (Rapport/devoirs) | tests négation, schema type, human confirm | NON COUVERT |
| S05 | P1 | Rapport/devoirs | Prof corrige une échéance plus tard | ≥03 (Rapport/devoirs) | chronology merge + conflicting evidence | NON COUVERT |
| S06 | P1 | Rapport/devoirs | Travail facultatif affiché obligatoire | ≥03 (Rapport/devoirs) | optional field + tests | NON COUVERT |
| S07 | P1 | Rapport/devoirs | Plusieurs cours mélangent leurs devoirs | ≥03 (Rapport/devoirs) | partition occurrenceId + tests isolation | NON COUVERT |
| S08 | P1 | Rapport/devoirs | Synthèse 2h tronquée par tokens | ≥03 (Rapport/devoirs) | map-reduce + coverage checks | NON COUVERT |
| S09 | P1 | Rapport/devoirs | Rapport « complet » sur flux partiel | ≥03 (Rapport/devoirs) | coverage state + gate completed_partial | NON COUVERT |
| S10 | P1 | Rapport/devoirs | Résumé provisoire remplace rapport final | ≥03 (Rapport/devoirs) | immutabilité par version, CAS | NON COUVERT |
| Q01 | P0 | Sécurité/vie privée | Accès aux cours d'un autre compte via UUID | 02 | tests IDOR/401 `apps/api/test/*.integration.test.ts` | NON COUVERT |
| Q02 | P0 | Sécurité/vie privée | Clés Recall/LLM exposées au client | 01 | `pnpm secrets:scan` + test bundle web | NON COUVERT |
| Q03 | P0 | Sécurité/vie privée | Transcription personnelle dans logs/erreurs | 01 | test logger expurgé `packages/core` | NON COUVERT |
| Q04 | P1 | Sécurité/vie privée | Suppression de cours mais jobs ressuscitent données | ≥03 (Sécurité/vie privée) | tombstones/version + purge test | NON COUVERT |
| Q05 | P1 | Sécurité/vie privée | Webhook provider reconstruit données supprimées | ≥03 (Sécurité/vie privée) | tombstone denylist/expiry, delete replay test | NON COUVERT |
| Q06 | P1 | Sécurité/vie privée | Texte du cours commande au LLM d'exfiltrer | ≥03 (Sécurité/vie privée) | untrusted boundary, pas de tools, injection eval | NON COUVERT |
| Q07 | P1 | Sécurité/vie privée | Prompt export HTML/XSS via nom d'intervenant | ≥03 (Sécurité/vie privée) | escaping côté UI, CSP, tests XSS | NON COUVERT |
| Q08 | P1 | Sécurité/vie privée | Incohérence rétention app/Recall | ≥03 (Sécurité/vie privée) | purge contract, fournisseurs audités et limitation explicitée | NON COUVERT |
| O01 | P1 | Opérations | Déploiement sans migration | 01 | test readiness schéma `apps/api` | NON COUVERT |
| O02 | P1 | Opérations | Worker redémarre au milieu du cours | 01 (primitive jobs) + worker métier ultérieur | test lease/crash `packages/db` | NON COUVERT |
| O03 | P1 | Opérations | LLM en surcharge bloque l'ingestion | ≥03 (Opérations) | queue séparation et circuit breaker | NON COUVERT |
| O04 | P1 | Opérations | Bogue de production invisible jusqu'au prochain cours | 01 (healthchecks) + observabilité ultérieure | test `/health/*` `apps/api` | NON COUVERT |
| O05 | P1 | Opérations | Test « tout vert » car tout mocké | 00 (gates) + gate REAL-ZOOM | `docs/RELEASE_GATES.md` : gates REAL-* NOT VERIFIED | NON COUVERT |

Total P0/P1 : 64 lignes.

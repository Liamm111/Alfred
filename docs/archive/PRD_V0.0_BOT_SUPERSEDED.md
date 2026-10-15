14 octobre 2026 \| Zoom · Transcription FR/EN · Alertes ciblées · Résumés · Devoirs

Ce document décrit une V0 à construire et tester. Il ne constitue pas une application déjà livrée et ne garantit pas l’absence absolue de bugs.

**DÉCISIONS CLÉS**

- Assistant clairement identifié, autorisé par l’hôte ; aucune usurpation de présence académique.

- Alerte sourcée lorsqu’on s’adresse à l’utilisateur, avec niveaux de certitude.

- Compte rendu pédagogique et devoirs datés uniquement si les preuves sont suffisantes.

- PostgreSQL, jobs durables, événements signés et déduplication de bout en bout.

- Go-live bloqué tant que Zoom réel et Push iPhone ne sont pas vérifiés.

# PRD MASTER — AI COURSE ASSISTANT

**Version : V0.0 — Source of Truth \| 14 octobre 2026 \| Statut : spécification de réalisation**

**Produit :** assistant personnel transparent pour suivre des cours Zoom autorisés, détecter les sollicitations de l'étudiant et restituer les cours, devoirs, échéances et zones d'incertitude.

**Nature de ce document :** cahier des charges contractuel à implémenter et vérifier. **Le logiciel n'est PAS considéré comme livré par la rédaction de ce PRD.**

## 0. Résumé exécutif et définition exacte de la V0

L'utilisateur souhaite déléguer le **suivi informationnel** d'un cours Zoom, sans prétendre que sa présence académique est assurée. Il ajoute un lien Zoom, définit la date et l'heure, autorise un assistant nommé « Assistant IA de \[prénom\] », choisit les noms par lesquels le professeur pourrait l'interpeller et active les alertes. Le bot assiste au cours **uniquement lorsque l'organisateur et la politique de l'établissement le permettent**, reçoit des paroles horodatées et attribuées à un intervenant dans la mesure du possible, détecte les questions/adresses potentielles et avertit l'utilisateur. En fin de cours, le produit produit un résumé factuel et une liste de devoirs avec références aux passages sources, échéances explicites ou incertaines, et un suivi de validation.

**Promesse :** « Mon assistant suit les informations du cours et me prévient quand une intervention de ma part semble nécessaire. »

**Non-promesse :** ne remplace pas légalement ou pédagogiquement l'assiduité, ne garantit pas de détecter toute intervention, n'usurpe pas l'identité d'un étudiant et n'envoie aucune réponse à sa place.

### 0.1 Critères de sortie V0 — TOUS requis

1.  L'application privée et authentifiée permet de programmer **un cours unique ou récurrent avec dates explicites**, d'éditer/annuler, et d'afficher son état réel.

2.  L'assistant, clairement identifié comme IA, peut rejoindre au moins un cours Zoom de test dont l'hôte a accordé les autorisations requises **sans que l'utilisateur ait lui-même rejoint le Zoom** ; admission et audio ne sont pas garantis pour des réunions externes.

3.  En cours, la transcription FR/EN est reçue et persistée avec horodatages, attribution du locuteur si disponible, et indication de qualité/absence de données. Le système ne confond jamais « bot dans le Zoom » et « audio autorisé / flux actif ».

4.  Une question directement adressée à l'utilisateur produit **une seule alerte contextuelle** visible dans l'application et tente une notification Web Push sur iPhone configuré ; l'interface montre « délivrance non confirmée » si nécessaire.

5.  Une simple mention du prénom, une citation ou une consigne collective ne devient pas automatiquement une question directe. Les cas ambigus sont étiquetés **« Peut nécessiter ton attention »** plutôt que présentés comme des certitudes.

6.  Le résumé de cours contient les notions, explications et consignes réellement entendues, ainsi que les omissions/incertitudes ; pas d'invention de contenu visuel non capturé.

7.  Les devoirs sont classés : **à rendre / à faire / à lire / à réviser / information incertaine** ; chacun affiche un énoncé clair, responsable, échéance éventuelle, preuve horodatée, état de confirmation.

8.  Un cours sans transcription ou un fournisseur en panne n'obtient **jamais** un résumé trompeur « complet » ; afficher une alerte de couverture insuffisante et un rapport partiel si des segments existent.

9.  Historique de cours, consultation, édition des devoirs, export Markdown et suppression effective côté application ; cycle de suppression fournisseur documenté.

10. Données privées, signatures de webhooks validées, anti-rejeu, contrôle d'accès de toutes les requêtes, tests automatisés, monitoring, scénario Zoom réel et lancement documenté.

## 1. Utilisateur, contexte et garde-fous d'usage

- **Cible V0 :** un étudiant utilisateur principal, mais architecture multi-tenant préparée pour ne pas compromettre la sécurité.

- **Langues :** français prioritaire ; anglais, alternances FR/EN et noms propres.

- **Support initial :** navigateur desktop + web app installable sur iPhone (PWA) ; pas d'application iOS native dans V0.

- **Zoom :** priorité aux cours Zoom autorisés. Pas de Google Meet/Teams en V0.

- **Cours de 20 à 180 minutes** à tester, y compris pauses longues et reprogrammations. Durée supérieure : avertir, mais ne pas couper arbitrairement.

- **Enseignant :** voix identifiée quand possible, jamais supposée si la diarisation est incertaine.

- **Transparence :** nom du participant indique IA ; information écrite/notice adaptée ; pas de bypass de salle d'attente, pas de contournement des règles scolaires ou de la volonté de l'hôte.

- **Pas de réponse autonome**, d'avatar humain, de faux émargement, de reconnaissance faciale, d'interaction vocale dans Zoom ni d'envoi de devoir à la place de l'utilisateur.

- **Validation juridique et institutionnelle préalable** à toute utilisation en cours réel, dont base juridique et information/consentements requis selon les personnes et juridictions.

## 2. Parcours produit et user stories

### 2.1 Onboarding de 2 minutes

- Inscription par email + lien de connexion ou autre fournisseur géré ; session durable sécurisée, logout et révocation.

- Prénom de l'utilisateur, noms d'appel/aliases (prénom, nom, surnom, prononciation approximative), langue des résumés, fuseau horaire de référence (Europe/Paris par défaut mais modifiable), préférences d'alerte.

- Vérification de prise en charge des notifications : navigateur, autorisation explicite, abonnement valide. Sur iPhone, assistant guidé « Ajouter à l'écran d'accueil » puis consentement Push depuis un geste utilisateur ; bouton « Envoyer une alerte de test ».

- Si Push indisponible : état bloquant pour la promesse « alerte immédiate », message clair « Application ouverte seulement / email de secours non instantané » ; l'utilisateur choisit s'il accepte.

### 2.2 Ajouter un cours

- Champs : titre, URL Zoom, date, heure, timezone, heure de fin indicative, enseignant facultatif, notes facultatives, termes spécifiques (matière, projet), mode d'alerte.

- URL acceptée selon les formats Zoom explicitement validés ; rejeter autres domaines, URL suspectes, schémas non HTTPS, confusion IDN, liens avec paramètres mal formés ; **ne jamais effectuer de SSRF en résolvant une URL fournie par l'utilisateur**.

- Calendrier intégré de cours, option « démarrer maintenant » pour tester ; facultativement répétition hebdomadaire avec fin définie, conservant les occurrences, chacune individuellement annulable.

- Avant « Programmer » : cocher que l'utilisateur a le droit d'inviter l'assistant et qu'une notice appropriée sera fournie ; enregistrer version de la notice et instant de validation.

- Si le cours est passé ou le changement horaire dépasse le délai possible, expliciter ce qui se passe ; gestion des changements d'heure été/hiver et DST.

### 2.3 Pendant le cours

- États visibles : programmé → tentative de connexion → salle d'attente → dans le Zoom, autorisation d'enregistrement en attente → transcription active → flux suspect/interrompu → terminé / échec / annulé.

- Écran « En direct » : statut horodaté, durée, dernière parole reçue, locuteurs, extraits récents, alertes, actions « Rejoindre Zoom », « Arrêter l'assistant », « Afficher l'état des notifications ».

- Le bouton « Rejoindre Zoom » ouvre le lien fourni par l'utilisateur (URL validée et sûre) ; n'ajoute pas artificiellement l'utilisateur à la réunion.

- Périodes silencieuses : « aucune parole reçue depuis… » (pas de diagnostic de panne sans signal) ; si le fournisseur signale une perte, « suivi dégradé ».

- Détection de sollicitation : priorité haute quand une question explicite à l'utilisateur est reconnue ; priorité moyenne pour demandes de validation potentiellement adressées ; mentions simples consignées mais non pushées par défaut.

### 2.4 Après le cours

- Une « fiche cours » est créée avec couverture (durée captée estimée, éventuelles plages manquantes), résumé court, plan détaillé, notions-clés, décisions/consignes, devoirs et questions importantes non résolues.

- Chaque assertion et chaque tâche possède un lien vers la source texte (speaker, timestamp et segment ID). Si preuve indisponible, n'afficher que « Hypothèse à vérifier ».

- Date absolue calculée seulement si le langage et le fuseau de référence la rendent **non ambiguë** ; sinon « date à confirmer » et contenu source brut.

- Travail personnel : cases à cocher à confirmer, à faire, en cours, fait, écarté ; modification manuelle du titre/date, sans effacer l'original ni la preuve.

- Export Markdown ; pas de stockage sur Google Drive, Notion, Classroom sans permission et intégration dédiée.

## 3. Cartographie des écrans V0 (desktop et iPhone)

| **Écran**        | **Sous-sections / états**                                        | **Critère d'acceptation**                              |
|------------------|------------------------------------------------------------------|--------------------------------------------------------|
| Connexion        | connexion, lien magique, expiration, erreur                      | aucune page privée accessible sans session valide      |
| Onboarding       | identité, aliases, zone horaire, langue, notifications, notice   | l'utilisateur sait si les notifications fonctionneront |
| Accueil          | prochain cours, cours en direct, derniers cours, tâches urgentes | zéro état vide ambigu                                  |
| Nouveau cours    | formulaire validé, calendrier, consentement, erreurs URL         | aucune programmation implicite                         |
| Cours en direct  | statut, transcription, alertes, reconnect, actions               | visible sur mobile, actualisation accessible           |
| Centre d'alertes | urgente / possible / mention, source, statut d'envoi, accusé     | pas de doublon visuel                                  |
| Fiche cours      | résumé, sections, citations, passages manquants, export          | aucune invention visualisée comme certaine             |
| Travaux à faire  | tri par échéance, cours, type, confirmation, source              | échéance non prouvée n'est pas créée comme certaine    |
| Paramètres       | aliases, notifications, rétention, fuseau, compte et suppression | données et abonnement push supprimables                |
| Erreurs système  | attente d'hôte, refus, reconnect, service indisponible           | messages actionnables sans faux succès                 |

**Design :** très lisible, minimal, responsive conçu séparément mobile / desktop ; grands tap targets, accessibilité clavier, aria-labels, contraste AA, couleurs non exclusives des statuts, dark mode facultatif. Les alertes urgentes prévalent sur l'esthétique : titre concret, question, auteur, contexte bref, bouton « Rejoindre ».

## 4. Architecture de référence — simple et robuste

Utilisateur (web/PWA authentifiée)

\| Notification Web Push (VAPID)

v ^

Next.js -\> API Fastify TS -\> PostgreSQL + jobs persistés -\> Worker

\| \| \| \|

\| \| \| +-\> Classification + LLM

\| \| +-\> outbox +-\> Résumé & devoirs

\| +-\> modèles canoniques événements

v

Recall.ai Bot Adapter \<-\> Zoom autorisé

\|

Webhooks signés Recall (lifecycle / transcript finals)

- **Base :** monorepo pnpm, TypeScript strict, apps/web Next.js App Router, apps/api Fastify, apps/worker jobs, packages/core types Zod, packages/providers Recall et futurs adaptateurs, packages/evals, PostgreSQL + ORM (Drizzle recommandé), migrations explicites, Docker Compose local, GitHub Actions CI.

- **Justification :** PostgreSQL comme source de vérité ; jobs durables évitent de perdre un cours, événement, alerte ou rapport si un process redémarre. Pas de Kafka, Kubernetes, architecture microservices prématurée.

- **Organisation :** un seul endpoint d'ingestion qui valide l'authenticité **avant de parser et persister le JSON** ; 2xx après mise en base/enqueue durable, traitements longs hors HTTP. Gestion de signatures selon type de webhook et ancienneté du compte Recall ; refuse si secret absent. Prévoir rotation de secret.

- **Provider principal :** bot Recall.ai nommé avec transparence et configuré selon sa documentation officielle ; audio retranscrit via Deepgram streaming Nova-3 en mode multi, diarisation quand disponible. Ne pas supposer que l'accès sans utilisateur humain est accepté par toutes les classes.

- **Événements :** transcript.data = utterance finalisée ; transcript.partial_data facultatif pour prévisualiser, sans alimenter directement les devoirs/résumés définitifs. Événements lifecycle séparés des événements temps réel ; vérification et stratégies de retry distinctes.

- **Latence :** l'API de transcription peut retarder la finalisation ; mesurer l'E2E et ne pas annoncer un délai garanti. Le moteur d'alerte rapide doit éviter une course avec les finals.

- **Future alternative :** Zoom RTMS permet les flux audio/transcription via une intégration officielle et des scopes explicites, mais impose sa propre disponibilité, autorisation et modèle de démarrage ; garder MeetingProvider abstrait, ne pas l'implémenter en V0.

### 4.1 Flux transactionnel

11. ScheduleCourse: validation, statut scheduled, tentative idempotente avec clé stable, persist avant appel fournisseur.

12. JoinBot: worker prend un lease, cherche existing bot, crée une seule requête si absent, persiste providerBotId; si réponse réseau inconnue, réconcilie à partir de tags/métadonnées/résultats fournisseur avant toute nouvelle création (pas de doublon).

13. WebhookAccept: lit raw body dans limite taille ; vérifie HMAC, fenêtre temporelle, déduplique (provider, webhookId) ; transaction d'écriture de l'événement et de l'outbox ; répond 2xx.

14. Normalize: transforme provider payload en schéma utterance.final, participant stable, rang, temps relatifs, texte, source, version ; rejette payload invalide vers quarantaine explicite.

15. Detect: règles haute précision + classifieur sémantique sous contrat de sortie strict ; événement d'attention idempotent meetingId+sourceSpan+intentType avec fenêtre de regroupement.

16. Notify: Alert puis NotificationAttempt, retry borné sur échec, expiration logique ; centre d'alertes toujours complet même en cas de Push inaccessible.

17. Finalize: job après état terminal et délai de stabilisation configuré ; transcript final immuable de référence ; sortie structurée sourcée ; retries idempotents et statut partiel si gaps.

18. Delete: suppression du contenu et des embeddings éventuels, révoquer tokens/abonnements, demande de suppression au fournisseur si supportée ; audit minimal sans verbatim privé.

## 5. Contrats de données et machines d'état

### 5.1 Tables minimales

| **Table**             | **Champs essentiels / contraintes**                                                                                                                         |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| users                 | id, email unique, createdAt, deletedAt                                                                                                                      |
| user_preferences      | userId, aliases\[\], locale, timezone, alertPreferences, retentionDays                                                                                      |
| courses               | id, userId, title, zoomUrlCiphertext, startsAtUtc, timezone, intendedEndUtc, recurrenceRule nullable, lifecycleVersion                                      |
| course_occurrences    | id, courseId, userId, scheduledStartUtc, status, providerBotId unique nullable, version, coverageState                                                      |
| consent_events        | id, userId, occurrenceId, noticeVersion, answeredAt, scope, status                                                                                          |
| provider_events       | id, provider, providerMessageId, occurrenceId, receivedAt, type, payloadCiphertext?, digest, unique(provider,providerMessageId)                             |
| participants          | id, occurrenceId, providerId, displayName, roleConfidence, unique occurrence+providerId                                                                     |
| transcript_utterances | id, occurrenceId, providerUtteranceId, participantId, isFinal, startMs, endMs, textCiphertext, sourceEventId, unique occurrence+providerUtteranceId+version |
| attention_events      | id, occurrenceId, spanStartId, spanEndId, type, addressedToUser, certainty, evidenceJson, dedupeKey unique                                                  |
| alerts                | id, occurrenceId, attentionEventId unique, priority, title, summary, status, createdAt, deliveredAt nullable, acknowledgedAt nullable                       |
| push_subscriptions    | id, userId, endpointHash unique, endpointCiphertext, keyCiphertext, deviceLabel, createdAt, revokedAt                                                       |
| notification_attempts | id, alertId, channel, attemptNo, status, providerCode, queuedAt, attemptedAt, acceptedAt; unique(alertId,channel,attemptNo)                                 |
| course_reports        | id, occurrenceId, version, status, coverageSummary, generatedAt, summaryStructuredJson, unique(occurrenceId,version)                                        |
| assignments           | id, reportId, occurrenceId, title, type, ownerKind, dueDate, dueTimezone, dueConfidence, exactSourceQuote, evidenceSegmentIds\[\], lifecycle, editedFields  |
| job_queue             | id, type, uniqueKey, payloadReference, availableAt, lockedUntil, attempts, status, errorCode                                                                |
| audit_events          | id, userId, targetId, action, timestamp, outcome, minimalMetadata (sans contenu sensible)                                                                   |

**Isolation :** toutes les clés enfant occurrenceId appartiennent à userId côté base et API ; pas d'IDOR. course_id/assignment_id seuls ne suffisent jamais à autoriser une lecture. Pas de données sensibles en URL, dans les push visibles sur écran verrouillé par défaut afficher un aperçu discret configuré, ni dans les logs.

### 5.2 Machine d'état \`course_occurrences.status\`

scheduled -\> dispatching -\> joining -\> waiting_room -\> in_call_no_consent -\> transcribing -\> degraded -\> transcribing -\> finalizing -\> completed

États terminaux alternatifs : cancelled, access_denied, failed, completed_partial. Transitions déclenchées par événements réels vérifiés, pas par timeout optimiste. Aucun événement ancien ne doit faire reculer un état terminal. lastEventAt et updatedAt séparés. Transitions illégales journalisées.

### 5.3 États de notification

new -\> queued -\> provider_accepted -\> user_acknowledged, ou new/queued -\> failed/retrying/expired. Un 201/202 côté Push veut dire **acceptation fournisseur**, pas lecture sur iPhone. Ne pas appeler delivered tant que la plate-forme ne fournit pas d'accusé fiable ; préférer sent_to_push_service.

### 5.4 États de devoir

extracted_unverified -\> user_confirmed -\> in_progress -\> done, ou dismissed. Toute correction humaine porte editedBy, editedAt, et conserve la phrase source.

## 6. Algorithme d'interpellation : priorités et critères

**Sources d'identité :** aliases exacts normalisés (accents/ponctuation), contexte d'allocution, rôle du locuteur, fenêtre de dialogue, état des interlocuteurs et qualité STT. Le prénom seul ne déclenche pas une urgence.

| **Catégorie**           | **Exemple**                                      | **Comportement**                                                                     |
|-------------------------|--------------------------------------------------|--------------------------------------------------------------------------------------|
| DIRECT_EXPLICIT         | « Liam, peux-tu expliquer ta réponse ? »         | urgent, push immédiat si confiance suffisante                                        |
| DIRECT_VARIANT          | « Monsieur Pioline, tu peux répondre ? »         | urgent si alias reconnu                                                              |
| INDIRECT_REQUEST        | « Tu pourrais demander à Liam de nous dire ? »   | possible, priorité moyenne                                                           |
| MENTION_ONLY            | « Comme Liam l'a dit »                           | mention dans journal, sans push                                                      |
| GROUP_INSTRUCTION       | « Vous devez tous rendre le TP »                 | devoir pour classe, sans alerte personnelle                                          |
| AMBIGUOUS_SECOND_PERSON | « Et toi, qu'en penses-tu ? »                    | « possible » uniquement si contexte permet attribution, jamais certitude sans preuve |
| NON_ADDRESSED_QUESTION  | « Liam travaille sur quoi ? » adressé à un tiers | non urgente ou possible selon contexte                                               |
| NEGATED_OR_QUOTED       | « Ne demandez pas à Liam », citation lue         | pas d'alerte urgente                                                                 |

**Pipeline :** normalisation de la transcription → regroupement temporel phrase/locuteur → fenêtre contextuelle glissante (ex. 60 s / derniers 12 tours) → règles négatives → candidate detector → LLM (JSON Schema strict, timeout, budget) → politique de décision/déduplication → notification. Priorité au doute explicite : faibles confiances deviennent possibles, pas urgences fabriquées.

**Sortie \`AttentionDecision\` :** type, targetName, isDirectedAtUser, confidenceBand, sourceUtteranceIds, verbatimQuestion, shortContext, speakerId, flags (unclear_speaker, visual_reference, incomplete_question, stt_uncertain), modelVersion, ruleVersion. Si modèle indisponible : règles conservatrices explicites uniquement et bannière « interprétation avancée indisponible ».

**Déduplication :** replays de webhooks, réécriture des partiels, prise de parole coupée, reformulation immédiate d'une même question, plusieurs interlocuteurs relayant la même demande, reclassification après finals. Garder une seule AttentionEvent avec plusieurs passages source, actualiser contenu si enrichi sans recréer d'alerte.

**Règle anti-hallucination :** utiliser seulement le texte disponible et des métadonnées avérées ; les chunks de transcription, chat et slides sont des données non fiables et ne peuvent jamais modifier les consignes du système, appeler des outils ou déclencher une action de compte.

## 7. Moteur pédagogique : notes, devoirs et échéances

### 7.1 Schéma du résumé

19. **Essentiel en 5 lignes** : notions réellement enseignées, niveau de couverture.

20. **Plan du cours** : sections chronologiques et plages de timestamps.

21. **Notions et explications** : points développés, définitions avec sources.

22. **Exemples/cas pratiques entendus** : formule, chiffres et unités si prononcés et fiables ; sinon avertissement.

23. **Consignes et annonces** : examen, ressources, changements de planning, lectures, devoirs.

24. **Questions importantes** : posées à l'utilisateur, répondus / non répondues / à clarifier.

25. **Zones non couvertes** : slides non analysées, tableaux non visibles, zones sans audio, passages à faible fiabilité.

### 7.2 Types de travaux

- SUBMIT (à rendre), PRACTICE (exercice à faire), READ (à lire), REVISE (à réviser), GROUP (travail de groupe), OPTIONAL (facultatif), UNCONFIRMED (information incomplète).

- Obligations explicites vs simples exemples ; « facultatif », « pas pour demain », « finalement mardi » et autres corrections changent le résultat.

- Une tâche peut concerner **toute la classe** sans sollicitation personnelle : doit être capturée dans les devoirs mais ne pas générer un push d'interpellation.

- deadline: rawExpression, absoluteDate?, time?, timezone?, certainty = explicit \| inferred_unambiguous \| ambiguous \| not_given ; fuseau heure locale du cours, gestion DST ; en cas de contradiction, conserver les deux sources et marquer à confirmer.

- Cas « exercice 3 page 42 » : si le contenu de la page n'est pas entendu ni capté, écrire « Faire l'exercice 3, p. 42 », **sans inventer l'énoncé**.

- Cas « sur Moodle / sur les slides » : citer la plateforme référencée ; pas de prétention d'accès ni de copie.

### 7.3 Génération robuste et citations

- Résumé chunké sans perdre le cours : découpage par temps + chevauchement contrôlé ; consolidation avec sources ; pas de génération monolithique qui échoue à 2h.

- Sorties LLM structurées JSON Schema validées en runtime ; rejet et retry contrôlé ; persister modelVersion, promptVersion, coverageWindow, sourceSegmentIds.

- Pour chaque phrase factuelle/règle métier importante, sourceSegmentIds\[\] ou marque « insuffisant à vérifier » ; si un segment source est supprimé, rapport affiché comme partiellement non vérifiable.

- Mettre à jour la fiche en cours uniquement en statut provisoire. Publication finale après fin effective du provider et éventuelles données finales ; ne pas laisser un résumé précoce écraser le final.

- Les résumés ne sont pas des supports académiques exhaustifs ; bannière explicite sur lecture critique si couverture faible.

## 8. Notifications : fiabilité réelle, jamais trompeuse

- Canal A : centre d'alertes interne, toujours alimenté ; canal B : **Web Push PWA** avec souscription VAPID ; canal C : email de secours (optionnel, plus lent, clairement identifié comme non temps réel), configuré séparément si fourni.

- iPhone : installation sur écran d'accueil, mode web app, autorisation à la demande par action explicite ; afficher « test push validé » seulement si l'utilisateur confirme réception via UI. Ne pas promettre le Push pour un simple onglet Safari iOS.

- Payload push **par défaut discret** : « On te sollicite pendant ton cours » avec le titre du cours, pas de transcription sensible écran verrouillé. Si l'utilisateur active l'aperçu détaillé, avertissement de confidentialité.

- Un clic ouvre l'application sur alertId et propose « Rejoindre Zoom ». Si l'utilisateur est sur plusieurs appareils, gérer plusieurs subscriptions et idempotence des notifications par appareil.

- Le serveur doit enregistrer les tentatives, invalider les abonnements expirés, retry 429/5xx avec backoff borné, ne pas retry 4xx irréparables, et signaler les échecs.

- Aucune garantie de réception pendant mode Ne pas déranger, téléphone hors ligne, restrictions OS ou réseau défaillant. L'app doit toujours proposer test de réception avant un cours important.

- **Objectifs pilotes** : classification depuis event final vérifié vers alerte persistée p95 \< 2s ; de fin d'énoncé audible à notification visible p95 \< 15s **sur banc réseau défini**, dépendant du STT/OS et non contractuel ; 100% alertes retrouvables dans le centre après retour réseau.

## 9. Gestion des pannes, dégradation et récupération

- Échec de jointure : message avec sous-code fournisseur et prochaine action concrète (« hôte doit admettre », « enregistrement refusé », « lien invalide »). Pas de contournement des refus.

- Deux tentatives de création de bot concurrentes : transaction + clé métier unique + lease + réconciliation. Le provider peut ne pas garantir l'idempotence ; au doute, arrêt/réconciliation manuelle plutôt que création aveugle.

- Perte de webhook : des retries sont possibles mais **pas illimités** ; dead letter queue, alarme opérateur, compteur dernier événement, état dégradé, possibilité d'utiliser transcript final s'il est disponible. Ne jamais recréer a posteriori des alertes « en direct » comme si elles avaient été transmises.

- transcript.partial_data: seulement preview ; les versions temporaires se remplacent au lieu de se cumuler ; final réconcilie.

- Reconnexion serveur : persistance des jobs et événements ; vérifier progression/transcript final ; les transactions préservent déduplication.

- LLM 429/timeout : retry/backoff + circuit-breaker, mode heuristique, rapport reporté ou incomplet ; pas d'arrêt du webhook.

- Latence/silence : distinction entre salle silencieuse, bot muet, enregistrement arrêté, endpoint ne reçoit plus de données.

- Outils tiers : notification de perte de couverture de manière honnête, sans supposer que le cours était correctement suivi.

## 10. Exigences de sécurité, confidentialité et protection des données

26. **Authentification :** identités serveur validées ; cookies sécurisés HttpOnly/SameSite, CSRF selon schéma, TLS ; tests session expiration, fail closed.

27. **Autorisation :** isolation par userId, tests cross-tenant, pas d'accès à course/alert/devoir par guessing UUID.

28. **Secrets :** exclusivement côté serveur, manager d'environnement, jamais commit, jamais envoyés au frontend ou aux logs ; rotation prévue.

29. **Webhooks :** HMAC raw body, fenêtre d'horloge, constant-time compare, anti-replay persistant, limite de taille, contrôle des médias et d'origine lorsque pertinent, rate limit sans bloquer le fournisseur sain ; secrets hérités Svix traités selon doc du compte.

30. **Minimisation :** stocker d'abord transcript et metadata nécessaires, ne pas conserver vidéo/audio brut sans raison et sans choix clair ; auditer les réglages et politiques de conservation fournisseur (désactiver par défaut ce qui est possible).

31. **Chiffrement :** TLS, sauvegardes chiffrées, chiffrement applicatif des URL privées de réunions et éventuellement verbatim, rotation de clés planifiée ; accès administrateur exceptionnel audité.

32. **Rétention :** valeur par défaut V0 proposée 30 jours pour verbatim, 90 jours pour résumés/devoirs (configurable), à confirmer selon base légale et politique ; suppression et export, délais tiers expliqués.

33. **Gestion des tiers :** examiner régions et sous-traitants de Recall, Deepgram, modèle IA, hébergeur et emails ; pas de garantie d'hébergement UE sans vérification contractuelle.

34. **Injection LLM :** transcription, messages chat, titres de réunion et liens sont des entrées non fiables ; jamais d'instructions systèmes issues du contenu du professeur ou d'un étudiant ; aucun accès réseaux arbitraires depuis le modèle.

35. **Notices :** bot « Assistant IA de … — transcription et notes » si admissible ; message/notice transparente au démarrage et accord de l'hôte ; si refus, arrêter la collecte et signaler l'échec.

36. **Protection des mineurs :** si produit utilisé par des mineurs, contexte scolaire renforcé ; V0 limité à un utilisateur autorisé et non déployé largement avant revue juridique spécifique.

37. **Suppression de compte :** soft-delete technique transitoire uniquement si nécessaire à job de purge ; tests sur backups/rétention fournisseur séparés.

## 11. Non-fonctionnel, SLO pilotes et budgets

| **Dimension**      | **Objectif V0 vérifié**                                                                   |
|--------------------|-------------------------------------------------------------------------------------------|
| Disponibilité      | cible de test 99% de disponibilité pendant créneaux de test, sans SLA commercial          |
| Temps webhook HTTP | réponse 2xx p95 \< 500ms **après persistance**, sans classifier pendant HTTP              |
| Idempotence        | 1 webhook logique → max 1 événement final, 1 question logique → max 1 alerte active       |
| Détection          | recall \>=95% sur questions explicites et precision \>=90% sur corpus annoté et figé      |
| Détection ambiguë  | ne jamais présenter une inférence non sourcée comme certitude                             |
| Résumé             | 100% des points du rapport vérifiables via au moins une source ou marqués incomplets      |
| Devoirs            | \>=95% recall sur consignes explicites à rendre du jeu de référence ; 0 échéance inventée |
| Isolation          | 0 succès sur tests d'accès intercomptes/non authentifiés                                  |
| Charge             | 1 cours actif V0 ; tests d'événements accélérés 10x temps réel                            |
| Suivi du Push      | statut accepted_by_provider distinct de read/acknowledged                                 |
| Reprise            | crash worker/API au milieu d'un cours ne perd ni événement durable ni devoir validé       |

**Mesure :** jeux de données annotés manuellement avant calibration ; métriques par langue, audio dégradé, question explicite/ambiguë, prof/étudiants ; fausses alertes et questions manquées visibles dans dashboard QA. **Aucun logiciel ne peut être garanti sans bug** : les critères d'acceptation sont des garde-fous mesurables, pas une garantie absolue.

## 12. Stratégie de tests complète

### 12.1 Pyramid

- Tests unitaires (fonctions de validation et machine d'état, parser provider, règles, deadlines).

- Tests property-based sur URL, temps, alias, idempotence.

- Tests d'intégration Postgres réels (transactions, concurrent events, locks, TTL, isolement).

- Contract tests avec fixtures officielles Recall et schémas validés ; pas de « mocks magiques » inventés.

- E2E Playwright desktop/mobile viewport (onboarding, scheduling, live simulation, alert, devoir, suppression).

- Tests manuels sur iPhone physique avec PWA installée, arrière-plan, écran verrouillé, réseau coupé puis rétabli ; confirmation humaine de la réception.

- Tests Zoom réels **avec l'autorisation de l'hôte et des participants** et compte rendu de couverture.

- Tests de charge/recovery/replay/corruption contrôlés ; audits dépendances et secrets.

### 12.2 Corpus de validation minimum avant « terminé »

- **200 exemples annotés** de sollicitation : 50 directs FR, 30 directs EN, 40 mentions non directives, 30 questions adressées à tiers, 25 ambiguës, 25 accents/noms mal reconnus/conversations superposées.

- **80 exemples annotés** de consignes scolaires : explicite, facultatif, groupe, corrigé ensuite, dates relatives/contradictoires, manque d'énoncé, tableau/slides non lu, langue mixte.

- **30 cas de protocole** : replay, ordre inverse, duplicate partial/final, HMAC invalide, webhook retardé, crash, provider timeout, Push invalid, race cancel/create, DST, logout, purge.

- **3 cours Zoom réels de test autorisés**, dont un FR long (\>45m), un FR/EN, un avec interruptions/refus contrôlés dans un environnement test.

- Les corpus doivent être fictifs/synthétiques ou enregistrés avec autorisations ; ne jamais commiter du contenu privé non autorisé.

### 12.3 Gate de release (aucune exception silencieuse)

pnpm install --frozen-lockfile, pnpm lint, pnpm typecheck, pnpm test, pnpm test:integration, pnpm test:e2e, pnpm build, vérification secrets, migrations up/down, smoke déploiement, résultats d'éval et test Push iPhone réel. Si fournisseur indisponible, signaler explicitement **« Gate REAL-ZOOM non validé, V0 non finie »**.

## 13. Matrice de risques et de bugs — prévention, détection, test

Le but n'est pas de prétendre avoir listé *tous* les bugs possibles, mais de couvrir systématiquement les modes de panne majeurs. Toutes les lignes P0/P1 doivent avoir un test et/ou une alarme avant release.

| **ID** | **Gravité** | **Scénario de bug**                                         | **Prévention / détection / test bloquant**                          |
|--------|-------------|-------------------------------------------------------------|---------------------------------------------------------------------|
| Z01    | P0          | URL Zoom usurpée, domaine ressemblant                       | validation hostname/HTTPS, fuzz URLs, pas de fetch arbitraire       |
| Z02    | P1          | Lien expiré, passcode manquant, authentification exigée     | surface code échec et actions, fixture correspondante               |
| Z03    | P0          | Bot bloqué en salle d'attente                               | state waiting_room + timeout, avertir, ne pas prétendre enregistrer |
| Z04    | P0          | Consentement enregistrement refusé                          | pas de capture, état access_denied, audit et notice                 |
| Z05    | P1          | Le professeur commence en retard                            | handle host late et fenêtre d'attente configurable                  |
| Z06    | P0          | Requête create bot timeout, double création                 | lease + réconciliation + test race 100 requêtes                     |
| Z07    | P1          | Le cours déplacé annule la mauvaise occurrence              | UUID occurrence et clé schedule unique, tests récurrence            |
| Z08    | P1          | Changement heure d'été/hiver ou timezone erroné             | conversion IANA, tests DST fold/gap, affichage UTC/local            |
| Z09    | P1          | Retard + réessai créent un bot après annulation             | cancellation token/version, vérification transactionnelle           |
| Z10    | P1          | Expulsion du bot/reconnexion non détectée                   | lifecycle/webhook, terminal/degraded, reprise bornée                |
| E01    | P0          | Webhook falsifié accepté                                    | HMAC raw body + signature invalide tests                            |
| E02    | P0          | Webhook ancien rejoué                                       | fenêtre temporelle + unique ID base, tests replay                   |
| E03    | P1          | Payload géant épuise la mémoire                             | limite de taille à l'entrée, réponse contrôlée                      |
| E04    | P0          | Event reçu mais perdu après HTTP 2xx                        | insert + outbox transaction unique, kill test                       |
| E05    | P1          | Webhook en retry redouble transcriptions                    | unique(provider,id), idempotence test                               |
| E06    | P1          | Event out of order fait reculer état                        | state machine monotone + timestamps/version, tests                  |
| E07    | P0          | Événements ne sont plus livrés après trop d'échecs          | métrique lastEventAt, DLQ, dégradation visible, alarme              |
| E08    | P1          | Mauvaise distinction lifecycle et transcript                | routes/types séparés + contract tests                               |
| T01    | P1          | Parole fragmentée traitée comme plusieurs questions         | final vs partial, buffer, test incrémental                          |
| T02    | P1          | Même utterance final apparaît plusieurs fois                | stable key + contrainte DB, replay                                  |
| T03    | P1          | Noms des locuteurs changent en cours                        | IDs stables, alias de displayName, tests                            |
| T04    | P1          | Deux voix simultanées, attribution erronée                  | unknown-speaker, marque faible confiance                            |
| T05    | P1          | Silence de la classe pris pour panne audio                  | séparer absence parole/état fournisseur ; message prudent           |
| T06    | P1          | Vrai audio coupé sans statut de panne                       | coverage gaps heuristics + reconciliation, test interruption        |
| T07    | P1          | Français et anglais mélangés                                | STT multi + corpus code-switch + langue de sortie FR                |
| T08    | P1          | Mot technique et prénom mal reconnus                        | aliases phonétiques contrôlés, terme list, éval dédiée              |
| T09    | P2          | Long cours fait exploser mémoire/contexte                   | chunking persistent + streaming + tests 3h                          |
| A01    | P0          | « Liam a dit » déclenche urgence                            | negative rules + corpus précision                                   |
| A02    | P0          | Question directe ignorée                                    | recall corpus, seuils, éval live, fallback règles                   |
| A03    | P1          | « Et toi ? » sans cible provoque alerte certaine            | class ambiguous, jamais urgent certain sans preuve                  |
| A04    | P1          | Question citée dans un exemple                              | détecter citations et discours rapporté, fixtures                   |
| A05    | P1          | Consigne de groupe confondue avec question personnelle      | assign vs addressed, tests                                          |
| A06    | P1          | Reformulation crée 5 push                                   | groupe sémantique temporel, dedupe key                              |
| A07    | P1          | Prompt injection dans la transcription                      | données non fiables, schema outputs, adversarial tests              |
| A08    | P0          | L'IA répond oralement au nom de l'étudiant                  | absence totale de canal output audio, test architecture             |
| N01    | P0          | App croit Push actif mais abonnement absent                 | onboarding gate, test subscription/ack                              |
| N02    | P1          | Safari iOS non installé PWA → push impossible               | détection + instructions Add to Home Screen                         |
| N03    | P1          | Push service accepte mais téléphone ne voit rien            | état accepted≠delivered, test device réel                           |
| N04    | P1          | Abonnement expiré/revoqué                                   | nettoyage 404/410, état dégradé                                     |
| N05    | P1          | Plusieurs appareils reçoivent les mêmes alertes non voulues | prefs/device labels, outbox per-device, unique attempts             |
| N06    | P0          | Push sensible sur écran verrouillé                          | notification discrète par défaut, test payload                      |
| N07    | P1          | Alerte 10 min après la fin présentée comme live             | TTL, mention « tardive », audit time                                |
| N08    | P2          | Ne pas déranger/offline cachent l'alerte                    | message honnête et centre d'alertes persistant                      |
| S01    | P0          | Résumé invente la présentation non entendue                 | provenance obligatoire + limitations visibles                       |
| S02    | P0          | Devoir « à rendre » oublié                                  | corpus extraction recall + section consignes dédiée                 |
| S03    | P0          | Date inventée à partir de « bientôt »                       | due certainty/nullable, tests date parser                           |
| S04    | P1          | « pas à rendre » compris « à rendre »                       | tests négation, schema type, human confirm                          |
| S05    | P1          | Prof corrige une échéance plus tard                         | chronology merge + conflicting evidence                             |
| S06    | P1          | Travail facultatif affiché obligatoire                      | optional field + tests                                              |
| S07    | P1          | Plusieurs cours mélangent leurs devoirs                     | partition occurrenceId + tests isolation                            |
| S08    | P1          | Synthèse 2h tronquée par tokens                             | map-reduce + coverage checks                                        |
| S09    | P1          | Rapport « complet » sur flux partiel                        | coverage state + gate completed_partial                             |
| S10    | P1          | Résumé provisoire remplace rapport final                    | immutabilité par version, CAS                                       |
| S11    | P2          | Exercice mentionné sur slide non capturée                   | visual_reference flag, ne pas inventer consigne                     |
| Q01    | P0          | Accès aux cours d'un autre compte via UUID                  | authz systématique + tests cross-user                               |
| Q02    | P0          | Clés Recall/LLM exposées au client                          | secret scan + env server only                                       |
| Q03    | P0          | Transcription personnelle dans logs/erreurs                 | redaction centralisée + inspection logs                             |
| Q04    | P1          | Suppression de cours mais jobs ressuscitent données         | tombstones/version + purge test                                     |
| Q05    | P1          | Webhook provider reconstruit données supprimées             | tombstone denylist/expiry, delete replay test                       |
| Q06    | P1          | Texte du cours commande au LLM d'exfiltrer                  | untrusted boundary, pas de tools, injection eval                    |
| Q07    | P1          | Prompt export HTML/XSS via nom d'intervenant                | escaping côté UI, CSP, tests XSS                                    |
| Q08    | P1          | Incohérence rétention app/Recall                            | purge contract, fournisseurs audités et limitation explicitée       |
| O01    | P1          | Déploiement sans migration                                  | startup check schema, gating release                                |
| O02    | P1          | Worker redémarre au milieu du cours                         | durable jobs/leases, chaos test                                     |
| O03    | P1          | LLM en surcharge bloque l'ingestion                         | queue séparation et circuit breaker                                 |
| O04    | P1          | Bogue de production invisible jusqu'au prochain cours       | healthchecks + Sentry/metrics + alerts observability                |
| O05    | P1          | Test « tout vert » car tout mocké                           | vrai Gate Zoom autorisé obligatoire et rapport explicite            |

## 14. API de surface et validation

| **Méthode** | **Route**                   | **Auth**         | **Contrat**                                            |
|-------------|-----------------------------|------------------|--------------------------------------------------------|
| POST        | /api/courses                | oui              | crée cours, URL/date/notice validés                    |
| GET         | /api/courses                | oui              | liste limitée au propriétaire                          |
| GET         | /api/courses/:id            | oui              | détail et occurrences du propriétaire                  |
| PATCH       | /api/courses/:id            | oui              | modifications autorisées selon état/version            |
| POST        | /api/occurrences/:id/cancel | oui              | annulation idempotente et provider cancel, status réel |
| GET         | /api/occurrences/:id/live   | oui              | état/dernières utterances/alertes                      |
| GET         | /api/occurrences/:id/report | oui              | source et couverture                                   |
| GET         | /api/alerts                 | oui              | alertes utilisateur, pagination                        |
| POST        | /api/alerts/:id/ack         | oui              | accusé utilisateur authentifié                         |
| GET / PATCH | /api/assignments\[/:id\]    | oui              | liste/modification, source préservée                   |
| POST        | /api/push/subscribe         | oui              | auth + endpoint keys validés                           |
| POST        | /api/push/test              | oui              | envoi test avec rate-limit                             |
| DELETE      | /api/data/occurrences/:id   | oui              | purge/délai documenté                                  |
| POST        | /webhooks/recall/realtime   | signature Recall | intake brut signé, outbox idempotente                  |
| POST        | /webhooks/recall/lifecycle  | signature Recall | lifecycle/status, idempotence, ordre                   |
| GET         | /health/live                | public limité    | liveness sans secrets                                  |
| GET         | /health/ready               | interne/protégé  | DB/worker/providers et version de schéma               |

**Realtime UI** : SSE sécurisé et rechargement progressif (ou polling borné si SSE indisponible), reconnect avec Last-Event-ID, aucune exposition cross-tenant. Toutes les routes valident entrées/sorties Zod, pagination, limites, erreurs standard {code, message, requestId} sans leak.

## 15. Observabilité / runbook

- Métriques : course_join_attempt_total, course_join_refused_total, webhook_verified_total, webhook_rejected_total, provider_event_lag_seconds, transcript_last_received_age, attention_decisions_total, attention_false_positive_feedback, notification_accept_lag, push_error_total, report_finalize_failed, queue_depth, dead_letter_total, provider_cost_eur_estimate.

- Logs structurés corrélés par requestId, occurrenceId, jobId ; **sans texte transcrit** ni email en clair par défaut.

- Runbooks JOIN_FAILED, WEBHOOK_SILENT, STT_DEGRADED, PUSH_NOT_ACTIVE, LLM_DOWN, SCHEDULE_MISSED, DELETE_FAILED, PROVIDER_COST_SPIKE avec symptômes, cause, action, reprise, limitation.

- Budget plafonné par cours et utilisateur ; pas de boucle d'appels LLM ni multiplication de bots payants ; alertes coût provider.

## 16. Priorisation et phasage

**P0 indispensable V0** : identité utilisateur, scheduling, autorisation, vrai bot Zoom, tracking de statut, transcript FR/EN vérifié, mention directe, Push installé/testé, résumé sourcé, devoirs à confirmer, robustesse webhook, sécurité, tests Zoom réel.

**P1 souhaitable dans V0** : récurrence hebdomadaire, resynchronisation après interruption, email de secours, interface d'évaluation des faux positifs, export Markdown, purge self-service.

**P2 hors V0** : ingestion native des slides (nécessite flux vidéo/partage écran autorisé), quiz automatique, flashcards, prise de notes graphiques/équations manuscrites, Google Classroom, Moodle, bots sur Meet/Teams, automatisation de réponse.

Un P1 qui se révèle nécessaire pour protéger une promesse P0 (par exemple la récupération après coupure) remonte en P0 au cours de l'implémentation.

## 17. Plan de déploiement et conditions de vérité

38. Local demo : corpus simulé, pas de Zoom réel, interface explicitement « simulation ».

39. Private staging : base séparée, secrets propres, bot Recall sandbox/compte dédié, URL webhook HTTPS stable, Zoom avec hôte consentant.

40. Pilot privé : cours réels autorisés en FR/EN, iPhone physique, collecte anonymisée des métriques et erreurs.

41. V0 release seulement après **Gate final** et confirmation explicite que les intégrations sont actives. Tout échec non résolu reste documenté et release bloquée.

**Livrables de la V0 codée :** code versionné, migrations, suite de tests, rapport éval et corpus de tests, démo, dashboard fonctionnel, dashboard d'observabilité, guide déploiement, guide d'usage, limitations, manifeste fournisseurs/données, rapport de test Zoom réel, registre bugs résiduels.

## 18. Décisions architecturales figées (ADR)

- ADR-01 : V0 = Zoom, Recall.ai, Deepgram FR/EN ; RTMS reporté.

- ADR-02 : Next.js + Fastify + worker + Postgres ; pas de backend « tout en mémoire » en production.

- ADR-03 : notifications Web Push sur PWA iOS avec confirmation test ; pas de push garanti par simple navigation Safari.

- ADR-04 : transcript.data final est la source canonique du résumé, partial_data ne peut que prévisualiser.

- ADR-05 : pas de participation simulée, pas de prise de parole ni d'émargement.

- ADR-06 : à chaque événement important une preuve horodatée et un statut d'incertitude ; les résultats pédagogiques sont contrôlables.

- ADR-07 : interdiction de déployer si sécurité, intégration Zoom autorisée, Push réel ou tests de sortie V0 non vérifiés.

## 19. Questions de dépendance / contraintes externes — non résolues par le code

- Autorisation de l'établissement/professeur d'ajouter le bot ; restrictions Zoom des comptes institutionnels et du pays.

- Disponibilité et coûts des comptes Recall/Deepgram et de l'hébergement sécurisé ; clés jamais fournies dans le prompt Codex.

- Le fournisseur de transcription peut omettre des éléments, échouer ou introduire une latence ; qualité variable selon microphone, accent, chevauchement.

- L'interprétation des cours qui s'appuient fortement sur des slides/schéma/équations visuelles restera **partielle en V0** (V0 audio+texte). Le compte rendu doit le reconnaître.

- Une alerte envoyée n'est pas toujours vue ; la politique de l'iPhone/réseau/Mode concentration reste souveraine.

## 20. Annexes — documentation officielle vérifiée le 14 octobre 2026

- Recall.ai — bot real-time transcription : https://docs.recall.ai/docs/bot-real-time-transcription

- Recall.ai — Deepgram en streaming multilingue : https://docs.recall.ai/docs/deepgram

- Recall.ai — real-time webhook endpoints et retries : https://docs.recall.ai/docs/real-time-webhook-endpoints

- Recall.ai — vérification HMAC et secrets historiques : https://docs.recall.ai/docs/authenticating-requests-from-recallai

- Recall.ai — bot lifecycle events : https://docs.recall.ai/docs/bot-status-change-events

- Recall.ai — enregistrement/autorisation Zoom : https://docs.recall.ai/v1.10/docs/zoom-recording-consent

- Recall.ai — Bot creation et calendrier join_at : https://docs.recall.ai/docs/agent-quickstarts

- Zoom — RTMS officiel : https://developers.zoom.us/docs/rtms/meetings/getting-started/

- Zoom — Meeting SDK explicitement non prévu pour les bots : https://developers.zoom.us/docs/meeting-sdk/

- Apple — Push PWA iOS ajouté à l'écran d'accueil : https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers

**À revalider avant intégration effective :** formes de payloads et autorisations, politiques commerciales, compatibilité exacte des versions, traitement régional et contrats. Ne pas inventer des paramètres API nouveaux : commencer par les exemples officiels et tests avec événements réellement capturés et anonymisés.

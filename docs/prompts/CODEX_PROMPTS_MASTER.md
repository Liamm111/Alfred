# AI Course Assistant — Prompts Codex / Claude, blocs 00 à 19

Exécuter **un seul bloc à la fois**, dans l’ordre. Coller le prompt du fichier correspondant dans Codex. Les blocs utilisent le PRD version 0.2 hybride comme seule source de vérité ; ils **remplacent** les prompts de l’ancienne version bot et Mac-only.

# PROMPT DE BASE — à inclure dans TOUS les blocs

Tu es l’équipe de développement senior (macOS Swift, Zoom RTMS, TypeScript, sécurité et QA) de **AI Course Assistant**. Tu prends comme contrat immuable `PRD_V0_SOURCE_OF_TRUTH.md` (version 0.2 RTMS+Mac) et `ARCHITECTURE_ADR.md`. Tu dois lire le repo existant avant toute modification.

**Invariants non négociables :**
- L'utilisateur rejoint son cours via son compte Zoom existant. Aucun participant/bot supplémentaire, aucun Meeting SDK pour l'IA notetaker, aucune connexion Zoom simulée, aucun avatar et aucune réponse à sa place.
- Sources RTMS uniquement si scopes/hôte autorisent ; source locale via ScreenCaptureKit uniquement avec consentements adaptés, **jamais pour contourner une interdiction explicite**. Ne jamais prétendre lire ce qui n'a pas été capté.
- Ne jamais masquer indicateurs Zoom ou Apple de capture; ne demander que les permissions nécessaires et prévoir Stop-All immédiatement fonctionnel.
- Toute note, devoir, question a des preuves persistées ; aucune date, personne ou contenu non prouvé affirmé comme certain.
- Chaque flux a santé, provenance, timestamps, gaps, et états offline/degraded ; pas de `LIVE` basé sur une simple connexion ou webhook.
- Auth stricte, idempotence, secrets exclus du code/logs, tests automatisés, pas de break de PRD sans ADR et justification.

**Process obligatoire par bloc :**
1. Inventorier le code concerné et le PRD ; expliciter hypothèses, interfaces, migrations, dépendances et risques.
2. Implémenter verticalement du plus petit contrat au test E2E, conserver la compatibilité des parties saines.
3. Écrire tests unitaires, intégration, cas négatifs/permissions, migration et logs redacted. Exécuter réellement les commandes accessibles.
4. Ne jamais remplacer une preuve de Zoom RTMS ou d’iPhone réel par un mock. Si les accès ou machines manquent, statut `BLOCKED`, étapes manuelles exactes, et rapport honnête.
5. À la fin, produire `reports/BLOC_XX.md` avec : objectif, fichiers changés, migrations, tests lancés et résultats, preuves réelles ou simulées clairement distinguées, sécurité, bugs ouverts, verdict `PASS / FAIL / BLOCKED`, commandes du bloc suivant. Ne pas auto-déclarer « fini/sans bug ».
6. Ne pas passer au bloc suivant automatiquement en cas de FAIL/BLOCKED critique.

**Structure cible :** apps/mac/, apps/zoom-surface/, apps/web/, services/api/, services/rtms-gateway/, services/workers/, packages/contracts/, packages/ai/, db/, tests/, docs/, reports/.



---

# BLOC 00 — Audit initial et gel des invariants

**Mission :** Inspecter tout le dépôt existant, classer le code ancien lié aux bots et construire le plan de migration sans casser les tests utiles.

**Livrables techniques obligatoires :**
- Créer docs/audit.md avec arbre des dépendances, composants réutilisables et risques.
- Rechercher et classifier tous usages Recall.ai, meeting bots, joinMeeting, Meeting SDK et démarrages automatiques.
- Introduire un feature flag bot_join=false sans voie de réactivation ; aucune dépendance ne doit démarrer une autre identité Zoom.
- Poser monorepo apps/mac, apps/zoom-surface, apps/web, services/api, services/rtms-gateway, services/workers, packages/contracts, tests.

**Vérifications obligatoires :**
- CI existante passe ; grep/AST interdit les appels de jonction participant ; architecture ADR écrite ; pas de secrets dans repo.

**Risque spécifique / fail-safe :** Ne pas supprimer aveuglément les tests/funcs utiles de transcription et alertes ; archiver seulement le code interdit.

**Fin du bloc :** rapport `reports/BLOC_00.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 01 — Contrats typés et machine d’états

**Mission :** Définir les sources de vérité contractuelles avant toute intégration ; rendre impossible un état LIVE mensonger.

**Livrables techniques obligatoires :**
- Écrire schemas Zod/JSON schema et types TS/Swift cohérents: session, capture source, packet, evidence, gap, alert, assignment.
- Implémenter state machine IDLE→DETECTED→PERMISSION→CONNECTING→LIVE_*→DEGRADED→PAUSED/RECOVERING→FINALIZING→COMPLETED/PARTIAL/FAILED.
- Définir freshness thresholds par modalité, stop-all atomique, source_epoch, clocks, validation transitions.
- Versionner API/events et fournir fixtures publiques non sensibles.

**Vérifications obligatoires :**
- Tests exhaustifs de transitions invalides, silence, packet expiré, double Stop, audio seul, vidéo seule, deux sessions.

**Risque spécifique / fail-safe :** Un callback started/connecté ne prouve jamais réception de média.

**Fin du bloc :** rapport `reports/BLOC_01.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 02 — Base PostgreSQL, migrations et isolation

**Mission :** Persister séquences, preuves, jobs et permissions utilisateur sans fuite croisée.

**Livrables techniques obligatoires :**
- Créer schéma du PRD avec migrations up/down, uniques pour idempotence, owner, timestamps, indices.
- Activer isolation par utilisateur en DB (RLS si stack adaptée), contrôles d’accès API, contraintes cascade et suppression vérifiable.
- Préparer transaction+outbox, encrypted secrets refs, retention job, optimistic concurrency.
- Ajouter seed de test uniquement avec données synthétiques.

**Vérifications obligatoires :**
- Test accès cross-user interdit, doublon clé idem, suppression et FK, race conditions, rollback migration.

**Risque spécifique / fail-safe :** Ne pas stocker les raw audio ou images par défaut.

**Fin du bloc :** rapport `reports/BLOC_02.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 03 — Authentification produit et connexion Zoom

**Mission :** Garder séparées identité produit, identité Zoom et preuve de participant réel.

**Livrables techniques obligatoires :**
- Ajouter auth produit HTTPS+PKCE / session renouvelable; clés locales dans Keychain.
- Connecter OAuth Zoom scopes strictement nécessaires, state/nonce anti-CSRF, refresh rotation, révocation.
- Créer mapping produit_user↔zoom_user_id et association éphémère signée meeting_uuid/stream_id avec contrôle d’owner.
- Interdire de faire confiance au nom de fenêtre/participant comme preuve.

**Vérifications obligatoires :**
- Tests OAuth rejeu, mismatch compte, expiration, refresh concurrent, logout, tentative d’appropriation autre meeting.

**Risque spécifique / fail-safe :** Jamais démarrer RTMS pour quelqu’un d’autre ni injecter token Zoom dans client non autorisé.

**Fin du bloc :** rapport `reports/BLOC_03.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 04 — Compagnon Mac natif SwiftUI

**Mission :** Bâtir le menu bar app utilisable avant d’implémenter la capture.

**Livrables techniques obligatoires :**
- Créer app SwiftUI + AppKit pour menu bar et fenêtre principale ; icône + statuts lisibles.
- Détection processus/fenêtres Zoom uniquement comme indice, boutons explicites Start/Pause/Resume/Stop, Onboarding/Diagnostics.
- Permissions macOS en états distincts, cycle de vie sleep/wake/lock, focus Zoom uniquement après clic.
- Runtime signable/notarisable ultérieurement, logs redacted.

**Vérifications obligatoires :**
- Tests UI état de permission refusée, stop-all, redémarrage app ; build Mac obligatoire (sinon BLOCKED).

**Risque spécifique / fail-safe :** Ne jamais automatiser la connexion ou le micro/caméra Zoom.

**Fin du bloc :** rapport `reports/BLOC_04.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 05 — Zoom App intégrée pour lancer RTMS

**Mission :** Faire démarrer l’accès RTMS depuis la session réelle de l’utilisateur, sans nouveau participant.

**Livrables techniques obligatoires :**
- Créer Zoom Surface App minimale avec Zoom Apps SDK; initialisation support/version, startRTMS/stopRTMS si disponible.
- Gestion host approval, denied, disabled, guest meeting, Zoom Apps unavailable.
- Renvoyer uniquement association de session signée / nonce court au backend, ne pas exposer tokens secrets.
- Documenter installation dans le compte personnel, scopes, Marketplace et compte de test.

**Vérifications obligatoires :**
- Tests mocked SDK + script MANUAL_REAL_ZOOM montrant même liste de participants avant/après, request/approve/deny.

**Risque spécifique / fail-safe :** Les appels REST ne sont option que si conditions officielles (notamment invitee + participant rejoint) remplies ; ne pas les traiter comme solution universelle.

**Fin du bloc :** rapport `reports/BLOC_05.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 06 — Gateway Zoom RTMS officielle

**Mission :** Recevoir les données Zoom associées au profil présent avec intégrité et traçabilité.

**Livrables techniques obligatoires :**
- Intégrer @zoom/rtms Node SDK stable en version verrouillée.
- Valider signature webhook et timestamp avant traitement, `meeting.rtms_started/stopped`, réconcilier webhook/connection.
- Extraire audio par participant, transcript, partage et chat si scopes réels ; normaliser formats et source ID, timestamps.
- Backoff exponentiel avec jitter, keepalive, source_epoch, gap tracing, limites concurrence, dead-letter.

**Vérifications obligatoires :**
- Tests signature correcte/fausse/rejeu, out-of-order, démarrage sans média, socket perdue, formats incompatibles, STOP host, quotas.

**Risque spécifique / fail-safe :** RTMS n’est pas une capture de l’écran personnel : ne pas lui attribuer des contenus privés ou non partagés.

**Fin du bloc :** rapport `reports/BLOC_06.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 07 — Capture audio native macOS autorisée

**Mission :** Acquérir l’audio sortant réellement reçu par le Mac quand les permissions du cours le permettent.

**Livrables techniques obligatoires :**
- Implémenter ScreenCaptureKit sélection de contenu et config capturesAudio=true, option micro séparée consentie.
- Horodatages monotones; conversion audio vers PCM stable; ring buffer chiffré borné; santé bitrate et silence.
- Sélection explicite fenêtre/application/écran ; tests avec casque/Bluetooth/haut-parleur ; détecter pollution autre app.
- Interrupteur global Stop arrête immédiatement audio/micro et purge buffer selon politique.

**Vérifications obligatoires :**
- Tests fixture sample buffers + MANUAL Mac Zoom haut-parleur, AirPods, changement sortie, écho, audio absent ; rapports à fournir.

**Risque spécifique / fail-safe :** On ne considère pas par hypothèse que le filtre fenêtre isole parfaitement le flux audio Zoom : valider réellement.

**Fin du bloc :** rapport `reports/BLOC_07.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 08 — Vision Mac, fenêtres Zoom et OCR

**Mission :** Capturer seulement ce que l’utilisateur a choisi de partager au moteur.

**Livrables techniques obligatoires :**
- SCContentSharingPicker, sélection fenêtre Zoom et fenêtre écran partagé, détecter apparition/disparition.
- Capture frames à fréquence limitée/change-detection, Vision OCR local; frame hashes + quality score et preuves horodatées.
- Gestion fenêtre réduite, autre Space, deuxième écran, texte minuscule, flou, multi-fenêtre.
- Aucun enregistrement vidéo continu ; image persistée facultative et TTL court.

**Vérifications obligatoires :**
- Tests slides avec changements, Zoom minimisé/caché, partage full screen, OCR lisibilité, permission retirée, contenu non Zoom exclu.

**Risque spécifique / fail-safe :** Si une diapositive est invisible, l’IA dit « indisponible » plutôt que d’inventer.

**Fin du bloc :** rapport `reports/BLOC_08.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 09 — Normalisation, alignement et fusion

**Mission :** Fusionner RTMS et Mac sans confondre intervenants, dédoubler la transcription ou masquer les trous.

**Livrables techniques obligatoires :**
- NormalizedEvidence contract unique audio/transcript/OCR; canonical event order, offsets UTC et timebase media.
- Chaque source garde provenance, source_epoch, health, freshness et segments de gap.
- RTMS préféré si attesté ; fallback local permis pour modalités manquantes; éviter doublon par overlap + texte + speaker quand connu.
- Cache/replay local borné quand réseau indisponible ; interdiction de fusion de deux réunions.

**Vérifications obligatoires :**
- Tests dérive +1min, source reconnectée, doublons audio similaires, changement de source au milieu d’une question, deux meetings.

**Risque spécifique / fail-safe :** Jamais basculer pour contourner une interdiction explicite de capturer/analyser le cours.

**Fin du bloc :** rapport `reports/BLOC_09.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 10 — STT multilingue et diarisation honnête

**Mission :** Produire segments FR/EN fiables et attribués seulement quand vérifiés.

**Livrables techniques obligatoires :**
- Adapter STT temps réel interchangeable, native RTMS transcription si suffisante sinon STT audio ; gérer français, anglais, code switching.
- Final vs provisional, corrections de phrases, punctuations, speaker IDs RTMS/UNKNOWN en local.
- Segmenter par sentence/time, merger avec evidence ids, confidence, latences et budgets.
- Tester audio bruité, noms propres, terminologie, homophones, longues pauses.

**Vérifications obligatoires :**
- Corpus 30 min + 3h ; aucun segment provisoire compté final ; aucun speaker inventé.

**Risque spécifique / fail-safe :** Ne jamais exposer transcription partielle comme témoignage certain.

**Fin du bloc :** rapport `reports/BLOC_10.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 11 — Moteur d’interpellations temps réel

**Mission :** Identifier rapidement qui est sollicité sans pousser sur une simple mention.

**Livrables techniques obligatoires :**
- Préfiltre alias, vocatifs, impératifs et pronoms; contexte 15–60 s ; LLM structuré avec score, reason codes et evidence.
- Classes DIRECT_CERTAIN, DIRECT_PROBABLE, MENTION_SIMPLE, GROUPE, HORS_SUJET; déduplication des relances.
- Déclenchement rapide sur règles pour appels explicites puis enrichissement non bloquant.
- Feedback faux positif/raté et version du moteur.

**Vérifications obligatoires :**
- Corpus ≥100 cas FR/EN: nom évoqué, homophones, questions indirectes, prénom absent, plusieurs Liam, phrases annulées.
- Une unique alerte directe par question dans le corpus ; aucune urgence pour mention dans le corpus.

**Risque spécifique / fail-safe :** Trace d’incertitude, jamais garantie de tout détecter.

**Fin du bloc :** rapport `reports/BLOC_11.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 12 — Outbox, push iPhone et alertes Mac

**Mission :** Créer une voie d’alerte observable même sous panne ou réseau intermittent.

**Livrables techniques obligatoires :**
- Écrire outbox transactionnelle, retry borné, idempotence par address_event et canal.
- Mac UserNotifications + PWA Web Push VAPID; onboarding Apple écran accueil et geste utilisateur.
- Séparer créé/envoyé/accepté push/ack device/vu; purge abonnements expirés, email absent V0.
- Action Ouvrir Zoom active uniquement au clic.

**Vérifications obligatoires :**
- Tests race, 429, 410/404, push token expiré, Focus iOS, écran verrouillé ; capture preuve iPhone réel.

**Risque spécifique / fail-safe :** HTTP 201 du push gateway ne prouve pas lecture par l’utilisateur.

**Fin du bloc :** rapport `reports/BLOC_12.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 13 — Vue en direct et observabilité

**Mission :** Offrir une vue exacte des modalités disponibles et des événements utiles.

**Livrables techniques obligatoires :**
- Web live via SSE/WebSocket authentifié, source statuses RTMS/Mac, gaps, latence, segments, alertes.
- Mobile et desktop layouts dédiés, écran vide, chargement, failed/partial, haut contraste et clavier.
- Contrôles de consentement, téléchargement désactivé si policy, pause/stop reflétés sur toutes sessions.
- Telemetry technique sans PII.

**Vérifications obligatoires :**
- E2E changements de statuts, 403 user différent, reconnect UI, offline, slow connection, double onglet.

**Risque spécifique / fail-safe :** Ne jamais afficher le badge LIVE si source stale.

**Fin du bloc :** rapport `reports/BLOC_13.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 14 — Synthèse pédagogique sourcée

**Mission :** Construire un compte rendu utile mais incapable d’inventer des passages absents.

**Livrables techniques obligatoires :**
- Extraction incrémentale sujets/notions/exemples/decisions avec evidence_ids ; version finale consolidée.
- Validator rejette assertions importantes sans preuves ; couverture audio/visuel et gaps dans chaque rapport.
- Différencier parole du prof, slide OCR, commentaire étudiant, hypothèse incertaine.
- Exporter Markdown avec liens de sources internes et horodatages.

**Vérifications obligatoires :**
- Corpus passages manquants, contradiction vocale/slide, OCR faux, silence 15min, instructions malveillantes dans transcript.

**Risque spécifique / fail-safe :** Si capture insuffisante, sortie PARTIAL/UNAVAILABLE au lieu d’inventer.

**Fin du bloc :** rapport `reports/BLOC_14.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 15 — Travaux, échéances et contradictions

**Mission :** Extraire les devoirs sans fabriquer de date ni attribuer un exercice au mauvais étudiant.

**Livrables techniques obligatoires :**
- Détecter devoir à rendre/faire/lire/réviser, propriétaire moi/classe/autre/inconnu, dates originales.
- Parser date avec date du cours + timezone, gérer DST, ambiguïté vendredi, modifications tardives et annulations.
- Chaque devoir conserve evidence_ids et champ `due_at` nullable, validation manuelle/révisions.
- UI liste et détails avec statut, edits versionnés, lien source.

**Vérifications obligatoires :**
- Corpus ≥50 : vendredi prochain, 3 jours, seulement groupe B, devoir annulé, date contradictoire sur slide, vacances.

**Risque spécifique / fail-safe :** Une date impossible ou incertaine reste null et « à confirmer ».

**Fin du bloc :** rapport `reports/BLOC_15.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 16 — Confidentialité, conformité et suppression

**Mission :** Garantir que la V0 ne recueille rien silencieusement et efface les données à la demande.

**Livrables techniques obligatoires :**
- Consent gate par séance ; policies de capture par cours ; pas de fallback local après interdiction de collecte.
- Threat modeling STRIDE, sécurité OAuth/Zoom signatures, CSRF/CSP, encryption, secret rotation, suppression réversible seulement si permis.
- TTL par classe (audio brut éphémère, images courts, textes paramétrés), retrait consentement et purge cohérente.
- Redacted logs, analytics PII-safe, procédure d’incident, usage politique école.

**Vérifications obligatoires :**
- Tests leak par API/log, retrait de consentement pendant stream, Stop-All, clé volée, transcription prompt injection, deletion cascade.

**Risque spécifique / fail-safe :** Pas de capture « invisible » ou de bypass de contrôles hôte.

**Fin du bloc :** rapport `reports/BLOC_16.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 17 — Reprises, performances et coût

**Mission :** Rendre tolérables les pannes sans mensonge sur la complétude du suivi.

**Livrables techniques obligatoires :**
- Chaos suite : coupure RTMS, drop frames, réseau Mac perdu, iPhone offline, app restart, sleep/wake, disk full.
- Backpressure et queues durables, quotas et circuit breakers OCR/STT/LLM, budget par session, alerting.
- Mesurer CPU/mémoire/batterie, streaming latence p50/p95, longueur gaps, source freshness.
- Produire document SLOs et limites connues.

**Vérifications obligatoires :**
- Charge 180min et 3 flux, injection doublons aléatoires, stop durant reconnect, crash worker ; zéro perte silencieuse.

**Risque spécifique / fail-safe :** Ralentir l’OCR ou l’enrichissement IA en priorité plutôt que la détection d’alerte.

**Fin du bloc :** rapport `reports/BLOC_17.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 18 — Pilote Zoom et iPhone physique

**Mission :** Prouver sur le terrain les propriétés qui ne peuvent pas être testées en mock.

**Livrables techniques obligatoires :**
- Configurer un compte Zoom autorisant RTMS et un hôte de test ; documenter scopes, nombre de participants avant/après.
- Tester réunion externe avec professeur ayant activé/refusé les droits, session link-only, la Zoom App intégrée, fallback Mac autorisé.
- Mac: casque, haut-parleur, fenêtre partage, écran externe, minimize, app sleep, refus de permission.
- iPhone: PWA installée, écran verrouillé, push direct, context, opened event ; résumé final avec devoir oral/visuel.

**Vérifications obligatoires :**
- Livrer rapport avec heure, version, captures non sensibles, p95, incidents et conclusion GO/NO-GO pour chaque mode.

**Risque spécifique / fail-safe :** Si pas de Mac/iPhone/compte Zoom, écrire BLOCKED : pas de succès fictif.

**Fin du bloc :** rapport `reports/BLOC_18.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.


---

# BLOC 19 — Release privé, audits et décision V0

**Mission :** Fournir un build vérifié et une procédure d’installation reproductible.

**Livrables techniques obligatoires :**
- Passer tests automatisés, static analysis, dépendances, threat model, scripts release, rollback.
- Installer build macOS signé/notarisé quand possible, guide PWA iPhone et configuration RTMS + mode local.
- Rédiger release notes, known issues, matrice macOS/Zoom/iOS, manuel dépannage, plan de monitoring.
- Déclencher GO seulement si critères PRD section K satisfaits, sinon NO-GO et remediation queue.

**Vérifications obligatoires :**
- Audit final prouve aucune identité Zoom ajoutée, capture non-autorisé bloquée, E2E réel, aucune fausse complétude, suppression.

**Risque spécifique / fail-safe :** Ne pas annoncer « sans bug » ; annoncer limites observées.

**Fin du bloc :** rapport `reports/BLOC_19.md` avec PASS/FAIL/BLOCKED fondé sur les preuves, tests exécutés, logs expurgés, dettes et GO/NO-GO.

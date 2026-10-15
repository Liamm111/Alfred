# BLOC 06 — Gateway Zoom RTMS officielle

**Verdict : PASS (tests automatisés, SDK réel chargé) · BLOCKED (flux RTMS réel non exercé)** · **GO/NO-GO : GO conditionnel.**

## Livrables
| Exigence | Statut | Preuve |
|---|---|---|
| `@zoom/rtms` stable, version verrouillée | PASS | `services/rtms-gateway/package.json` : `"@zoom/rtms": "1.1.0"` (exact) + `pnpm-lock.yaml` ; test lit la version installée (1.1.0) et vérifie l'API (`join/leave/onAudioData/onTranscriptData/onDeskshareData/onJoinConfirm/onLeave/setAudioParams/onSharingEvent`) et que tous les motifs d'arrêt « terminaux » existent dans `StopReason`. Binaire natif linux‑x64 chargé ici (SDK annonce darwin‑arm64 et linux‑x64 seulement). |
| Signature webhook + timestamp avant traitement | PASS | `webhook.js` : HMAC‑SHA256 sur `v0:{ts}:{rawBody}`, `timingSafeEqual`, tolérance ±5 min, anti‑rejeu (cache posé **après** authentification). On n'utilise **pas** `rtms.onWebhookEvent` (n'authentifie pas). Test HTTP : webhook falsifié n'atteint jamais le manager. Réponse `endpoint.url_validation` implémentée. |
| `meeting.rtms_started/stopped` + réconciliation | PASS | `session-manager.js` ; `reconcile()` détecte webhook sans connexion et connexion après stop ; tombstones contre « started » tardif/dupliqué. |
| Audio par participant, transcript, partage, chat | Audio ✔ · Transcript ✔ · Partage ✔ (cadres bruts) · **Chat ✘** | Audio L16/16 kHz/mono, `AUDIO_MULTI_STREAMS` ⇒ `source_id` par participant. **Le SDK Node 1.1.0 n'expose pas de callback chat** (constante seule) : documenté, normaliseur `chat()` prêt mais non branché. Scopes réels non vérifiés (pas de compte). |
| Normalisation formats / source ID / timestamps | PASS | `normalize.js` (enveloppe v1 : `source_id`, `source_epoch`, `ts_ms`, `received_ms`, `provenance`). Unité du timestamp SDK supposée en ms (**non vérifiée sur flux réel**). |
| Backoff exp. + jitter, keepalive, source_epoch, gap tracing, concurrence, dead‑letter | PASS | `backoff.js` (full jitter), watchdog de vivacité (le keepalive protocolaire est géré par le SDK ; on ne fait que surveiller l'activité), `source_epoch++` à chaque reconnexion, gaps/out‑of‑order par source, `maxConcurrent`, `dead-letter.js` borné. |

## Tests (36/36 — `reports/evidence_bloc06_test_output.txt`)
signature correcte / fausse / corps modifié / timestamp périmé ou futur / en‑têtes manquants / **rejeu** (+ cache non empoisonnable) · url_validation · **out‑of‑order** (stop avant start, doublon) · **démarrage sans média** (alerte + dead‑letter) · **socket perdue** (reconnexion, epoch 2, pas de faux gap, callbacks zombies ignorés) · **formats incompatibles** (taille impaire, mismatch, sans source id, UTF‑8 invalide) · **STOP host / app désactivée / meeting terminé / éjecté : aucune reconnexion et start tardif refusé** · échec d'authentification fatal · reconnexions bornées → dead‑letter · timeouts join/liveness · **quotas** (concurrence) · meeting non associé non rejoint · échec du sink · `stopAll`.
Redaction des logs : `reports/evidence_redacted_log_sample.txt` (ids hachés, secrets/URL/noms masqués) + test.

## Risque spécifique
RTMS ≠ capture de l'écran personnel : chaque item porte `provenance.personal_screen_capture=false` et `scope`; les cadres de partage hors fenêtre `sharing start/stop` annoncée par Zoom sont rejetés (`unshared_content_rejected`).

## Dettes / limites
- Aucun test contre un vrai serveur RTMS (pas de compte/stream) : sémantique réelle de `onJoinConfirm(reason)`, unité des timestamps, forme des payloads transcript/partage, et comportement du keepalive à valider.
- « Quotas » = plafond de concurrence uniquement ; pas de limite de débit/volume ni de backpressure sur le sink. Pas de persistance du dead‑letter ni de métriques exportées.
- Chat non disponible (SDK) ; partage = octets bruts sans décodage ; vidéo non traitée.
- `ASSOCIATION_SECRET`/stockage d'associations en mémoire (perdus au redémarrage). Pas de TLS/reverse‑proxy ni authentification de `/v1/association` autre que le nonce.
- Tests de timers via horloge simulée ; pas de test de charge.

**GO/NO-GO : GO conditionnel** — intégrité du pipeline démontrée en simulation ; GO complet après un run réel (MANUAL_REAL_ZOOM S1/S7 côté gateway).

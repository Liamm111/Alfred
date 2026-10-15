# BLOC 10 — STT multilingue et diarisation honnête

**Verdict global : PARTIAL — pipeline et garde-fous PASS (16/16 tests) ; qualité STT réelle (audio bruité, FR/EN, WER) BLOCKED. GO pour la suite sur les invariants ; NO-GO pour affirmer une qualité de transcription.**

Aucun moteur STT, aucun fichier audio et aucun flux RTMS n'étaient disponibles. Rien dans ce bloc ne mesure la précision d'un vrai STT. Ce qui est livré et prouvé : le contrat d'événements, l'assemblage final/provisoire, la diarisation honnête, la segmentation, le choix de moteur, les budgets de latence.

## Livrables

| Livrable | Statut | Où |
|---|---|---|
| Adaptateur STT interchangeable (RTMS natif / STT audio) | PASS (interface) ; moteurs réels BLOCKED | `blocs-08-12/src/stt/adapter.ts` (`SttAdapter`, `SttEvent`) |
| Choix RTMS-natif vs STT audio, hystérésis | PASS | `ProviderSelector` (FR+EN requis, couverture ≥ 0,95, latence p95 ≤ 4 s, bascule après 3 évaluations, interdiction = immédiat) |
| FR / EN / code switching | PARTIAL | `detectLang` heuristique ; `lang` du moteur prioritaire |
| Final vs provisoire, corrections de phrases | PASS | `TranscriptAssembler` (révisions périmées ignorées, final jamais rouvert, orphelins abandonnés) |
| Speaker IDs RTMS / UNKNOWN en local | PASS | roster obligatoire ; `diar_cluster` conservé comme étiquette, jamais comme identité |
| Segmentation phrase/temps, evidence ids, confiance, latences | PASS | `segmenter.ts`, `toEvidence`, `LatencyStats` |
| Audio bruité, noms propres, terminologie, homophones, longues pauses | PARTIAL | voir ci-dessous |

## Tests exécutés (16/16, Linux)

Log : `reports/logs/bloc10_tests.txt`.

- **Segmentation** : décimales (3.14), abréviations (Dr., e.g.), `?`/`!` ; pause 3 s ⇒ coupure sans ponctuation, pause 0,5 s ⇒ pas de coupure ; segment > 20 s coupé.
- **Noms propres / terminologie** : glossaire (`Lyam→Liam`, `Markof→Markov`, `martingal→martingale`), corrections tracées (`glossary:N`, `raw_text` conservé). Mots proches mais différents (`liane`, `marteau`, `marge`) non modifiés.
- **Homophones** : `vers/verre`, `cent/sans`, `chant/champ` jamais réécrits sans glossaire — pas de devinette.
- **Provisoire ≠ final** : un provisoire n'apparaît jamais dans `finals()` ; `quote()` renvoie `certain=false` avec la mention « transcription partielle non confirmée » ; un final de confiance < 0,6 est aussi incertain.
- **Corpus 30 min** (219 énoncés, 671 événements) **et 3 h** (1 359 énoncés, 4 088 événements) : 4 puis 51 énoncés orphelins (provisoires sans final) — 0 dans les finals ; 6 puis 38 hypothèses tardives après final — 0 dans les finals ; 5 puis 42 speaker_id fantômes (`u-ghost`) — 0 dans les finals ; pauses internes coupées ; faible confiance signalée ; 3 h traité en < 0,1 s ; evidences valides (`validateEvidence`). Rejeu en source `mac_local` : **100 % des segments sans speaker**.
- **Budgets de latence** : premier mot > 1,5 s et final > 4 s signalés `latency_budget_exceeded` et comptés.

## Limites de la preuve — à ne pas sur-interpréter

- Le « corpus 30 min + 3 h » est **synthétique, textuel, généré par graine** (`blocs-08-12/tests/support/corpus.ts`) : il prouve des invariants de logique, pas la qualité de transcription. **Aucun WER réel n'a été mesuré.** L'outil `wer()` existe mais n'a été appliqué qu'à des cas fabriqués.
- Le test « glossaire réduit le WER » (0,56 → 0) montre le mécanisme sur des erreurs que j'ai moi-même construites ; il ne dit rien du taux de réussite en conditions réelles.
- Audio bruité, accents, chevauchements de parole, latences réelles : **non testés**.
- `detectLang` est une heuristique de mots-outils : des termes anglais insérés dans du français sans mots-outils anglais restent classés `fr` (limite documentée dans un test).
- Les corrections de glossaire peuvent se tromper sur un homonyme du lexique (ex. un autre « Liam ») ; elles sont tracées mais pas désambiguïsées.
- La diarisation locale n'est pas implémentée : on transporte seulement un cluster fourni.

## Dettes

1. Brancher un vrai STT (Apple SpeechAnalyzer / Whisper / Deepgram…) derrière `SttAdapter`, et la transcription native RTMS.
2. Corpus audio réel annoté (FR, EN, mixte, bruit, 30 min et 3 h), calcul de WER par catégorie (noms propres, termes, chiffres).
3. Latences mesurées de bout en bout (parole → final) pour calibrer les budgets 1,5 s / 4 s.
4. LID au niveau du mot ou du segment fourni par le moteur ; remplacer l'heuristique.
5. Roster RTMS : provenance et mise à jour en cours de réunion (arrivées/départs, renommages).
6. Désambiguïsation du glossaire (plusieurs participants au prénom proche).

## GO / NO-GO

GO : invariants « jamais un provisoire comme certain » et « jamais un speaker inventé » tenus sur 4 088 événements synthétiques. NO-GO : aucune affirmation de fiabilité STT tant que (1) et (2) ne sont pas faits.

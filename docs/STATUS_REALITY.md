# État réel du dépôt

Audit effectué le 14 octobre 2026. Cette page décrit uniquement des éléments
observés ; elle ne déduit aucune capacité d'un nom de produit ou d'une
documentation fournisseur.

## Entrées disponibles

- Dépôt local : `/workspace/Alfred`.
- Distant : `https://github.com/Liamm111/Alfred.git`.
- État distant observé : dépôt public de taille `0`, sans référence Git.
- État initial conservé : commit vide `b3efa7e` sur la branche locale
  `initial-state/block-00`.
- `PRD_V0_SOURCE_OF_TRUTH.md` : absent.
- Prototype, `src/`, `tests/`, README et docs historiques initiaux : absents.
- Changements précédents : aucun commit antérieur disponible.

## Preuve du code existant vs mock

| Portion attendue | Preuve recherchée | Connectée | Simulée | Non construite / inconnue | Verdict |
| --- | --- | --- | --- | --- | --- |
| Application / démo | fichiers, manifeste, point d'entrée | aucune | aucune | aucun fichier initial | `BLOCKED` |
| Recall | client, appels, credentials, tests réels | aucune | aucune | absent | `NOT VERIFIED` |
| Zoom | OAuth/API/webhooks, scopes, tests réels | aucune | aucune | absent | `NOT VERIFIED` |
| Apple/APNs | client, entitlement, credentials, device, tests réels | aucune | aucune | absent | `NOT VERIFIED` |
| Persistance / migrations | schéma et migrations | aucune | aucune | absent | `BLOCKED` |
| Authentification / autorisation | code et tests d'accès | aucune | aucune | absent | `BLOCKED` |
| Transcription / chat | ingestion et frontière de confiance | aucune | aucune | absent | `BLOCKED` |
| Mode mock | `.env.example`, validateur, tests shell | sans fournisseur | garde-fou uniquement | non raccordé à une app absente | garde-fou local `PASS` |

« Aucune » ne signifie pas qu'une intégration échoue : elle signifie qu'il
n'existe aucun artefact à inspecter. Aucune preuve fournisseur n'a été
fabriquée.

## Divergences vérifiables avec la demande BLOC 00

Le contrat fonctionnel étant absent, une comparaison article par article avec
le PRD et sa matrice de risques est impossible. Les divergences certaines sont :

1. le dépôt annoncé comme prototype est vide ;
2. le PRD source de vérité n'est pas présent ;
3. aucune démo ni suite de tests existante ne peut être lancée ;
4. aucune intégration réelle ni simulée n'est implémentée ;
5. aucun historique applicatif n'est disponible.

## Frontières de confiance à préserver

Les futurs contenus de transcription et de chat seront des données non fiables.
Ils ne devront jamais être interprétés comme des instructions d'exécution,
accéder à des secrets, autoriser une action externe, contourner l'admission ou
parler au nom d'un étudiant. Les actions externes devront être autorisées,
idempotentes et traçables, avec décision finale laissée à l'hôte.

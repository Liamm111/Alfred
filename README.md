# AI Course Assistant

## État du dépôt

Le dépôt distant fourni était vide au début du BLOC 00 (aucun commit, aucun
fichier, aucune branche distante). Le PRD et le prototype annoncés ne sont donc
pas disponibles. L'audit fonctionnel et l'exécution de la démo sont bloqués ;
voir [`docs/BLOCK_00_REPORT.md`](docs/BLOCK_00_REPORT.md).

Ce dépôt ne constitue pas une V0 livrée. Les intégrations Recall, Zoom et Apple
ne sont ni configurées, ni autorisées, ni testées en réel.

## Garde-fou de mode simulé

`MOCK_MODE` est explicite et vaut `false` dans `.env.example`. Le validateur
local rejette les valeurs autres que `true`/`false` et interdit le mode simulé
si `APP_ENV=production` :

```sh
APP_ENV=production MOCK_MODE=false ./scripts/validate-runtime-mode.sh
```

Tout futur point d'entrée applicatif devra appeler ce validateur avant de
démarrer. Il n'existe actuellement aucun point d'entrée auquel le raccorder.

## Vérifications locales

```sh
./tests/test-runtime-mode.sh
```

Les décisions, dépendances et gates sont documentés dans `docs/`.

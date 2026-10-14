# Rapport BLOC 02 — connexion, identité étudiante, aliases, préférences

Date : 14 octobre 2026.

## Verdict
**BLOC 02: BLOCKED** — tout ce qui est testable localement passe ; le critère « reconnexion réussie **en staging auth configurée** » ne peut pas être validé (aucun staging, aucun SMTP réel : gates `STAGING-AUTH` BLOCKED, `REAL-EMAIL` NOT VERIFIED). Équivalent local (Postgres réel, API + Next de prod, e-mail par fichier) : PASS. Je ne déclare donc pas le bloc terminé. La V0 n'est pas livrée.

## Réellement codé
- **Auth** (Better Auth 1.7.8 + Drizzle/Postgres, sans mot de passe) : lien magique 15 min à usage unique (jeton **haché** en base), session serveur 30 j glissante, cookie `alfred.session_token` HttpOnly + SameSite=Lax (+Secure en https), logout, révocation immédiate, anti open-redirect, rate-limit par client + plafond 3 mails/10 min/destinataire (pas d'énumération : réponse identique).
- **Migration `0001_auth_identity`** (+ `down`) : `users` (PRD §5.1 : id, email unique, createdAt, deletedAt + colonnes de la bibliothèque), `auth_sessions/accounts/verifications`, `user_preferences` (aliases `{raw,normalized}`, locale FR, fuseau IANA, langue des résumés, `alertPreferences`, rétention 30/90 j, version optimiste, `onboardingCompletedAt`).
- **API** : `GET /api/me`, `GET|PUT /api/me/preferences`, `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`, `/api/auth/*`. Guard `requireUser` fail-closed (session absente/expirée/révoquée, utilisateur soft-deleted, toute erreur ⇒ 401), contrôle `Origin` sur toute requête non-GET, erreurs standard, audit sans contenu.
- **Contraintes d'onboarding** : le serveur refuse de terminer l'onboarding sans « application ouverte seulement » explicitement accepté tant que le Push n'est pas vérifiable (N01) ; fuseau IANA canonique uniquement ; alias bornés (10 max), sans doublon après normalisation, sans balisage/bidi.
- **Web** (Next, responsive, cibles ≥44 px, labels, `aria-live`, contraste AA, mode sombre) : `/login` (états : repos, envoi, envoyé, e-mail invalide, 429, indisponible, lien expiré), onboarding, accueil à états vides explicites, paramètres (préférences, sessions, déconnexion), garde serveur (aucune page privée sans session valide), état « service indisponible » explicite. Suppression de compte : **non disponible**, affichée comme telle.
- Variables d'env : `AUTH_SECRET`, `EMAIL_TRANSPORT` (`file` interdit en staging/prod ; `smtp` obligatoire), `SMTP_URL`, `AUTH_MAGIC_LINK_MAX_PER_MIN` (>5 interdit en staging/prod), `TRUST_PROXY_HOPS`.
- Aucun « mock auth » : aucun mécanisme d'identité hors cookie de session ; test d'en-têtes forgés (`x-user-id`, `Authorization`, cookies falsifiés) ⇒ 401.

## Commandes exécutées et résultats (local, Postgres 16 réel)
| Commande | Résultat |
|---|---|
| `pnpm lint` / `pnpm typecheck` | PASS |
| `pnpm test` | PASS 53 tests (dont propriétés fast-check sur la normalisation d'alias, schéma d'env) |
| `pnpm test:integration` | PASS 37 tests : 401 sur toutes les routes privées (énumération), lien magique, jeton haché/unique/expiré, open-redirect refusé (3 champs), Origin étranger refusé, throttle destinataire, préférences (défaut → sauvegarde → **reconnexion** → mêmes données), validation, 409 de version, IDOR (A/B, révocation croisée ⇒ 404 sans oracle d'existence), révocation immédiate, logout rejoué ⇒ 401, session expirée ⇒ 401, utilisateur supprimé ⇒ 401, CSRF, rate-limit 429 non contournable par `x-client-ip`, transport e-mail désactivé ⇒ échec honnête, audit sans alias |
| `pnpm test:e2e` (Playwright Chromium, desktop **et** mobile iPhone 13) | PASS 2/2 : parcours complet avec captures (états vides, erreurs, lien expiré, reconnexion) — voir `docs/screens/block02/` |
| `pnpm check:prod-bundle` | PASS 10/10 (dont `/api/me` anonyme 401, `EMAIL_TRANSPORT=file` refusé en prod) |

**CI GitHub Actions** ([run 38614869903](https://github.com/Liamm111/Alfred/actions/runs/38614869903), commit `f27bd36`) : **success** (install gelé, scan secrets, lint, typecheck, tests, migrations up/down/up, intégration, build, e2e Playwright, bundle prod).

## Bugs trouvés et corrigés pendant le bloc
- **P1 sécurité** : la bibliothèque désactive silencieusement les contrôles Origin/CSRF quand `NODE_ENV=test` ; un test d'open-redirect l'a révélé. Contrôles forcés + test.
- **P1** : limiteur de débit de la bibliothèque sans IP client ⇒ **un seul seau global** (un attaquant pouvait verrouiller toutes les connexions) ; IP désormais résolue côté serveur (`TRUST_PROXY_HOPS`, en-tête interne écrasé) + test anti-contournement.
- Normalisation de fuseau : les alias hérités (ex. `America/Montreal`) sont refusés (noms canoniques seulement).

## Limites et risques ouverts
- **Pas d'e-mail réel vérifié** ; le transport SMTP n'a jamais parlé à un serveur. Les scanners de liens d'e-mail peuvent consommer un lien à usage unique (limite connue des liens magiques).
- Throttle destinataire et rate-limit en **mémoire** : valable pour 1 instance (V0), pas pour du multi-instance.
- `TRUST_PROXY_HOPS` doit refléter le déploiement réel (par défaut 0 ⇒ tous les clients derrière un proxy partagent un seau).
- Pas de suppression de compte, pas de Push, pas de rotation de `AUTH_SECRET` documentée/testée, pas de CSP (Q07 partiel).
- `better-auth` est jeune/rapide : version figée (1.7.8), à auditer avant production.
- Aucune accessibilité testée avec un outil automatique (axe) : conception AA, non mesurée.

## Gates
`STAGING-AUTH` BLOCKED · `REAL-EMAIL` NOT VERIFIED · `REAL-ZOOM`, `REAL-PUSH` NOT VERIFIED.

## Prochaine étape recommandée
Fournir un SMTP de test + un staging HTTPS pour lever `STAGING-AUTH`/`REAL-EMAIL`, puis passer au bloc suivant (programmation de cours). Rien n'est lancé automatiquement.

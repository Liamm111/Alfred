# Alfred

Contracts, session state machine, PostgreSQL persistence and authentication for the Zoom RTMS capture assistant.

| Area | Where | Report |
|---|---|---|
| Typed contracts, state machine, fixtures | `src/contracts`, `schemas/`, `swift/AlfredContracts`, `fixtures/` | `reports/BLOC_01.md` |
| PostgreSQL schema, RLS, outbox, retention | `db/migrations`, `src/db` | `reports/BLOC_02.md` |
| Product auth (PKCE), Zoom OAuth, signed stream association | `src/auth`, `swift/AlfredAuthClient` | `reports/BLOC_03.md` |

```sh
npm ci
npm run gen          # JSON Schemas + Swift types + fixtures from the Zod schemas
npm run gen:check    # fails on drift
npm run typecheck
npm test             # needs a local PostgreSQL 16: DATABASE_URL (default postgres://alfred_test:alfred_test@127.0.0.1:5432/alfred_test)
```

The test suite drops and recreates the `public` schema of `DATABASE_URL`: never point it at real data.

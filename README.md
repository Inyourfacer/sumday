# Sumday

A local-first financial planner for one household: spending, savings goals,
investments, debt and retirement in one place. It tells you what to do with
your next dollar, using rules and math you can inspect.

- [Design](docs/DESIGN.md)
- [Build plan](docs/PLAN.md)

> **Status:** Phase 0 (foundations) is done. The dashboard is an empty shell.

## Running it

Requires Node 22+.

```sh
npm install
npm start          # builds the UI and serves Sumday at http://127.0.0.1:4321
```

Your data lives in `var/sumday.db` (a single SQLite file, ignored by git).
To change the location or port, copy `.env.example` to `.env` and edit it.
Sumday only listens on `127.0.0.1`, so it can't be reached from other machines.

## Development

```sh
npm run dev        # API with auto-reload + Vite UI at http://127.0.0.1:5173
npm test           # unit tests
npm run lint
npm run typecheck
npm run build      # production build of the UI to dist/
```

| Folder | What's in it |
|---|---|
| `src/engine/` | Pure TypeScript calculations with no I/O (money, dates; later budget, waterfall, Monte Carlo…). Every rule has a test. |
| `src/server/` | Fastify API, SQLite access and migrations. |
| `src/shared/` | Types shared by the API and the UI. |
| `src/web/` | React UI. |

Money is always stored as integer cents and dates as `YYYY-MM-DD` strings.
Database changes go in `src/server/migrations/index.ts` as a new numbered
migration; never edit one that has shipped.

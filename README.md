# Sumday

A local-first financial planner for one household: spending, savings goals,
investments, debt and retirement in one place. It tells you what to do with
your next dollar, using rules and math you can inspect.

- [Design](docs/DESIGN.md)
- [Build plan](docs/PLAN.md)

> **Status:** Phases 1–2 are done: household setup, accounts, CSV/OFX import
> with review and undo, categories, rules, transfer matching, the Fixed /
> Flex / Non-monthly budget, cash flow and trends, recurring bills, and net
> worth history. Goals, debt and recommendations come next.

## Using it

1. **Setup** opens on first run: household, the adults, workplace plans, employer
   match, Social Security. Skip anything; it shows up later as a reminder.
2. **Accounts**: add each account. For ones you won't import (a 401(k), your home),
   enter a balance instead.
3. **Import**: download a CSV, OFX or QFX from your bank and pick the account.
   For a CSV, check the column mapping and preview once; it's remembered. Nothing
   is saved until you review the rows and press **Add**. Re-importing an
   overlapping date range skips rows you already have, and any import can be
   undone from **Import history**.
4. **Transactions → Uncategorized inbox**: pick categories. Each correction offers
   to become a rule, which also fixes matching past transactions. Payments
   between your own accounts are paired as transfers automatically.
5. **Budget**: press **Suggest from my history** to start from what you
   actually spent, then adjust. Fixed bills get a monthly amount, Non-monthly
   costs a yearly amount (a twelfth is set aside each month), and everything
   else shares one Flex pool: income − fixed − non-monthly − planned savings.
6. **Cash flow**, **Recurring** and the net worth chart on **Accounts** fill in
   as history builds up. Add a starting balance on each account so net worth
   history is accurate.

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

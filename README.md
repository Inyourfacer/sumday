# Sumday

A local-first financial planner for one household: spending, savings goals,
investments, debt and retirement in one place. It tells you what to do with
your next dollar, using rules and math you can inspect.

- [Design](docs/DESIGN.md)
- [Build plan](docs/PLAN.md)

> **Status:** All six phases are done: household setup, accounts, CSV/OFX
> import with review and undo, categories, rules, transfer matching, the
> Fixed / Flex / Non-monthly budget, cash flow, recurring bills, net worth,
> savings goals, debt payoff, **Next best moves**, investments (holdings,
> daily prices, mix vs target, rebalancing, fees), a **Monte Carlo retirement
> projection**, what-if **scenarios**, **alerts**, a printable **monthly
> report**, daily backups and export.

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
7. **Next best moves** shows where this month's spare money should go, step
   by step: emergency fund, employer match, high-interest debt, HSA, IRA,
   workplace plan, goals, then investing. Each move says why, and "The
   numbers behind it" shows the math. Reorder or turn off steps in Plan
   settings. For debts, add the APR and minimum payment on each account, and
   untick "paid in full" on cards that carry a balance.

8. **Investments**: download a positions CSV from each brokerage or 401(k)
   site and use **Import positions**. Set your target mix, give blended funds
   (target-date) their mix and each fund its expense ratio, and for 401(k)
   funds without a ticker, pick a public fund it follows (e.g. VOO for an
   S&P 500 trust). The page shows what to buy next and, if you've drifted,
   the cheapest way back.

9. **Retirement**: the chance your money lasts, from 10,000 simulated
   futures built from real market history since 1928, plus the spending you
   can afford, a "retire at…?" table, and the smallest change that reaches
   your target. Add Social Security estimates (ssa.gov/myaccount) in
   Settings → Household, and adjust retirement spending on the page.

10. **Scenarios**: "what if" versions of your plan: retire at a different
    age, a change in pay, saving more, spending more or less in retirement,
    an inheritance or a big expense, a home purchase, a different mix. Tick up
    to three to see them side by side with your plan today. **Make this my
    plan** applies one: ages, pay and the mix update your settings; the rest
    shows on Retirement as a change you can remove.

11. **Alerts** on the dashboard: Flex spending over budget or ahead of pace,
    a bill that changed, a new subscription, a large charge, checking running
    low before payday, investment drift, an intro rate ending, a goal behind,
    an account not updated in a while. Dismiss any of them; tune thresholds,
    turn kinds off, or get desktop notifications in Settings → Alerts.

12. **Reports**: on the 1st, Sumday writes a review of the month before:
    budget vs actual, where the money went, net worth change, goals, debt,
    retirement chance (and how it moved), next best moves and data health.
    Print it or save it as a PDF from the report page.

13. **Backups & export**: a copy of the database is made every day Sumday
    runs (the newest 30 are kept in `var/backups/`), plus **Back up now**.
    Export all your data as JSON or your transactions as CSV. To restore,
    stop Sumday and copy a backup over `var/sumday.db`.

Contribution limits live in `data/limits/<year>.json`; market history in
`data/returns/` and the IRS required-minimum table in `data/rmd/`, each with
its source. Add next year's file
when the IRS announces it (usually in November).

## Running it

Requires Node 22+.

```sh
npm install
npm start          # builds the UI and serves Sumday at http://127.0.0.1:4321
```

For daily investment prices, get a free API key at tiingo.com and put it in a
`.env` file in this folder (copy `.env.example`):

```sh
TIINGO_API_KEY=your-key-here
```

Without a key everything else works; prices come from your imported files or
what you type in.

Your data lives in `var/sumday.db` (a single SQLite file, ignored by git),
with daily backups in `var/backups/` (`SUMDAY_BACKUP_DIR` to move them).
Background jobs run while Sumday is running: prices every 6 hours, the daily
backup, and last month's report on the 1st (or the next time it starts).
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

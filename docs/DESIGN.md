# Sumday — Design

> **Status:** Draft for review. Nothing here is built yet.

## 1. Purpose

Sumday is a personal financial planner for one household. It brings spending,
savings goals, investments, debt and retirement into one place, and tells you
**what to do with your next dollar**.

Three principles shape everything below:

1. **Local-first.** The app runs on your own machine. All data lives in one
   SQLite file you own. Nothing goes to the cloud except price lookups.
2. **Rules and math, no black box.** Every recommendation comes from a written
   rule applied to your numbers. The app always shows *which* rule fired and
   *which* numbers it used. There is no AI and no hidden scoring.
3. **Your data, your way in.** Data arrives by file import (CSV, OFX/QFX) or
   manual entry. There is no bank linking. Every import source goes through the
   same pipeline, so automation can be added later without changes elsewhere.

Sumday is a planning tool, not a licensed advisor. Its defaults follow common
personal-finance practice and can all be edited.

## 2. Users

| Who | Count | Access |
|---|---|---|
| Household adults | 1–2 | Local web UI on `localhost`. Optional passcode. |

There are no sign-up, multi-tenant or billing features. Both adults see
everything. Each account has an **owner** (adult A, adult B or joint), because
retirement accounts, contribution limits and Social Security are per person.

### 2.1 Household setup (in the app)

Nothing about the household is hard-coded. A **first-run setup wizard**
collects it, and a **Settings → Household** page edits it at any time:

- **People:** 1 or 2 adults. Each has a name, birth date, target retirement
  age, earned income and expected raise, Social Security estimates at 62 / FRA
  / 70, planned claim age, and any pension (start age, monthly amount, COLA
  yes/no).
- **Household:** filing status, state, number of dependents, HSA coverage
  (self / family / none), inflation assumption, planning horizon.
- **Employer plans (per person):** plan type (401k / 403b / 457), match formula
  as a list of tiers (e.g. "100% of the first 3%, 50% of the next 2%"),
  vesting note, payroll contribution % (pre-tax and Roth), HSA payroll
  contribution.

Every field has a sensible default, and the wizard can be skipped. Anything
left blank shows up as a "finish setup" item on the dashboard. The engines
that need a missing value (e.g. the match step without a match formula) are
skipped and say why. Changing a setting reruns the affected engines
immediately.

## 3. Data model (core entities)

| Entity | Key fields |
|---|---|
| **Person** | name, birth date, retirement age target, Social Security estimate(s) by claim age, earned income |
| **Household** | filing status, state, planning horizon (default age 95), inflation assumption |
| **Account** | name, institution, type (checking, savings, credit card, loan, mortgage, brokerage, 401k, 403b, IRA, Roth IRA, HSA, 529, other asset), tax treatment (taxable / traditional / Roth / HSA), owner, interest rate (cash & debt), employer match rules (401k) |
| **Transaction** | account, date, amount (integer cents, signed), payee (raw + normalized), category, transfer link, import batch, notes |
| **Category** | name, group, budget type (**Fixed / Flex / Non-monthly / Income / Transfer**), essential flag. Savings are not a category: a transfer into an investment or retirement account counts as savings (Section 4.4). |
| **Rule** | match (payee contains/regex, amount range, account), action (set category, rename payee, mark transfer), priority |
| **Holding** | account, security, shares, cost basis lots (date, shares, cost) |
| **Security** | ticker (optional), proxy ticker (optional), name, asset class mix (e.g. 100% US stock, or a blend for target-date funds), expense ratio |
| **Price** | security, date, close |
| **Balance snapshot** | account, date, balance (for accounts tracked by balance only, and for net worth history) |
| **Goal** | name, target amount, target date, priority, linked account(s) and earmarked amount |
| **Plan settings** | waterfall steps & thresholds, target allocation, alert thresholds, retirement spending adjustments |
| **Scenario** | name, base plan, list of overrides |
| **Import batch** | source, file name, file hash, row counts, created at (undoable) |

All money is stored as **integer cents**. All dates are calendar dates in the
household time zone. Contribution limits, RMD tables and similar yearly
figures live in a versioned data file (`data/limits/<year>.json`) that is
updated once a year, not in code.

## 4. Getting data in

### 4.1 Import pipeline

Every source, whether manual upload today or a scheduled watched-folder job
later, runs the same stages:

```
file ──► detect format ──► parse (per-institution adapter) ──► normalize
     ──► dedupe ──► apply rules ──► detect transfers ──► stage for review ──► commit
```

- **Adapters:** `Importer { id, detect(file): boolean, parse(file): RawRow[] }`.
  v1 ships two adapters that cover any institution: a **generic CSV** adapter
  and an **OFX/QFX** adapter. The CSV adapter has a column-mapping screen
  (date, amount or debit/credit, payee, memo, sign convention, date format)
  that is saved per account and reused on every import. Adapters for specific
  institutions are deferred; the interface leaves room for them.
- **Dedupe:** use the OFX `FITID` when present. Otherwise use a key of
  account + date + amount + normalized payee + occurrence index within that day.
  Overlapping date ranges in repeat imports are safe.
- **Review step:** new rows show up in a staging view with their proposed
  categories before you commit them. A committed batch can be undone as a whole.
- **Holdings import:** brokerage position CSVs (ticker, shares, cost basis)
  update holdings and record a balance snapshot.
- **Scheduler hook:** a job runner (Section 9) can later point at a watched
  folder. It calls the same pipeline and leaves rows staged for review.

### 4.2 Manual entry

Accounts, balances (for things like a home value or a pension), holdings and
individual transactions can all be entered by hand.

### 4.3 Categorization

1. **Rules run first,** in priority order. The first match wins.
2. **Learn from corrections:** when you recategorize a transaction, Sumday
   offers a rule ("Always categorize payees containing *TRADER JOE* as
   Groceries?") and shows how many past transactions it would change.
3. **Payee normalization** strips store numbers, card suffixes and processor
   prefixes (`SQ *`, `TST*`, `POS `) before matching.
4. **Unmatched rows** go to an **Uncategorized inbox**.

### 4.4 Transfer detection

Two transactions in different accounts of the household with opposite amounts
within 5 days are proposed as a **transfer pair**: for example, a checking
debit and a credit card payment, or a checking debit and a brokerage deposit.
Transfers are excluded from spending and income. A transfer into an investment
or retirement account counts as **savings**.

## 5. Spending & budget

### 5.1 Fixed / Flex / Non-monthly

Each spending category has one budget type:

| Type | Meaning | How it's budgeted |
|---|---|---|
| **Fixed** | Same-ish bill every month (rent/mortgage, insurance, utilities, subscriptions) | Expected amount per category; flags if actual differs by > 10% |
| **Non-monthly** | Irregular but predictable (car registration, holidays, annual insurance, travel) | Annual total ÷ 12 set aside monthly in a virtual **sinking fund**; spending draws it down |
| **Flex** | Everything discretionary (groceries, dining, shopping, fun) | **One pool**: income − fixed − non-monthly − planned savings |

Monthly view: income, fixed (expected vs actual), non-monthly (set aside,
spent, fund balance), the flex pool (budget, spent, left, daily pace) and
savings (planned vs actual).

### 5.2 Other spending features

- **Recurring detection:** a payee charged ≥ 3 times at a regular interval
  (weekly, monthly or yearly, ± 3 days) with an amount within ± 10% becomes a
  proposed recurring item. This drives the bills calendar and the
  new-subscription alert.
- **Trends:** spending by category and group over 12 months, and average
  monthly spending by category.
- **Cash flow & savings rate:** savings rate = (income − spending) ÷ income,
  and also as (contributions to savings/investing) ÷ gross income.
- **Net worth:** assets − liabilities over time, from transactions, balance
  snapshots and holding values.

## 6. Savings goals

- A goal has a target amount, target date and priority, and is **funded by
  earmarking** money in real accounts (e.g. $8,000 of the HYSA is "House
  down payment"). The money isn't moved; the app only labels it.
- **Required monthly contribution** = (target − earmarked) ÷ months left,
  optionally with expected interest on the account.
- **Status:** on track, behind (with the shortfall), or funded.
- The **emergency fund** is a built-in goal whose target is calculated:
  *N months × essential monthly spending*. Essentials = fixed + non-monthly +
  the categories you mark essential. N is 3 by default for two incomes and 6
  for one, and you can edit it.
- Goals plug into the waterfall (Section 8) as the **Goals** step, funded in
  priority order.

## 7. Debt

- Every loan or card has a balance, APR, minimum payment and optional promo
  APR end date.
- **Payoff plans:** avalanche (highest APR first, the default) or snowball
  (smallest balance first), with a given extra monthly amount. Output: payoff
  date per debt, total interest, and a month-by-month schedule.
- **Avalanche vs snowball** comparison: months saved and interest saved.
- A promo APR that ends within 90 days triggers an alert and is treated as the
  post-promo APR in planning.

## 8. Recommendations: the waterfall

### 8.1 How it works

Each month Sumday computes your **surplus**:

> surplus = expected income − fixed − non-monthly set-aside − flex budget − debt minimums

then pours it through an ordered list of **steps**. Each step has a **target**
and a **fill rule**. A step takes as much as it needs up to its target, and the
remainder spills to the next step.

### 8.2 Default steps (editable order, thresholds and on/off)

| # | Step | Target | Notes |
|---|---|---|---|
| 1 | Starter emergency fund | $2,000 (editable) in cash | |
| 2 | Employer 401k match | Contribute enough to get the full match | Uses each person's match formula |
| 3 | High-interest debt | Pay off debts with APR ≥ 7% (threshold editable) | Avalanche order |
| 4 | Full emergency fund | Emergency fund goal target | See Section 6 |
| 5 | HSA | Annual limit (self or family) | Only if HSA-eligible |
| 6 | IRA | Annual limit per person | Roth or Traditional, by an income threshold you set; flags when backdoor Roth may apply |
| 7 | Max workplace plan | Annual 401k/403b limit per person | Includes catch-up if age ≥ 50 |
| 8 | Goals | Each goal's required monthly amount | In goal priority order |
| 9 | Taxable investing | No cap | Into the brokerage at the target allocation |
| 10 | Low-interest debt prepay | Optional | Off by default; mortgage etc. |

Notes:

- Annual-limit steps are converted to a **monthly pace**, using the
  year-to-date contributions found in imported transactions.
- Payroll contributions (401k, HSA via payroll) can't be redirected
  mid-month. For those, the recommendation is to **change your contribution %**
  and shows the % to set.
- Steps 1 and 4 are skipped once they're full. They switch back on if the cash
  balance falls below target.

### 8.3 What a recommendation looks like

Every item on the dashboard's **Next best moves** list shows:

- **Action and amount:** "Put **$450/mo** into Alex's Roth IRA."
- **Why:** "Step 6 · IRA. $3,200 of the $7,500 limit is unused; 9 months left."
- **The numbers behind it** (expandable): inputs, formula and the rule's
  threshold values.
- **Dismiss / snooze / done.** Dismissed items stay hidden until their inputs
  change.

Other rule-based recommendations sit beside the waterfall, using the same
format:

- **Rebalance** when allocation drift exceeds the band (Section 10).
- **Fees:** a fund with an expense ratio > 0.50% where a cheaper fund in the
  same asset class is in your plan's lineup or a common index alternative.
- **Idle cash:** checking balance > 2× monthly spending, beyond the emergency
  fund → move it to savings or to the next waterfall step.
- **Cash yield:** emergency fund in an account earning < 1% APY.
- **Retirement on track:** if the success probability < target (default 85%),
  show the smallest change that reaches it: save $X/mo more, retire N months
  later, or spend $Y/yr less in retirement.

## 9. Alerts

Alerts appear on the dashboard and in the monthly report. The scheduler can
also send them as desktop notifications.

| Alert | Default trigger |
|---|---|
| Over budget | Flex pool spent > budget, or > the expected pace by more than 15% mid-month |
| Fixed bill changed | Recurring item amount differs > 10% from usual |
| New subscription | New recurring item detected |
| Large transaction | > $500 or > 3× the category's typical amount |
| Low cash | Checking projected below $X before next paycheck |
| Allocation drift | Any asset class outside its band |
| Promo APR ending | Within 90 days |
| Goal behind | Projected shortfall at target date |
| Stale data | An account hasn't been imported in 14+ days |

All thresholds are editable in Plan settings.

## 10. Investments

- **Holdings** come from brokerage CSV imports or manual entry, with **cost
  basis lots** where available.
- **Prices:** a `PriceProvider` interface. The default provider is **Tiingo**
  (free API key). It has end-of-day prices for US stocks, ETFs and mutual funds,
  adjusted for splits and dividends, and a free tier large enough for a daily
  refresh of every held ticker. Alpha Vantage's free tier (about 25
  requests/day) is too small. A daily job fetches closes for held tickers
  only and backfills any days the machine was off. Free-tier limits are checked
  again at build time.
- **Funds without a ticker** (common in 401k plans): a security can have a
  **proxy ticker**, and Sumday applies the proxy's daily % change to the
  last known price. Each import that includes a real price resets it.
  Manual price entry is the final fallback.
- **Asset classes:** US stock, international stock, bonds, cash, real estate,
  other. A security can be a blend (e.g. a target-date fund = 54% US stock /
  36% intl / 10% bonds). Common funds get default mappings, and you can
  override them.
- **Allocation** is viewed across the whole household, plus per account and per
  person.
- **Target allocation:** you set one household target (e.g. 60/30/10). An
  optional age-based glide path shifts it toward bonds over time.
- **Drift band:** ±5 percentage points absolute or ±25% relative, whichever is
  smaller.
- **Rebalancing suggestions,** cheapest first:
  1. Send new contributions to the most underweight classes.
  2. Trade inside tax-advantaged accounts (no tax cost).
  3. Trade in taxable accounts only when still outside the band. Prefer lots
     with losses, warn about short-term gains, and show the estimated gain.
- **Asset location hints:** bonds in tax-deferred accounts, broad stock index
  funds in taxable. These are suggestions only.
- **Fee drag:** weighted expense ratio and its projected dollar cost over 10
  and 30 years.
- **Performance:** money-weighted return (XIRR) per account and overall.

## 11. Retirement

### 11.1 Inputs

- **Per person:** birth date, target retirement age, current income, expected
  raises, contributions (and %), Social Security estimates at 62 / FRA / 70 from
  each person's ssa.gov statement, claim age, and any pension.
- **Accounts** grouped by tax bucket: **taxable, traditional (pre-tax),
  Roth, HSA**.
- **Retirement spending,** built from **your actual budget**: start from the
  trailing-12-month average by category, then adjust each line ("Mortgage ends
  2038", "Kids' activities → $0", "Travel +$6k/yr until 75", "Healthcare: pre-65
  premium of $X, then Medicare"). One-off expenses (car every 8 years, roof)
  can be added.
- **Assumptions:** inflation (from the historical data, or fixed), effective tax
  rate on traditional withdrawals (default 15%, editable), on taxable gains
  (default 15% on the gain portion), success target (default 85%), planning
  horizon (age 95).

### 11.2 Monte Carlo engine

- **Historical bootstrap.** A bundled dataset of **annual** US returns for
  stocks, bonds and T-bills, plus CPI inflation (e.g. Damodaran's historical
  returns, 1928–present). Each simulated year draws **one whole historical
  year** (all assets plus inflation together), so real correlations and crash
  years are kept.
- **Block bootstrap** (default block length 5 years, editable) keeps runs of
  good and bad years together, so the risk of a bad stretch right at
  retirement shows up in the results.
- **Runs:** 10,000 paths by default, with a **seeded RNG** so the same inputs
  always give the same answer (and tests are stable).
- **Each simulated year:**
  1. Grow each bucket by its allocation's return for that year.
  2. Before retirement: add contributions (rising with raises), capped at
     limits.
  3. In retirement: compute spending (inflated), subtract Social Security and
     pensions, and withdraw the gap plus estimated tax.
  4. **Withdrawal order** (default): RMDs first → taxable → traditional → Roth
     → HSA (HSA is also used first for healthcare costs).
  5. **RMDs** start at the age required by current law (in the yearly data
     file), using the IRS Uniform Lifetime Table.
- **Outputs:**
  - Success probability: the share of paths that never run out before the
    horizon.
  - Portfolio value bands over time (10th / 25th / 50th / 75th / 90th
    percentile) in today's dollars.
  - The age assets run out, in failing paths.
  - Sustainable spending at the target success rate (found by bisection).
  - "Can I retire at X?": success probability for each retirement age across a
    range.

### 11.3 What it does *not* do (v1)

There are no federal or state tax brackets, Roth conversion planning, IRMAA,
or tax-optimized withdrawal sequencing. The design keeps a `TaxModel`
interface so a bracket-based model can replace the flat-rate one later.

## 12. What-if scenarios

- A **scenario** is the base plan plus a list of **overrides**: retirement
  age, savings rate or contribution %, income change (job change, one partner
  stops working), a home purchase (down payment, new mortgage, changed fixed
  costs), a one-off expense or windfall, a different allocation, or a different
  spending level.
- Scenarios run through the **same engines**. Compare up to 3 side by side:
  success probability, median net worth at retirement, sustainable spending,
  and the waterfall's monthly output.
- You can **promote** a scenario to become the base plan.

## 13. Monthly review report

The report is generated on the 1st of each month for the prior month, and on
demand. It's an HTML page stored locally and printable to PDF. It covers:

1. Income, spending and savings rate vs budget (Fixed / Flex / Non-monthly).
2. Top categories, biggest changes vs the 12-month average, and new recurring
   items.
3. Net worth change: market moves vs contributions vs debt paydown.
4. Goals progress, debt progress, and allocation drift.
5. Retirement success probability and how much it moved since last month (and
   why: market moves vs your changes).
6. **This month's Next best moves** from the waterfall and other rules.
7. Data health: accounts with stale imports, the uncategorized count.

## 14. Architecture

```
sumday/
  src/
    engine/        pure TypeScript, no I/O — budget, recurring, waterfall,
                   debt, goals, allocation, rebalance, montecarlo, alerts, xirr
    importers/     format detection + per-institution adapters → RawRow[]
    pricing/       PriceProvider interface + providers
    server/        Node HTTP API (Fastify), SQLite (better-sqlite3), migrations
    jobs/          scheduler: prices, monthly report, backups, (later) watched folder
    web/           React + Vite UI
  data/
    returns/       historical annual returns dataset (with source + license note)
    limits/        yearly contribution limits, RMD table, catch-up ages
  docs/
```

- **Stack:** TypeScript end to end. React + Vite for the UI, Fastify on Node
  for the API, SQLite via better-sqlite3 for storage, Vitest for tests, and
  oxlint for linting.
- **Engines are pure functions.** Data comes in, results go out. Every rule in
  this document has a unit test with a worked example. The Monte Carlo engine is
  tested with a seeded RNG and with a fixed "replay one history" mode.
- **Run locally** with one command (`npm start`), which serves the UI and API
  on `localhost` and starts the scheduler.
- **Scheduler:** in-process (node-cron). Jobs are idempotent and catch up if
  the machine was off.
- **Backups:** a daily copy of the SQLite file to a folder you choose (e.g. a
  synced drive), keeping the last 30. One-click export to CSV/JSON.
- **Security:** binds to `127.0.0.1` by default. Optional passcode. API keys
  for price providers are stored in a local `.env` file, never in the database
  export.

## 15. Open questions

1. **Returns dataset:** confirm the source and that its terms allow bundling it
   in a personal repo.
2. **Automated imports:** which pipeline to build first (watched folder, email
   inbox, or something else). The pipeline is already designed to accept any
   of them.
3. **Institution-specific adapters:** paused. Generic CSV and OFX cover v1.

Decided:

- Household profile is entered in the app (Section 2.1), not in config.
- Price provider: Tiingo by default (Section 10).

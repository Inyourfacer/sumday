/**
 * Database migrations, applied in order and exactly once each.
 *
 * Rules:
 * - Never edit or reorder a migration that has been released; add a new one.
 * - Versions are consecutive integers starting at 1.
 * - Money columns are INTEGER cents; dates are TEXT 'YYYY-MM-DD'.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

// [name, group, budget type, essential]
const DEFAULT_CATEGORIES: [string, string, string, boolean][] = [
  ["Paycheck", "Income", "income", false],
  ["Interest & dividends", "Income", "income", false],
  ["Other income", "Income", "income", false],
  ["Mortgage / rent", "Housing", "fixed", true],
  ["Utilities", "Housing", "fixed", true],
  ["Phone & internet", "Housing", "fixed", true],
  ["Insurance", "Bills", "fixed", true],
  ["Loan payments", "Bills", "fixed", true],
  ["Childcare & tuition", "Bills", "fixed", true],
  ["Subscriptions", "Bills", "fixed", false],
  ["Groceries", "Food", "flex", true],
  ["Restaurants & coffee", "Food", "flex", false],
  ["Gas & transit", "Transportation", "flex", true],
  ["Shopping", "Lifestyle", "flex", false],
  ["Entertainment", "Lifestyle", "flex", false],
  ["Personal care", "Lifestyle", "flex", false],
  ["Health & pharmacy", "Health", "flex", true],
  ["Kids", "Family", "flex", false],
  ["Pets", "Family", "flex", false],
  ["Gifts & donations", "Giving", "flex", false],
  ["Miscellaneous", "Other", "flex", false],
  ["Travel", "Non-monthly", "non_monthly", false],
  ["Car maintenance & registration", "Non-monthly", "non_monthly", true],
  ["Home maintenance", "Non-monthly", "non_monthly", true],
  ["Medical bills", "Non-monthly", "non_monthly", true],
  ["Annual fees & memberships", "Non-monthly", "non_monthly", false],
  ["Holidays", "Non-monthly", "non_monthly", false],
  ["Taxes", "Non-monthly", "non_monthly", true],
];

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "settings",
    sql: `
      -- Key/value store for app and household settings. Values are JSON.
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL CHECK (json_valid(value)),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "accounts, transactions, categories, rules, imports",
    sql: `
      CREATE TABLE people (
        id      INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        -- Everything else about the person (see personSchema), as JSON.
        profile TEXT NOT NULL CHECK (json_valid(profile)),
        sort    INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE accounts (
        id                INTEGER PRIMARY KEY,
        name              TEXT NOT NULL,
        institution       TEXT NOT NULL DEFAULT '',
        type              TEXT NOT NULL,
        tax_treatment     TEXT NOT NULL CHECK (tax_treatment IN ('taxable', 'traditional', 'roth', 'hsa')),
        owner_person_id   INTEGER REFERENCES people (id) ON DELETE SET NULL,
        interest_rate_pct REAL,
        is_closed         INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0, 1)),
        -- Saved CSV column mapping for this account's exports.
        csv_mapping       TEXT CHECK (csv_mapping IS NULL OR json_valid(csv_mapping)),
        created_at        TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE categories (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        group_name   TEXT NOT NULL DEFAULT '',
        budget_type  TEXT NOT NULL CHECK (budget_type IN ('income', 'fixed', 'flex', 'non_monthly', 'transfer')),
        is_essential INTEGER NOT NULL DEFAULT 0 CHECK (is_essential IN (0, 1)),
        -- System categories (Transfer) can't be deleted.
        is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
        sort         INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE rules (
        id         INTEGER PRIMARY KEY,
        priority   INTEGER NOT NULL,
        match      TEXT NOT NULL CHECK (json_valid(match)),
        actions    TEXT NOT NULL CHECK (json_valid(actions)),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE import_batches (
        id              INTEGER PRIMARY KEY,
        account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        format          TEXT NOT NULL CHECK (format IN ('csv', 'ofx')),
        file_name       TEXT NOT NULL,
        file_hash       TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'undone', 'discarded')),
        row_count       INTEGER NOT NULL,
        new_count       INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL,
        errors          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(errors)),
        ledger_balance  TEXT CHECK (ledger_balance IS NULL OR json_valid(ledger_balance)),
        created_at      TEXT NOT NULL DEFAULT ${NOW},
        committed_at    TEXT
      ) STRICT;

      CREATE TABLE transactions (
        id              INTEGER PRIMARY KEY,
        account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        date            TEXT NOT NULL,
        amount          INTEGER NOT NULL,
        payee           TEXT NOT NULL,
        payee_raw       TEXT NOT NULL,
        -- 1 when the user renamed the payee by hand; rules then leave it alone.
        payee_edited    INTEGER NOT NULL DEFAULT 0 CHECK (payee_edited IN (0, 1)),
        memo            TEXT NOT NULL DEFAULT '',
        notes           TEXT NOT NULL DEFAULT '',
        category_id     INTEGER REFERENCES categories (id) ON DELETE SET NULL,
        category_source TEXT CHECK (category_source IN ('rule', 'manual', 'transfer')),
        rule_id         INTEGER REFERENCES rules (id) ON DELETE SET NULL,
        transfer_id     INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
        -- 1 when the user unlinked a transfer; detection then skips this row.
        not_transfer    INTEGER NOT NULL DEFAULT 0 CHECK (not_transfer IN (0, 1)),
        import_batch_id INTEGER REFERENCES import_batches (id) ON DELETE CASCADE,
        status          TEXT NOT NULL CHECK (status IN ('staged', 'posted')),
        dedupe_key      TEXT NOT NULL,
        external_id     TEXT,
        created_at      TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE UNIQUE INDEX transactions_dedupe ON transactions (account_id, dedupe_key);
      CREATE INDEX transactions_account_date ON transactions (account_id, date);
      CREATE INDEX transactions_date ON transactions (date);
      CREATE INDEX transactions_category ON transactions (category_id);
      CREATE INDEX transactions_batch ON transactions (import_batch_id);
      CREATE INDEX transactions_transfer ON transactions (transfer_id);

      CREATE TABLE balance_snapshots (
        id              INTEGER PRIMARY KEY,
        account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        date            TEXT NOT NULL,
        balance         INTEGER NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('manual', 'import')),
        import_batch_id INTEGER REFERENCES import_batches (id) ON DELETE SET NULL,
        UNIQUE (account_id, date)
      ) STRICT;

      INSERT INTO categories (name, group_name, budget_type, is_essential, is_system, sort)
      VALUES ('Transfer', 'Transfers', 'transfer', 0, 1, 1000);
      ${DEFAULT_CATEGORIES.map(
        ([name, group, type, essential], i) =>
          `INSERT INTO categories (name, group_name, budget_type, is_essential, sort) VALUES (${sqlString(name)}, ${sqlString(group)}, '${type}', ${essential ? 1 : 0}, ${(i + 1) * 10});`,
      ).join("\n      ")}
    `,
  },
  {
    version: 3,
    name: "budgets and recurring",
    sql: `
      -- One standing budget per category: monthly for Fixed, yearly for Non-monthly.
      CREATE TABLE category_budgets (
        category_id      INTEGER PRIMARY KEY REFERENCES categories (id) ON DELETE CASCADE,
        amount           INTEGER NOT NULL CHECK (amount >= 0),
        -- Non-monthly sinking fund balance when the fund started.
        starting_balance INTEGER NOT NULL DEFAULT 0,
        updated_at       TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      -- Recurring series the user said aren't really recurring.
      CREATE TABLE recurring_ignored (
        key        TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: "goals and debt details",
    sql: `
      ALTER TABLE accounts ADD COLUMN minimum_payment INTEGER CHECK (minimum_payment IS NULL OR minimum_payment >= 0);
      ALTER TABLE accounts ADD COLUMN promo_rate_pct REAL;
      ALTER TABLE accounts ADD COLUMN promo_ends TEXT;
      -- NULL = default for the type (credit cards are assumed paid in full).
      ALTER TABLE accounts ADD COLUMN pays_in_full INTEGER CHECK (pays_in_full IS NULL OR pays_in_full IN (0, 1));

      CREATE TABLE goals (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        -- The emergency fund is built in; its target is worked out from spending unless set.
        kind          TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('emergency', 'custom')),
        target_amount INTEGER CHECK (target_amount IS NULL OR target_amount >= 0),
        target_date   TEXT,
        priority      INTEGER NOT NULL,
        created_at    TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      -- Money in an account set aside for a goal. Nothing moves; it's a label.
      CREATE TABLE goal_allocations (
        goal_id    INTEGER NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        amount     INTEGER NOT NULL CHECK (amount > 0),
        PRIMARY KEY (goal_id, account_id)
      ) STRICT;

      INSERT INTO goals (name, kind, priority) VALUES ('Emergency fund', 'emergency', 0);
    `,
  },
  {
    version: 5,
    name: "investments",
    sql: `
      -- A fund, ETF, stock or cash position. Funds in 401(k)s often have no ticker.
      CREATE TABLE securities (
        id            INTEGER PRIMARY KEY,
        ticker        TEXT UNIQUE COLLATE NOCASE,
        name          TEXT NOT NULL,
        -- A fund without a ticker can follow a similar one's daily moves.
        proxy_ticker  TEXT,
        -- Annual expense ratio in percent (0.03 = 0.03%).
        expense_ratio REAL CHECK (expense_ratio IS NULL OR expense_ratio >= 0),
        asset_mix     TEXT CHECK (asset_mix IS NULL OR json_valid(asset_mix)),
        mix_source    TEXT CHECK (mix_source IS NULL OR mix_source IN ('known', 'guessed', 'manual')),
        price_error   TEXT,
        created_at    TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE holdings (
        id          INTEGER PRIMARY KEY,
        account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        security_id INTEGER NOT NULL REFERENCES securities (id) ON DELETE CASCADE,
        shares      REAL NOT NULL,
        cost_basis  INTEGER,
        updated_at  TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (account_id, security_id)
      ) STRICT;

      -- Daily closing prices in dollars per share (fund prices go below a cent).
      CREATE TABLE prices (
        security_id INTEGER NOT NULL REFERENCES securities (id) ON DELETE CASCADE,
        date        TEXT NOT NULL,
        close       REAL NOT NULL CHECK (close >= 0),
        source      TEXT NOT NULL CHECK (source IN ('provider', 'import', 'manual', 'proxy')),
        PRIMARY KEY (security_id, date)
      ) STRICT;

      ALTER TABLE accounts ADD COLUMN holdings_mapping TEXT CHECK (holdings_mapping IS NULL OR json_valid(holdings_mapping));
    `,
  },
];

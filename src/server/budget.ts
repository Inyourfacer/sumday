import type { FastifyInstance } from "fastify";
import {
  cashFlow,
  computeBudgetMonth,
  firstDay,
  monthOf,
  monthRange,
  nextMonth,
  suggestBudgets,
  type BudgetCategory,
  type MonthlyActuals,
} from "../engine/budget/budget.ts";
import { netWorthHistory, type AccountHistory } from "../engine/budget/networth.ts";
import { detectRecurring, upcoming, type RecurringInput } from "../engine/budget/recurring.ts";
import { addDays, endOfMonth, todayIn, type IsoDate, type MonthKey } from "../engine/dates.ts";
import type {
  BudgetResponse,
  BudgetSettings,
  BudgetSuggestionsResponse,
  CashFlowResponse,
  NetWorthResponse,
  RecurringResponse,
  TrendsResponse,
} from "../shared/api.ts";
import {
  LIABILITY_TYPES,
  budgetQuerySchema,
  budgetSettingsSchema,
  categoryBudgetsSchema,
  monthsQuerySchema,
  recurringIgnoreSchema,
  type AccountType,
} from "../shared/schemas.ts";
import { getSetting, setSetting, type Db } from "./db.ts";
import { getHousehold } from "./household.ts";
import { badRequest, parse } from "./http.ts";

/** Accounts where money counts as saved or invested. */
const SAVING_TYPES: readonly AccountType[] = ["savings", "brokerage", "401k", "403b", "457", "ira", "roth_ira", "hsa", "529"];

export function today(db: Db): IsoDate {
  return todayIn(getHousehold(db).timeZone);
}

export function getBudgetSettings(db: Db): BudgetSettings {
  const stored = getSetting<Partial<BudgetSettings>>(db, "budget") ?? {};
  return { expectedIncome: stored.expectedIncome ?? null, plannedSavings: stored.plannedSavings ?? 0, fundStart: stored.fundStart ?? null };
}

export function loadBudgetCategories(db: Db): BudgetCategory[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.group_name, c.budget_type, c.is_essential, b.amount, b.starting_balance
       FROM categories c LEFT JOIN category_budgets b ON b.category_id = c.id ORDER BY c.sort, c.name`,
    )
    .all() as {
    id: number;
    name: string;
    group_name: string;
    budget_type: BudgetCategory["budgetType"];
    is_essential: number;
    amount: number | null;
    starting_balance: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    group: r.group_name,
    budgetType: r.budget_type,
    isEssential: r.is_essential === 1,
    budget: r.amount,
    startingBalance: r.starting_balance ?? 0,
  }));
}

/** Net posted amount per category per month, for months from..to inclusive. */
export function loadActuals(db: Db, from: MonthKey, to: MonthKey): Map<number, Map<MonthKey, number>> {
  const rows = db
    .prepare(
      `SELECT category_id AS id, substr(date, 1, 7) AS month, SUM(amount) AS total
       FROM transactions
       WHERE status = 'posted' AND category_id IS NOT NULL AND date >= ? AND date < ?
       GROUP BY category_id, month`,
    )
    .all(firstDay(from), firstDay(nextMonth(to))) as { id: number; month: string; total: number }[];
  const map = new Map<number, Map<MonthKey, number>>();
  for (const r of rows) {
    const inner = map.get(r.id) ?? new Map<MonthKey, number>();
    inner.set(r.month, r.total);
    map.set(r.id, inner);
  }
  return map;
}

function loadUncategorized(db: Db, from: MonthKey, to: MonthKey): Map<MonthKey, { out: number; in: number }> {
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
         SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS out_total,
         SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS in_total
       FROM transactions
       WHERE status = 'posted' AND category_id IS NULL AND date >= ? AND date < ?
       GROUP BY month`,
    )
    .all(firstDay(from), firstDay(nextMonth(to))) as { month: string; out_total: number; in_total: number }[];
  return new Map(rows.map((r) => [r.month, { out: r.out_total, in: r.in_total }]));
}

/**
 * Money moved into savings/investment accounts from other accounts, minus
 * money moved back out, per month. Based on linked transfers.
 */
function loadMovedToSavings(db: Db, from: MonthKey, to: MonthKey): Map<MonthKey, number> {
  const rows = db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month, t.amount, a.type AS type, pa.type AS partner_type
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN transactions p ON p.id = t.transfer_id
       JOIN accounts pa ON pa.id = p.account_id
       WHERE t.status = 'posted' AND t.amount > 0 AND t.date >= ? AND t.date < ?`,
    )
    .all(firstDay(from), firstDay(nextMonth(to))) as { month: string; amount: number; type: AccountType; partner_type: AccountType }[];
  const map = new Map<MonthKey, number>();
  for (const r of rows) {
    const intoSaving = SAVING_TYPES.includes(r.type);
    const fromSaving = SAVING_TYPES.includes(r.partner_type);
    if (intoSaving === fromSaving) continue;
    map.set(r.month, (map.get(r.month) ?? 0) + (intoSaving ? r.amount : -r.amount));
  }
  return map;
}

/** The earliest month with posted transactions, if any. */
function firstDataMonth(db: Db): MonthKey | null {
  const row = db.prepare("SELECT MIN(date) AS d FROM transactions WHERE status = 'posted'").get() as { d: string | null };
  return row.d === null ? null : monthOf(row.d);
}

function lastMonths(current: MonthKey, count: number): MonthKey[] {
  return monthRange(nextMonth(current, -(count - 1)), current);
}

export function budgetFor(db: Db, month: MonthKey): BudgetResponse {
  const settings = getBudgetSettings(db);
  const now = today(db);
  const categories = loadBudgetCategories(db);
  const from = settings.fundStart !== null && settings.fundStart < month ? settings.fundStart : month;
  const actuals = loadActuals(db, from, month);
  const uncategorized = loadUncategorized(db, month, month).get(month) ?? { out: 0, in: 0 };
  const budget = computeBudgetMonth({
    month,
    today: now,
    categories,
    actuals,
    uncategorizedOut: uncategorized.out,
    uncategorizedIn: uncategorized.in,
    expectedIncome: settings.expectedIncome,
    plannedSavings: settings.plannedSavings,
    actualSavings: loadMovedToSavings(db, month, month).get(month) ?? 0,
    fundStart: settings.fundStart,
  });
  return { budget, settings, today: now };
}

function accountHistories(db: Db): AccountHistory[] {
  const accounts = db.prepare("SELECT id, type FROM accounts").all() as { id: number; type: AccountType }[];
  const snaps = db.prepare("SELECT account_id, date, balance FROM balance_snapshots ORDER BY date").all() as {
    account_id: number;
    date: string;
    balance: number;
  }[];
  const txns = db.prepare("SELECT account_id, date, amount FROM transactions WHERE status = 'posted' ORDER BY date").all() as {
    account_id: number;
    date: string;
    amount: number;
  }[];
  return accounts.map((a) => ({
    id: a.id,
    isLiability: LIABILITY_TYPES.includes(a.type),
    snapshots: snaps.filter((s) => s.account_id === a.id).map((s) => ({ date: s.date, balance: s.balance })),
    transactions: txns.filter((t) => t.account_id === a.id).map((t) => ({ date: t.date, amount: t.amount })),
  }));
}

export function netWorth(db: Db, months: number): NetWorthResponse {
  const now = today(db);
  // Month-end balances; the current month includes everything posted so far,
  // matching the balances on the Accounts page.
  const ends = lastMonths(monthOf(now), months).map((m) => ({ month: m, date: endOfMonth(firstDay(m)) }));
  const points = netWorthHistory(accountHistories(db), ends);
  const change = points.length >= 2 ? points.at(-1)!.netWorth - points.at(-2)!.netWorth : null;
  return { points, change };
}

export function recurring(db: Db): RecurringResponse {
  const now = today(db);
  // Money moving between your own accounts is only counted from the paying side.
  const rows = db
    .prepare(
      `SELECT id, account_id AS accountId, date, amount, payee, category_id AS categoryId
       FROM transactions
       WHERE status = 'posted' AND date >= ? AND NOT (transfer_id IS NOT NULL AND amount > 0)`,
    )
    .all(addDays(now, -800)) as RecurringInput[];
  const ignored = new Set((db.prepare("SELECT key FROM recurring_ignored").all() as { key: string }[]).map((r) => r.key));
  const accountNames = new Map((db.prepare("SELECT id, name FROM accounts").all() as { id: number; name: string }[]).map((a) => [a.id, a.name]));
  const categoryNames = new Map((db.prepare("SELECT id, name FROM categories").all() as { id: number; name: string }[]).map((c) => [c.id, c.name]));
  const series = detectRecurring(rows, now);
  const names = (accountId: number, categoryId: number | null) => ({
    accountName: accountNames.get(accountId) ?? "",
    categoryName: categoryId === null ? null : (categoryNames.get(categoryId) ?? null),
  });
  return {
    series: series.map((s) => ({ ...s, ...names(s.accountId, s.categoryId), ignored: ignored.has(s.key) })),
    upcoming: upcoming(
      series.filter((s) => !ignored.has(s.key)),
      now,
      addDays(now, 45),
    ).map((u) => ({ ...u, ...names(u.accountId, u.categoryId) })),
    today: now,
  };
}

export function registerBudgetRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/budget", async (request) => {
    const { month } = parse(budgetQuerySchema, request.query);
    return budgetFor(db, month ?? monthOf(today(db)));
  });

  app.put("/api/budget/settings", async (request) => {
    const patch = parse(budgetSettingsSchema, request.body);
    const current = getBudgetSettings(db);
    setSetting(db, "budget", {
      expectedIncome: patch.expectedIncome === undefined ? current.expectedIncome : patch.expectedIncome,
      plannedSavings: patch.plannedSavings ?? current.plannedSavings,
      fundStart: patch.fundStart === undefined ? current.fundStart : patch.fundStart,
    });
    return getBudgetSettings(db);
  });

  app.put("/api/budget/categories", async (request) => {
    const { items } = parse(categoryBudgetsSchema, request.body);
    const known = new Map(loadBudgetCategories(db).map((c) => [c.id, c]));
    for (const item of items) {
      const category = known.get(item.categoryId);
      if (!category) throw badRequest("That category doesn't exist.");
      if (category.budgetType !== "fixed" && category.budgetType !== "non_monthly") {
        throw badRequest(`“${category.name}” is ${category.budgetType}; only Fixed and Non-monthly categories have their own budget.`);
      }
    }
    db.transaction(() => {
      const upsert = db.prepare(
        `INSERT INTO category_budgets (category_id, amount, starting_balance) VALUES (?, ?, ?)
         ON CONFLICT (category_id) DO UPDATE SET amount = excluded.amount,
           starting_balance = COALESCE(?, starting_balance), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      );
      const remove = db.prepare("DELETE FROM category_budgets WHERE category_id = ?");
      for (const item of items) {
        if (item.amount === null) remove.run(item.categoryId);
        else upsert.run(item.categoryId, item.amount, item.startingBalance ?? 0, item.startingBalance ?? null);
      }
      // Sinking funds start the first time a budget is saved.
      const settings = getBudgetSettings(db);
      if (settings.fundStart === null) setSetting(db, "budget", { ...settings, fundStart: monthOf(today(db)) });
    })();
    return loadBudgetCategories(db).filter((c) => c.budget !== null);
  });

  app.get("/api/budget/suggestions", async (): Promise<BudgetSuggestionsResponse> => {
    const current = monthOf(today(db));
    const first = firstDataMonth(db);
    const complete = first === null ? [] : monthRange(first, nextMonth(current, -1)).slice(-12);
    const categories = loadBudgetCategories(db);
    const actuals = complete.length > 0 ? loadActuals(db, complete[0]!, complete.at(-1)!) : new Map();
    const s = suggestBudgets(categories, actuals as MonthlyActuals, complete);
    const byId = new Map(categories.map((c) => [c.id, c]));
    return {
      expectedIncome: s.expectedIncome,
      budgets: s.budgets.map((b) => {
        const c = byId.get(b.categoryId)!;
        return { categoryId: b.categoryId, name: c.name, budgetType: c.budgetType, amount: b.amount, current: c.budget };
      }),
      basedOnMonths: s.basedOnMonths,
    };
  });

  app.get("/api/cashflow", async (request): Promise<CashFlowResponse> => {
    const { months } = parse(monthsQuerySchema, request.query);
    const range = lastMonths(monthOf(today(db)), months);
    const from = range[0]!;
    const to = range.at(-1)!;
    const uncategorized = loadUncategorized(db, from, to);
    const rows = cashFlow(
      range,
      loadBudgetCategories(db),
      loadActuals(db, from, to),
      new Map([...uncategorized].map(([m, v]) => [m, v.out])),
      loadMovedToSavings(db, from, to),
    );
    // Averages skip the current month and months before there was any data.
    const first = firstDataMonth(db);
    const complete = rows.slice(0, -1).filter((r) => first !== null && r.month >= first);
    const avg = (pick: (r: (typeof rows)[number]) => number) =>
      complete.length === 0 ? 0 : Math.round(complete.reduce((s, r) => s + pick(r), 0) / complete.length);
    const income = avg((r) => r.income);
    const spending = avg((r) => r.spending);
    return {
      months: rows,
      averages: {
        income,
        spending,
        net: income - spending,
        savingsRate: income > 0 ? (income - spending) / income : null,
        movedToSavings: avg((r) => r.movedToSavings),
      },
    };
  });

  app.get("/api/trends", async (request): Promise<TrendsResponse> => {
    const { months } = parse(monthsQuerySchema, request.query);
    const range = lastMonths(monthOf(today(db)), months);
    const actuals = loadActuals(db, range[0]!, range.at(-1)!);
    const uncategorized = loadUncategorized(db, range[0]!, range.at(-1)!);
    const first = firstDataMonth(db);
    const completeIdx = range.map((m, i) => (i < range.length - 1 && first !== null && m >= first ? i : -1)).filter((i) => i >= 0);
    const average = (values: number[]) =>
      completeIdx.length === 0 ? 0 : Math.round(completeIdx.reduce((s, i) => s + values[i]!, 0) / completeIdx.length);

    const rows: TrendsResponse["rows"] = [];
    for (const c of loadBudgetCategories(db)) {
      if (c.budgetType === "transfer") continue;
      const sign = c.budgetType === "income" ? 1 : -1;
      const values = range.map((m) => {
        const v = sign * (actuals.get(c.id)?.get(m) ?? 0);
        return v === 0 ? 0 : v;
      });
      if (values.every((v) => v === 0)) continue;
      rows.push({ categoryId: c.id, name: c.name, group: c.group, budgetType: c.budgetType, values, average: average(values) });
    }
    const uncat = range.map((m) => uncategorized.get(m)?.out ?? 0);
    if (uncat.some((v) => v !== 0)) {
      rows.push({ categoryId: null, name: "Uncategorized", group: "", budgetType: "uncategorized", values: uncat, average: average(uncat) });
    }
    return { months: range, rows };
  });

  app.get("/api/recurring", async () => recurring(db));

  app.post("/api/recurring/ignore", async (request) => {
    const { key } = parse(recurringIgnoreSchema, request.body);
    db.prepare("INSERT OR IGNORE INTO recurring_ignored (key) VALUES (?)").run(key);
    return recurring(db);
  });

  app.delete("/api/recurring/ignore", async (request) => {
    const { key } = parse(recurringIgnoreSchema, request.query);
    db.prepare("DELETE FROM recurring_ignored WHERE key = ?").run(key);
    return recurring(db);
  });

  app.get("/api/networth", async (request) => {
    const { months } = parse(monthsQuerySchema, request.query);
    return netWorth(db, months);
  });
}

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextMonth } from "../engine/budget/budget.ts";
import type {
  AccountView,
  BudgetResponse,
  BudgetSuggestionsResponse,
  CashFlowResponse,
  CategoryView,
  NetWorthResponse,
  RecurringResponse,
  TrendsResponse,
} from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, type Db } from "./db.ts";

let db: Db;
let app: FastifyInstance;

async function ok<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}
async function status(method: "PUT" | "POST", url: string, body: unknown): Promise<number> {
  return (await app.inject({ method, url, payload: body as object })).statusCode;
}

let thisMonth: string;
let cats: Map<string, number>;
let checking: AccountView;
let card: AccountView;
let savings: AccountView;

const day = (month: string, d: number) => `${month}-${String(d).padStart(2, "0")}`;

beforeEach(async () => {
  db = openDb(":memory:");
  app = await buildApp({ db });
  thisMonth = (await ok<BudgetResponse>("GET", "/api/budget")).budget.month;
  cats = new Map((await ok<CategoryView[]>("GET", "/api/categories")).map((c) => [c.name, c.id]));
  checking = await ok<AccountView>("POST", "/api/accounts", { name: "Checking", type: "checking" });
  card = await ok<AccountView>("POST", "/api/accounts", { name: "Card", type: "credit_card" });
  savings = await ok<AccountView>("POST", "/api/accounts", { name: "Savings", type: "savings" });

  const add = (accountId: number, date: string, amount: number, payee: string, category?: string) =>
    ok("POST", "/api/transactions", {
      accountId,
      date,
      amount,
      payee,
      ...(category ? { categoryId: cats.get(category) } : {}),
    });

  // Three complete months plus the current one.
  for (let back = 3; back >= 0; back--) {
    const m = nextMonth(thisMonth, -back);
    await add(checking.id, day(m, 1), 500_000, "ACME PAYROLL", "Paycheck");
    await add(checking.id, day(m, 2), -200_000, "Landlord", "Mortgage / rent");
    await add(card.id, day(m, 5), -1_549, "Netflix.com", "Subscriptions");
    await add(card.id, day(m, 12), -30_000, "Trader Joe's", "Groceries");
    // Moving money to savings: both sides, linked automatically as a transfer.
    await add(checking.id, day(m, 10), -50_000, "To savings");
    await add(savings.id, day(m, 10), 50_000, "From checking");
  }
  await add(card.id, day(nextMonth(thisMonth, -2), 20), -60_000, "Airline", "Travel");
  await add(card.id, day(thisMonth, 3), -4_000, "Mystery shop"); // uncategorized
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe("budget", () => {
  it("suggests budgets from complete months", async () => {
    const s = await ok<BudgetSuggestionsResponse>("GET", "/api/budget/suggestions");
    expect(s.expectedIncome).toBe(500_000);
    expect(s.basedOnMonths).toHaveLength(3);
    expect(s.budgets.map((b) => [b.name, b.amount])).toEqual([
      ["Mortgage / rent", 200_000],
      ["Subscriptions", 1_500],
      ["Travel", 240_000], // $600 in 3 months → $2,400 a year
    ]);
  });

  it("computes this month's Flex pool after budgets are set", async () => {
    await ok("PUT", "/api/budget/categories", {
      items: [
        { categoryId: cats.get("Mortgage / rent"), amount: 200_000 },
        { categoryId: cats.get("Subscriptions"), amount: 1_500 },
        { categoryId: cats.get("Travel"), amount: 240_000 },
      ],
    });
    await ok("PUT", "/api/budget/settings", { expectedIncome: 500_000, plannedSavings: 50_000 });
    const { budget, settings } = await ok<BudgetResponse>("GET", "/api/budget");

    expect(settings.fundStart).toBe(thisMonth);
    expect(budget.timing).toBe("current");
    expect(budget.fixed.budget).toBe(201_500);
    expect(budget.nonMonthly.setAside).toBe(20_000);
    // 5,000 − 2,015 − 200 − 500
    expect(budget.flex.budget).toBe(228_500);
    // groceries $300 + uncategorized $40
    expect(budget.flex.actual).toBe(34_000);
    expect(budget.flex.uncategorized).toBe(4_000);
    expect(budget.savings).toEqual({ planned: 50_000, actual: 50_000 });
    expect(budget.income.actual).toBe(500_000);
    // Transfers aren't spending.
    expect(budget.totals.spending).toBe(200_000 + 1_549 + 34_000);

    // A past month: Travel's fund started this month, so last month just shows spending.
    const past = (await ok<BudgetResponse>("GET", `/api/budget?month=${nextMonth(thisMonth, -2)}`)).budget;
    expect(past.timing).toBe("past");
    expect(past.nonMonthly.lines.find((l) => l.name === "Travel")?.actual).toBe(60_000);
  });

  it("only budgets Fixed and Non-monthly categories, and converts on type change", async () => {
    expect(await status("PUT", "/api/budget/categories", { items: [{ categoryId: cats.get("Groceries"), amount: 100 }] })).toBe(400);
    await ok("PUT", "/api/budget/categories", { items: [{ categoryId: cats.get("Subscriptions"), amount: 1_500 }] });
    await ok("PATCH", `/api/categories/${cats.get("Subscriptions")}`, { budgetType: "non_monthly" });
    let b = (await ok<BudgetResponse>("GET", "/api/budget")).budget;
    expect(b.nonMonthly.lines.find((l) => l.name === "Subscriptions")?.annual).toBe(18_000);
    await ok("PATCH", `/api/categories/${cats.get("Subscriptions")}`, { budgetType: "flex" });
    b = (await ok<BudgetResponse>("GET", "/api/budget")).budget;
    expect(b.flex.lines.find((l) => l.name === "Subscriptions")?.actual).toBe(1_549);
    await ok("PUT", "/api/budget/categories", { items: [{ categoryId: cats.get("Travel"), amount: null }] });
  });

  it("rejects a bad month", async () => {
    expect((await app.inject({ method: "GET", url: "/api/budget?month=2026-13" })).statusCode).toBe(400);
  });
});

describe("cash flow and trends", () => {
  it("totals each month and averages the complete ones", async () => {
    const cf = await ok<CashFlowResponse>("GET", "/api/cashflow?months=6");
    // Months before the first transaction are left out.
    expect(cf.months).toHaveLength(4);
    expect(cf.months.at(-1)!.month).toBe(thisMonth);
    const last = cf.months.at(-2)!;
    expect(last).toMatchObject({ income: 500_000, fixed: 201_549, flex: 30_000, movedToSavings: 50_000 });
    expect(cf.averages.income).toBe(500_000);
    expect(cf.averages.spending).toBe(Math.round((231_549 * 3 + 60_000) / 3));
    expect(cf.averages.movedToSavings).toBe(50_000);
  });

  it("lists spending by category per month", async () => {
    const t = await ok<TrendsResponse>("GET", "/api/trends?months=4");
    expect(t.months).toHaveLength(4);
    const groceries = t.rows.find((r) => r.name === "Groceries")!;
    expect(groceries.values).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(groceries.average).toBe(30_000);
    expect(t.rows.find((r) => r.name === "Paycheck")?.values[0]).toBe(500_000);
    expect(t.rows.find((r) => r.name === "Uncategorized")?.values.at(-1)).toBe(4_000);
    expect(t.rows.some((r) => r.name === "Transfer")).toBe(false);
  });
});

describe("recurring", () => {
  it("finds bills, paychecks and transfers, and can ignore one", async () => {
    let r = await ok<RecurringResponse>("GET", "/api/recurring");
    const names = r.series.map((s) => `${s.payee}:${s.frequency}`).sort();
    expect(names).toEqual(["ACME PAYROLL:monthly", "Landlord:monthly", "Netflix.com:monthly", "To savings:monthly", "Trader Joe's:monthly"]);
    const netflix = r.series.find((s) => s.payee === "Netflix.com")!;
    expect(netflix).toMatchObject({ accountName: "Card", categoryName: "Subscriptions", amount: -1_549, active: true, ignored: false, isTransfer: false });
    expect(r.series.find((s) => s.payee === "To savings")?.isTransfer).toBe(true);
    expect(r.upcoming.some((u) => u.payee === "Netflix.com")).toBe(true);

    r = await ok<RecurringResponse>("POST", "/api/recurring/ignore", { key: netflix.key });
    expect(r.series.find((s) => s.key === netflix.key)?.ignored).toBe(true);
    expect(r.upcoming.some((u) => u.payee === "Netflix.com")).toBe(false);

    r = await ok<RecurringResponse>("DELETE", `/api/recurring/ignore?key=${encodeURIComponent(netflix.key)}`);
    expect(r.series.find((s) => s.key === netflix.key)?.ignored).toBe(false);
  });
});

describe("net worth", () => {
  it("builds monthly history from transactions and snapshots", async () => {
    const nw = await ok<NetWorthResponse>("GET", "/api/networth?months=6");
    // Data starts 3 months back, so 4 points.
    expect(nw.points).toHaveLength(4);
    expect(nw.points[0]!.month).toBe(nextMonth(thisMonth, -3));
    const accounts = await ok<AccountView[]>("GET", "/api/accounts");
    const current = accounts.reduce((s, a) => s + a.balance, 0);
    expect(nw.points.at(-1)!.netWorth).toBe(current);
    expect(nw.points.at(-1)!.liabilities).toBe(accounts.find((a) => a.id === card.id)!.balance);
    expect(nw.change).toBe(nw.points.at(-1)!.netWorth - nw.points.at(-2)!.netWorth);
  });
});

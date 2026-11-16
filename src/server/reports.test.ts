import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstDay, monthOf, nextMonth } from "../engine/budget/budget.ts";
import { addDays } from "../engine/dates.ts";
import type { AccountView, BackupsResponse, BudgetResponse, CategoryView, MonthlyReport, ReportsResponse } from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { ensureDailyBackup, listBackups, pruneBackups } from "./backup.ts";
import { openDb, type Db } from "./db.ts";
import { ensureLastMonthReport } from "./reports.ts";

let db: Db;
let app: FastifyInstance;
let dir: string;
let now: string;

async function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) {
  return app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
}
async function ok<T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await call(method, url, body);
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sumday-test-"));
  db = openDb(join(dir, "sumday.db"));
  app = await buildApp({ db, backupDir: join(dir, "backups") });
  now = (await ok<BudgetResponse>("GET", "/api/budget")).today;
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed() {
  const checking = await ok<AccountView>("POST", "/api/accounts", { name: "Checking", type: "checking" });
  const cats = await ok<CategoryView[]>("GET", "/api/categories");
  const groceries = cats.find((c) => c.name === "Groceries")!;
  const paycheck = cats.find((c) => c.budgetType === "income")!;
  const last = nextMonth(monthOf(now), -1);
  const prior = nextMonth(last, -1);
  await ok("POST", `/api/accounts/${checking.id}/balances`, { date: addDays(firstDay(prior), -1), balance: 200_000 });
  for (const [m, food] of [
    [prior, -40_000],
    [last, -70_000],
  ] as const) {
    await ok("POST", "/api/transactions", { accountId: checking.id, date: `${m}-05`, amount: 500_000, payee: "Employer", categoryId: paycheck.id });
    await ok("POST", "/api/transactions", { accountId: checking.id, date: `${m}-10`, amount: food, payee: "Market", categoryId: groceries.id });
  }
  return { last, prior };
}

describe("monthly report", () => {
  it("reports last month's budget, categories and net worth change", async () => {
    const { last } = await seed();
    const r = await ok<MonthlyReport>("POST", `/api/reports/${last}`);
    expect(r.month).toBe(last);
    expect(r.budget.income).toBe(500_000);
    expect(r.budget.spending).toBe(70_000);
    expect(r.budget.savingsRate).toBeCloseTo(0.86, 2);
    expect(r.topCategories[0]).toMatchObject({ name: "Groceries", actual: 70_000 });
    expect(r.netWorth).toMatchObject({ change: 430_000, fromCashFlow: 430_000, marketAndOther: 0 });
    expect(r.dataHealth.uncategorized).toBe(0);

    const list = await ok<ReportsResponse>("GET", "/api/reports");
    expect(list.lastMonth).toBe(last);
    expect(list.reports.map((x) => x.month)).toEqual([last]);
    expect((await ok<MonthlyReport>("GET", `/api/reports/${last}`)).budget.spending).toBe(70_000);
    expect((await call("GET", "/api/reports/1999-01")).statusCode).toBe(404);
    expect((await call("POST", `/api/reports/${nextMonth(monthOf(now), 2)}`)).statusCode).toBe(400);
  });

  it("the scheduler makes last month's report once", async () => {
    expect(ensureLastMonthReport(db)).toBeNull(); // no data yet
    const { last } = await seed();
    expect(ensureLastMonthReport(db)).toBe(last);
    expect(ensureLastMonthReport(db)).toBeNull();
  });
});

describe("backups and export", () => {
  it("backs up on demand and once a day, keeping the newest 30", async () => {
    const made = await ok<BackupsResponse["backups"][number]>("POST", "/api/backups");
    expect(made.name).toMatch(/^sumday-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    const copy = new Database(join(dir, "backups", made.name), { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number }).n).toBeGreaterThan(10);
    copy.close();

    // The manual backup counts for today.
    expect(await ensureDailyBackup(db, join(dir, "backups"))).toBeNull();

    for (let i = 1; i <= 35; i++) {
      const name = join(dir, "backups", `sumday-${addDays(now, -i)}.db`);
      writeFileSync(name, "x");
      utimesSync(name, new Date(), new Date());
    }
    expect(pruneBackups(join(dir, "backups"))).toHaveLength(6);
    const left = listBackups(join(dir, "backups"));
    expect(left).toHaveLength(30);
    expect(left[0]!.name).toBe(made.name);
    expect((await ok<BackupsResponse>("GET", "/api/backups")).backups).toHaveLength(30);
  });

  it("exports everything as JSON and transactions as CSV", async () => {
    await seed();
    const acct = await ok<AccountView>("POST", "/api/accounts", { name: "Card", type: "credit_card" });
    await ok("POST", "/api/transactions", { accountId: acct.id, date: now, amount: -1_234, payee: '=HYPERLINK("x"), "quoted"' });

    const json = await call("GET", "/api/export/json");
    expect(json.headers["content-disposition"]).toContain("attachment");
    const data = json.json() as { schemaVersion: number; tables: Record<string, Record<string, unknown>[]> };
    expect(data.schemaVersion).toBe(6);
    expect(data.tables.transactions).toHaveLength(5);
    expect(typeof data.tables.people).toBe("object");
    expect(data.tables.settings!.every((s) => typeof s.value !== "string" || !String(s.value).startsWith("{"))).toBe(true);

    const csv = await call("GET", "/api/export/transactions.csv");
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe("date,account,payee,original_payee,amount,category,category_group,memo,notes,transfer,id");
    expect(lines).toHaveLength(6);
    const card = lines.find((l) => l.includes("Card"))!;
    expect(card).toContain(`"'=HYPERLINK(""x""), ""quoted"""`);
    expect(card).toContain(",-12.34,");
  });
});

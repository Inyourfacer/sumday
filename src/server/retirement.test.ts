import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextMonth } from "../engine/budget/budget.ts";
import type { AccountView, BudgetResponse, CategoryView, RetirementResponse } from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, type Db } from "./db.ts";

let db: Db;
let app: FastifyInstance;
let today: string;

async function call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown) {
  const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}
async function ok<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await call<T>(method, url, body);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

beforeEach(async () => {
  db = openDb(":memory:");
  app = await buildApp({ db });
  today = (await ok<BudgetResponse>("GET", "/api/budget")).today;
});
afterEach(async () => {
  await app.close();
  db.close();
});

async function household() {
  const saved = await ok<{ people: { id: number }[] }>("PUT", "/api/household", {
    household: { filingStatus: "married_joint", planningHorizonAge: 95 },
    people: [
      {
        name: "Alex",
        birthDate: "1986-04-12",
        income: 12_000_000,
        retirementAge: 65,
        socialSecurity: { at62: null, atFra: 300_000, at70: null },
        ssClaimAge: 67,
        employerPlan: { type: "401k", pretaxPct: 6, matchTiers: [{ matchPct: 100, upToPct: 4 }] },
      },
      { name: "Sam", birthDate: "1988-09-30", income: 0, socialSecurity: { at62: null, atFra: 120_000, at70: null } },
    ],
  });
  const alex = saved.people[0]!.id;
  const make = async (body: object, balance: number) => {
    const a = await ok<AccountView>("POST", "/api/accounts", body);
    await ok("POST", `/api/accounts/${a.id}/balances`, { date: today, balance });
  };
  await make({ name: "401(k)", type: "401k", ownerPersonId: alex }, 15_000_000);
  await make({ name: "Roth IRA", type: "roth_ira", ownerPersonId: alex }, 4_000_000);
  await make({ name: "Brokerage", type: "brokerage" }, 6_000_000);
  await make({ name: "Savings", type: "savings" }, 2_000_000); // emergency fund: not counted
  const checking = await ok<AccountView>("POST", "/api/accounts", { name: "Checking", type: "checking" });
  const cats = new Map((await ok<CategoryView[]>("GET", "/api/categories")).map((c) => [c.name, c.id]));
  for (let back = 3; back >= 1; back--) {
    const m = nextMonth(today.slice(0, 7), -back);
    await ok("POST", "/api/transactions", { accountId: checking.id, date: `${m}-05`, amount: -250_000, payee: "Rent", categoryId: cats.get("Mortgage / rent") });
    await ok("POST", "/api/transactions", { accountId: checking.id, date: `${m}-10`, amount: -80_000, payee: "Grocer", categoryId: cats.get("Groceries") });
  }
  // Fewer runs keep the tests quick.
  await ok("PUT", "/api/retirement/settings", { runs: 1000 });
  return { alex, cats };
}

describe("retirement", () => {
  it("says what's missing before it can run", async () => {
    const r = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(r.ready).toBe(false);
    expect(r.missing[0]).toMatch(/adults/);
    await ok("PUT", "/api/household", { household: {}, people: [{ name: "Alex" }] });
    expect((await ok<RetirementResponse>("GET", "/api/retirement")).missing).toEqual(["Add Alex's birth date."]);
  });

  it("builds inputs from the household, accounts and budget, and runs", async () => {
    await household();
    const r = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(r.ready).toBe(true);
    const i = r.inputs!;
    const year = Number(today.slice(0, 4));
    expect(i.startYear).toBe(year);
    expect(i.retireYear).toBe(2051); // Alex: 1986 + 65; Sam has no paycheck
    expect(i.endYear).toBe(1988 + 95);
    expect(i.balances).toEqual({ taxable: 6_000_000, traditional: 15_000_000, roth: 4_000_000, hsa: 0, total: 25_000_000 });
    // FRA 67 for both; Alex claims at 67.
    expect(i.people.map((p) => [p.name, p.socialSecurityMonthly, p.rmdStartAge])).toEqual([
      ["Alex", 300_000, 75],
      ["Sam", 120_000, 75],
    ]);
    expect(i.allocation).toEqual({ stocks: 0.9, bonds: 0.1, cash: 0 });
    // Spending: rent $2,500 + groceries $800 a month = $39,600 a year.
    expect(i.spending.firstYear).toBe(3_960_000);
    expect(i.spending.categories.map((c) => c.name)).toEqual(["Mortgage / rent", "Groceries"]);

    const res = r.result!;
    expect(res.runs).toBe(1000);
    expect(res.successRate).toBeGreaterThan(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
    expect(res.bands).toHaveLength(i.endYear - year + 1);
    expect(res.bands[0]!.p10).toBeLessThanOrEqual(res.bands[0]!.p90);
    expect(r.whatIfs!.retireAt.map((x) => x.shift)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(r.sources.returnsYears).toBe("1928–2025");

    // Same inputs, same answer.
    expect((await ok<RetirementResponse>("GET", "/api/retirement")).result!.successRate).toBe(res.successRate);
  });

  it("adjusts retirement spending by category, timed items and one-offs", async () => {
    const { cats } = await household();
    const base = await ok<RetirementResponse>("GET", "/api/retirement");
    const r = await ok<RetirementResponse>("PUT", "/api/retirement/settings", {
      spending: {
        categoryOverrides: { [String(cats.get("Mortgage / rent"))]: 1_200_000 },
        items: [{ label: "Travel", amount: 600_000, fromAge: 65, toAge: 75 }],
        oneOffs: [{ label: "New roof", amount: 2_500_000, age: 70, everyYears: null }],
      },
    });
    // $12,000 housing + $9,600 groceries + $6,000 travel in the first year (age 65).
    expect(r.inputs!.spending.firstYear).toBe(1_200_000 + 960_000 + 600_000);
    expect(r.result!.successRate).toBeGreaterThanOrEqual(base.result!.successRate);
    expect(r.inputs!.spending.items).toHaveLength(1);
  });

  it("validates settings", async () => {
    expect((await call("PUT", "/api/retirement/settings", { successTarget: 1.5 })).status).toBe(400);
    expect((await call("PUT", "/api/retirement/settings", { runs: 10 })).status).toBe(400);
    expect(
      (await call("PUT", "/api/retirement/settings", { spending: { categoryOverrides: {}, items: [{ label: "", amount: 1, fromAge: null, toAge: null }], oneOffs: [] } })).status,
    ).toBe(400);
    const r = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { successTarget: 0.9, ordinaryTaxPct: 20 });
    expect(r.settings).toMatchObject({ successTarget: 0.9, ordinaryTaxPct: 20, capitalGainsPct: 15 });
  });
});

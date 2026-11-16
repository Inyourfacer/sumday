import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountView, BudgetResponse, HouseholdResponse, InvestmentsResponse, RetirementResponse, ScenarioComparison, ScenarioView } from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, type Db } from "./db.ts";

let db: Db;
let app: FastifyInstance;
let alexId: number;
let samId: number;

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
  const today = (await ok<BudgetResponse>("GET", "/api/budget")).today;
  const hh = await ok<HouseholdResponse>("PUT", "/api/household", {
    household: {},
    people: [
      { name: "Alex", birthDate: "1980-01-01", income: 10_000_000, retirementAge: 65, socialSecurity: { at62: null, atFra: 250_000, at70: null } },
      { name: "Sam", birthDate: "1982-01-01", income: 6_000_000, retirementAge: 65, socialSecurity: { at62: null, atFra: 150_000, at70: null } },
    ],
  });
  [alexId, samId] = [hh.people[0]!.id, hh.people[1]!.id];
  const k = await ok<AccountView>("POST", "/api/accounts", { name: "401(k)", type: "401k", ownerPersonId: alexId });
  await ok("POST", `/api/accounts/${k.id}/balances`, { date: today, balance: 40_000_000 });
  const b = await ok<AccountView>("POST", "/api/accounts", { name: "Brokerage", type: "brokerage" });
  await ok("POST", `/api/accounts/${b.id}/balances`, { date: today, balance: 10_000_000 });
  await ok("PUT", "/api/retirement/settings", {
    runs: 1000,
    spending: { categoryOverrides: {}, items: [{ label: "Living costs", amount: 7_000_000, fromAge: null, toAge: null }], oneOffs: [] },
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe("scenarios", () => {
  it("creates, lists, edits and deletes scenarios with readable summaries", async () => {
    const s = await ok<ScenarioView>("POST", "/api/scenarios", {
      name: "Retire early",
      overrides: [
        { type: "retirement_age", personId: alexId, age: 58 },
        { type: "retirement_age", personId: samId, age: 58 },
      ],
    });
    expect(s.summary).toEqual(["Alex retires at 58", "Sam retires at 58"]);
    const edited = await ok<ScenarioView>("PATCH", `/api/scenarios/${s.id}`, { name: "Retire at 58" });
    expect(edited.name).toBe("Retire at 58");
    expect(await ok<ScenarioView[]>("GET", "/api/scenarios")).toHaveLength(1);
    expect((await call("POST", "/api/scenarios", { name: "Bad", overrides: [{ type: "retirement_age", personId: 999, age: 60 }] })).status).toBe(400);
    expect((await call("POST", "/api/scenarios", { name: "Bad", overrides: [{ type: "lump_sum", label: "x", year: 2030, amount: 0 }] })).status).toBe(400);
    await ok("DELETE", `/api/scenarios/${s.id}`);
    expect(await ok<ScenarioView[]>("GET", "/api/scenarios")).toHaveLength(0);
  });

  it("compares scenarios with your plan", async () => {
    const early = await ok<ScenarioView>("POST", "/api/scenarios", {
      name: "Retire at 58",
      overrides: [
        { type: "retirement_age", personId: alexId, age: 58 },
        { type: "retirement_age", personId: samId, age: 58 },
      ],
    });
    const saver = await ok<ScenarioView>("POST", "/api/scenarios", {
      name: "Save more, buy a house",
      overrides: [
        { type: "extra_savings", monthly: 100_000 },
        { type: "home_purchase", year: 2030, downPayment: 6_000_000, monthlyCostChange: 50_000 },
      ],
    });
    const c = await ok<ScenarioComparison>("GET", `/api/scenarios/compare?ids=${early.id},${saver.id}`);
    expect(c.ready).toBe(true);
    expect(c.rows.map((r) => r.name)).toEqual(["Your plan today", "Retire at 58", "Save more, buy a house"]);
    const [base, earlyRow, saverRow] = c.rows as [ScenarioComparison["rows"][number], ScenarioComparison["rows"][number], ScenarioComparison["rows"][number]];
    expect(earlyRow.retireYear).toBe(2040);
    expect(base.retireYear).toBe(2047);
    expect(earlyRow.successRate).toBeLessThanOrEqual(base.successRate);
    expect(earlyRow.medianAtRetirement).toBeLessThan(base.medianAtRetirement);
    expect(saverRow.extraSavingsMonthly).toBe(base.extraSavingsMonthly + 100_000);
    expect(saverRow.ongoingSpending).toBe(base.ongoingSpending + 600_000);
    expect(base.median.length).toBeGreaterThan(10);
    expect((await call("GET", "/api/scenarios/compare?ids=1,2,3,4")).status).toBe(400);
  });

  it("promotes a scenario into the real plan", async () => {
    const s = await ok<ScenarioView>("POST", "/api/scenarios", {
      name: "New plan",
      overrides: [
        { type: "retirement_age", personId: alexId, age: 62 },
        { type: "income", personId: samId, income: 0, pretaxPct: null },
        { type: "allocation", stocks: 0.7, bonds: 0.3, cash: 0 },
        { type: "lump_sum", label: "Inheritance", year: 2032, amount: 5_000_000 },
      ],
    });
    const before = await ok<RetirementResponse>("GET", "/api/retirement");
    const { applied } = await ok<{ applied: string[] }>("POST", `/api/scenarios/${s.id}/promote`);
    expect(applied).toEqual(["Alex retires at 62", "Sam stops working", "Mix: 70% stocks / 30% bonds / 0% cash", "Inheritance: +$50,000 in 2032"]);

    const hh = await ok<HouseholdResponse>("GET", "/api/household");
    expect(hh.people.find((p) => p.id === alexId)!.retirementAge).toBe(62);
    expect(hh.people.find((p) => p.id === samId)!.income).toBe(0);
    // Stocks keep the 60/30 US/international split: 70% × 2/3 and × 1/3.
    const inv = await ok<InvestmentsResponse>("GET", "/api/investments");
    expect(inv.target).toEqual({ us_stock: 0.467, intl_stock: 0.233, bonds: 0.3 });

    const after = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(after.events).toEqual(["Inheritance: +$50,000 in 2032"]);
    expect(after.inputs!.retireYear).toBe(2042);
    expect(after.result!.successRate).not.toBe(before.result!.successRate);

    await ok("DELETE", "/api/retirement/events/0");
    expect((await ok<RetirementResponse>("GET", "/api/retirement")).events).toEqual([]);
  });
});

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextMonth } from "../engine/budget/budget.ts";
import type { AccountView, BudgetResponse, CategoryView, DebtsResponse, GoalView, PlanResponse, Recommendation } from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, type Db } from "./db.ts";

let db: Db;
let app: FastifyInstance;
let today: string;
let cats: Map<string, CategoryView>;
const accounts: Record<string, AccountView> = {};

async function call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown) {
  const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}
async function ok<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await call<T>(method, url, body);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}
const steps = (plan: PlanResponse, step: string): Recommendation[] => plan.result.recommendations.filter((r) => r.step === step);

beforeEach(async () => {
  db = openDb(":memory:");
  app = await buildApp({ db });
  today = (await ok<BudgetResponse>("GET", "/api/budget")).today;
  await ok("PUT", "/api/household", {
    household: { filingStatus: "married_joint" },
    people: [
      {
        name: "Alex",
        birthDate: "1986-04-12",
        income: 12_000_000,
        employerPlan: { type: "401k", matchTiers: [{ matchPct: 100, upToPct: 3 }, { matchPct: 50, upToPct: 2 }], pretaxPct: 3 },
      },
      { name: "Sam", birthDate: "1988-09-30", income: 0 },
    ],
  });
  cats = new Map((await ok<CategoryView[]>("GET", "/api/categories")).map((c) => [c.name, c]));
  const create = async (key: string, body: object) => {
    accounts[key] = await ok<AccountView>("POST", "/api/accounts", body);
  };
  await create("checking", { name: "Checking", type: "checking" });
  await create("savings", { name: "Savings", type: "savings", interestRatePct: 0.5 });
  await create("store", { name: "Store card", type: "credit_card", interestRatePct: 26, minimumPayment: 4_000, paysInFull: false });
  await create("visa", { name: "Visa", type: "credit_card", interestRatePct: 24.99 });
  const lastMonthEnd = `${nextMonth(today.slice(0, 7), -1)}-28`;
  await ok("POST", `/api/accounts/${accounts.savings!.id}/balances`, { date: lastMonthEnd, balance: 500_000 });
  await ok("POST", `/api/accounts/${accounts.store!.id}/balances`, { date: lastMonthEnd, balance: -150_000 });
  await ok("POST", `/api/accounts/${accounts.visa!.id}/balances`, { date: lastMonthEnd, balance: -80_000 });

  // Three complete months of groceries ($600/mo, an essential flex category).
  for (let back = 3; back >= 1; back--) {
    const m = nextMonth(today.slice(0, 7), -back);
    await ok("POST", "/api/transactions", {
      accountId: accounts.checking!.id,
      date: `${m}-10`,
      amount: -60_000,
      payee: "Grocer",
      categoryId: cats.get("Groceries")!.id,
    });
  }
  await ok("PUT", "/api/budget/categories", {
    items: [
      { categoryId: cats.get("Mortgage / rent")!.id, amount: 200_000 },
      { categoryId: cats.get("Utilities")!.id, amount: 20_000 },
    ],
  });
  await ok("PUT", "/api/budget/settings", { expectedIncome: 700_000 });
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe("plan", () => {
  it("pours this month's money through the waterfall from real data", async () => {
    const plan = await ok<PlanResponse>("GET", "/api/plan");
    // $7,000 − $2,200 fixed − $600 average flex.
    expect(plan.basis).toMatchObject({ computed: 420_000, fixed: 220_000, flex: 60_000, essentialMonthly: 280_000 });
    // One earner → 6 months × $2,800.
    expect(plan.basis).toMatchObject({ emergencyMonths: 6, emergencyTarget: 1_680_000, emergencySaved: 500_000, emergencyBasis: "savings_accounts" });
    expect(plan.limits).toMatchObject({ exact: true });

    expect(steps(plan, "starter_emergency")[0]!.status).toBe("done");
    expect(steps(plan, "employer_match")[0]).toMatchObject({ status: "act", amount: 20_000 });
    // Store card: whole $1,500 balance. The Visa is paid in full, so it's not debt here.
    const debt = steps(plan, "high_interest_debt");
    expect(debt.map((d) => [d.subject?.name, d.amount])).toEqual([["Store card", 150_000]]);
    expect(steps(plan, "full_emergency")[0]).toMatchObject({ status: "partial", amount: 250_000 });
    expect(plan.result).toMatchObject({ available: 420_000, allocated: 420_000, leftover: 0 });
    // Savings at 0.5% gets flagged.
    expect(plan.alerts.map((a) => a.kind)).toContain("cash_yield");
  });

  it("has no amount until expected income is set, unless overridden", async () => {
    await ok("PUT", "/api/budget/settings", { expectedIncome: null });
    let plan = await ok<PlanResponse>("GET", "/api/plan");
    expect(plan.result.available).toBeNull();
    plan = await ok<PlanResponse>("PUT", "/api/plan/settings", { availableOverride: 100_000 });
    expect(plan.result.available).toBe(100_000);
    expect(plan.result.allocated).toBe(100_000);
  });

  it("saves step order, toggles and thresholds", async () => {
    const plan = await ok<PlanResponse>("GET", "/api/plan");
    const reordered = [...plan.settings.steps].map((s) => (s.id === "employer_match" ? { ...s, enabled: false } : s));
    const next = await ok<PlanResponse>("PUT", "/api/plan/settings", { steps: reordered, highInterestApr: 30, emergencyMonths: 3 });
    expect(steps(next, "employer_match")[0]!.status).toBe("disabled");
    expect(steps(next, "high_interest_debt")[0]!.status).toBe("done"); // 26% is under the new 30% line
    expect(next.basis.emergencyTarget).toBe(840_000);
    expect((await call("PUT", "/api/plan/settings", { steps: reordered.slice(1) })).status).toBe(400);
  });
});

describe("goals", () => {
  it("creates goals, earmarks money and shows the planned amount", async () => {
    let goals = await ok<GoalView[]>("GET", "/api/goals");
    const emergency = goals.find((g) => g.kind === "emergency")!;
    expect(emergency).toMatchObject({ targetIsAuto: true, targetAmount: 1_680_000, plannedMonthly: 250_000 });

    const target = `${nextMonth(today.slice(0, 7), 24)}-01`;
    goals = await ok<GoalView[]>("POST", "/api/goals", { name: "House", targetAmount: 2_400_000, targetDate: target });
    const house = goals.find((g) => g.name === "House")!;
    expect(house.progress).toMatchObject({ status: "in_progress", remaining: 2_400_000 });
    expect(house.plannedMonthly).toBe(0); // nothing left after the steps above

    // Earmarking $3,000 of savings for the house leaves $2,000 for the emergency fund.
    goals = await ok<GoalView[]>("PUT", `/api/goals/${house.id}/allocations`, { items: [{ accountId: accounts.savings!.id, amount: 300_000 }] });
    expect(goals.find((g) => g.id === house.id)!.progress.saved).toBe(300_000);
    const plan = await ok<PlanResponse>("GET", "/api/plan");
    expect(plan.basis.emergencySaved).toBe(200_000);
    expect(steps(plan, "starter_emergency")[0]!.status).toBe("done");

    // Over-earmarking is a warning, not an error.
    await ok("PUT", `/api/goals/${house.id}/allocations`, { items: [{ accountId: accounts.savings!.id, amount: 900_000 }] });
    expect((await ok<PlanResponse>("GET", "/api/plan")).warnings.join(" ")).toMatch(/More is set aside/);

    // Emergency target can be set by hand and reset.
    goals = await ok<GoalView[]>("PATCH", `/api/goals/${emergency.id}`, { targetAmount: 1_000_000 });
    expect(goals.find((g) => g.kind === "emergency")).toMatchObject({ targetAmount: 1_000_000, targetIsAuto: false });
    goals = await ok<GoalView[]>("PATCH", `/api/goals/${emergency.id}`, { targetAmount: null });
    expect(goals.find((g) => g.kind === "emergency")!.targetIsAuto).toBe(true);
    expect((await call("DELETE", `/api/goals/${emergency.id}`)).status).toBe(400);
    expect((await call("PATCH", `/api/goals/${house.id}`, { targetAmount: null })).status).toBe(400);

    goals = await ok<GoalView[]>("DELETE", `/api/goals/${house.id}`);
    expect(goals).toHaveLength(1);
  });

  it("orders custom goals", async () => {
    await ok("POST", "/api/goals", { name: "Car", targetAmount: 100_000 });
    const goals = await ok<GoalView[]>("POST", "/api/goals", { name: "Trip", targetAmount: 50_000 });
    const ids = goals.filter((g) => g.kind === "custom").map((g) => g.id);
    const reordered = await ok<GoalView[]>("POST", "/api/goals/reorder", { ids: [...ids].reverse() });
    expect(reordered.filter((g) => g.kind === "custom").map((g) => g.name)).toEqual(["Trip", "Car"]);
  });
});

describe("debts", () => {
  it("plans payoff with the plan's extra by default, and with a chosen extra", async () => {
    const d = await ok<DebtsResponse>("GET", "/api/debts");
    expect(d.debts.map((x) => [x.name, x.paysInFull, x.minimumEstimated])).toEqual([
      ["Store card", false, false],
      ["Visa", true, true],
    ]);
    expect(d.suggestedExtra).toBe(150_000);
    expect(d.comparison!.avalanche.months).toBe(1);
    const slow = await ok<DebtsResponse>("GET", "/api/debts?extra=0");
    expect(slow.extra).toBe(0);
    expect(slow.comparison!.avalanche.months).toBeGreaterThan(40);
    expect(slow.comparison!.avalanche.totalInterest).toBeGreaterThan(0);
  });
});

describe("partial updates keep other fields", () => {
  it("renaming an account keeps its owner, rate and debt details", async () => {
    const people = (await ok<{ people: { id: number }[] }>("GET", "/api/household")).people;
    await ok("PATCH", `/api/accounts/${accounts.store!.id}`, { ownerPersonId: people[0]!.id });
    const renamed = await ok<AccountView>("PATCH", `/api/accounts/${accounts.store!.id}`, { name: "Store card (old)" });
    expect(renamed).toMatchObject({
      name: "Store card (old)",
      ownerPersonId: people[0]!.id,
      interestRatePct: 26,
      minimumPayment: 4_000,
      paysInFull: false,
    });
  });

  it("renaming a category keeps its group and essential flag", async () => {
    const groceries = cats.get("Groceries")!;
    const renamed = await ok<CategoryView>("PATCH", `/api/categories/${groceries.id}`, { name: "Food at home" });
    expect(renamed).toMatchObject({ name: "Food at home", group: "Food", isEssential: true, budgetType: "flex" });
  });
});

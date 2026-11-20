import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextMonth } from "../engine/budget/budget.ts";
import { leanFor } from "../engine/plan/rothChoice.ts";
import type { AccountView, AssumptionsResponse, BudgetResponse, CategoryView, ClaimingResponse, ConversionsResponse, ExploreResponse, PlanResponse, RetirementResponse, WithdrawalOrderResponse } from "../shared/api.ts";
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
    // Spending: rent $2,500 + groceries $800 a month = $39,600 a year today; by 2051 the 15% that is healthcare has grown 1% a year above inflation.
    expect(i.spending.firstYear).toBe(Math.round(3_960_000 * (0.15 * 1.01 ** (2051 - i.startYear) + 0.85)));
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

  it("shows the result several ways: interval, stress, real-history replay", async () => {
    await household();
    const r = await ok<RetirementResponse>("GET", "/api/retirement");
    const [lo, hi] = r.result!.successInterval;
    expect(lo).toBeLessThanOrEqual(r.result!.successRate);
    expect(hi).toBeGreaterThanOrEqual(r.result!.successRate);
    expect(r.checks!.stress.haircutPct).toBe(1);
    // One point a year less return never helps.
    expect(r.checks!.stress.successRate).toBeLessThanOrEqual(r.result!.successRate + 0.03);
    expect(r.checks!.replay.startYears).toBeGreaterThan(0);
    // A standing haircut setting lowers the headline too.
    const worse = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { returnHaircutPct: 2 });
    expect(worse.settings.returnHaircutPct).toBe(2);
    expect(worse.result!.successRate).toBeLessThanOrEqual(r.result!.successRate);
  });

  it("answers the three dials with the same random years as the headline", async () => {
    expect((await ok<ExploreResponse>("POST", "/api/retirement/explore", {})).ready).toBe(false);
    await household();
    const none = await ok<ExploreResponse>("POST", "/api/retirement/explore", {});
    if (!none.ready) throw new Error("not ready");
    // No change: the same chance as the baseline from the same runs.
    expect(none.changed.successRate).toBe(none.base.successRate);
    const better = await ok<ExploreResponse>("POST", "/api/retirement/explore", { retireShiftYears: 3, spendingPct: 85, extraMonthly: 100_000 });
    if (!better.ready) throw new Error("not ready");
    expect(better.changed.successRate).toBeGreaterThanOrEqual(better.base.successRate);
    expect(better.changed.retireYear).toBe(none.changed.retireYear + 3);
    expect(better.changed.bands.length).toBe(none.changed.bands.length);
    const worse = await ok<ExploreResponse>("POST", "/api/retirement/explore", { spendingPct: 130 });
    if (!worse.ready) throw new Error("not ready");
    expect(worse.changed.successRate).toBeLessThanOrEqual(worse.base.successRate);
    expect((await call("POST", "/api/retirement/explore", { spendingPct: 500 })).status).toBe(400);
  });

  it("lists every assumption with its source and how much each lever matters", async () => {
    await household();
    const a = await ok<AssumptionsResponse>("GET", "/api/assumptions");
    const row = (label: string) => a.rows.find((r) => r.label === label)!;
    expect(row("Expected monthly income").source).toBe("missing");
    expect(row("Starter emergency fund").source).toBe("default");
    expect(row("Alex: retirement age").source).toBe("you");
    expect(row("Taxes in retirement").note).toMatch(/2026/);
    expect(row("Taxes in retirement").value).toContain("married joint");
    expect(a.sensitivity.length).toBe(8);
    const byLabel = new Map(a.sensitivity.map((s) => [s.label, s.successPoints]));
    expect(byLabel.has("Living 5 years longer")).toBe(true);
    expect(byLabel.get("Retire 2 years later")!).toBeGreaterThanOrEqual(0);
    expect(byLabel.get("Spend 10% more in retirement")!).toBeLessThanOrEqual(0);
    expect(byLabel.get("Returns 1 point a year lower")!).toBeLessThanOrEqual(0);
    // Sorted by size of effect.
    const sizes = a.sensitivity.map((s) => Math.abs(s.successPoints));
    expect(sizes).toEqual([...sizes].sort((x, y) => y - x));
    // Entering a setting changes its source.
    await ok("PUT", "/api/plan/settings", { starterAmount: 300_000 });
    expect((await ok<AssumptionsResponse>("GET", "/api/assumptions")).rows.find((r) => r.label === "Starter emergency fund")!.source).toBe("you");
  });

  it("taxes retirement withdrawals from the brackets by default, or at flat rates on request", async () => {
    await household();
    const brackets = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(brackets.settings).toMatchObject({ taxMode: "brackets", stateTaxPct: 0 });
    expect(brackets.sources.tax).toMatch(/Rev\. Proc\./);
    // A state tax can only lower the answer.
    const withState = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { stateTaxPct: 6 });
    expect(withState.result!.successRate).toBeLessThanOrEqual(brackets.result!.successRate);
    expect(withState.result!.medianAtEnd).toBeLessThanOrEqual(brackets.result!.medianAtEnd);
    const flat = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { taxMode: "flat" });
    expect(flat.settings.taxMode).toBe("flat");
    const a = await ok<AssumptionsResponse>("GET", "/api/assumptions");
    expect(a.rows.some((r) => r.label === "Tax on pre-tax withdrawals")).toBe(true);
    expect(a.sensitivity.some((x) => x.label.startsWith("Tax on pre-tax withdrawals"))).toBe(true);
    expect((await call("PUT", "/api/retirement/settings", { taxMode: "guess" })).status).toBe(400);
  });

  it("can model the mix you hold today instead of the target", async () => {
    await household();
    const target = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(target.settings.allocationSource).toBe("target");
    // With no holdings recorded, "what I hold" falls back to the target.
    const same = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { allocationSource: "actual" });
    expect(same.inputs!.allocation).toEqual(target.inputs!.allocation);
    const brokerage = (await ok<AccountView[]>("GET", "/api/accounts")).find((a) => a.name === "Brokerage")!;
    const positions = `Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total
VTI,VANGUARD TOTAL STOCK MKT ETF,100,$370.00,"$37,000.00","$30,000.00"
BND,VANGUARD TOTAL BOND MARKET ETF,800,$78.75,"$63,000.00","$60,000.00"
`;
    await ok("POST", "/api/holdings/import", { accountId: brokerage.id, fileName: "positions.csv", content: positions });
    const held = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(held.inputs!.allocation.stocks).toBeCloseTo(0.37, 2);
    expect(held.inputs!.allocation.bonds).toBeCloseTo(0.63, 2);
    // A bond-heavy mix is a different risk; back to the target it returns to the 90/10 plan.
    const back = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { allocationSource: "target" });
    expect(back.inputs!.allocation).toEqual(target.inputs!.allocation);
  });

  it("compares Social Security claim ages", async () => {
    expect((await ok<ClaimingResponse>("GET", "/api/retirement/claiming")).ready).toBe(false);
    await household();
    const c = await ok<ClaimingResponse>("GET", "/api/retirement/claiming");
    expect(c.people.map((p) => p.name)).toEqual(["Alex", "Sam"]);
    const alex = c.people[0]!;
    expect(alex.planned).toBe(67);
    expect(alex.options.map((o) => o.age)).toEqual([62, 63, 64, 65, 66, 67, 68, 69, 70]);
    // FRA benefit at 67 is the stated $3,000; waiting pays more per month.
    expect(alex.options.find((o) => o.age === 67)!.monthly).toBe(300_000);
    expect(alex.options[8]!.monthly).toBeGreaterThan(alex.options[0]!.monthly);
    expect(alex.options.every((o) => o.successRate >= 0 && o.successRate <= 1)).toBe(true);
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
    expect(r.inputs!.spending.firstYear).toBe(Math.round((1_200_000 + 960_000 + 600_000) * (0.15 * 1.01 ** (2051 - r.inputs!.startYear) + 0.85)));
    expect(r.result!.successRate).toBeGreaterThanOrEqual(base.result!.successRate);
    expect(r.inputs!.spending.items).toHaveLength(1);
  });

  it("draws lifespans by default and can plan to a fixed age instead", async () => {
    await household();
    const modeled = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(modeled.settings.longevity).toBe("modeled");
    expect(modeled.result!.medianLastDeathYear).toBeGreaterThan(2060);
    expect(modeled.checks!.fixedHorizon!.age).toBe(95);
    // The chart and the planning-age checks stay at the household planning age.
    expect(modeled.inputs!.endYear).toBe(1988 + 95);
    expect(modeled.checks!.fixedHorizon!.successRate).toBeLessThanOrEqual(modeled.result!.successRate + 0.03);

    const fixed = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { longevity: "fixed" });
    expect(fixed.result!.medianLastDeathYear).toBeNull();
    expect(fixed.checks!.fixedHorizon).toBeNull();
    // Living a shorter or longer time moves the answer the right way.
    const long = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { longevity: "modeled", lifeMode: 96 });
    const short = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { lifeMode: 80 });
    expect(short.result!.successRate).toBeGreaterThanOrEqual(long.result!.successRate);
  });

  it("applies spending guardrails and reports how often they cut", async () => {
    await household();
    const base = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(base.result!.guardrails).toBeNull();
    const r = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { guardrails: { enabled: true, upperPct: 20, lowerPct: 20, adjustPct: 10, floorPct: 75 } });
    expect(r.result!.guardrails).not.toBeNull();
    expect(r.checks!.withoutGuardrails!.successRate).toBeCloseTo(base.result!.successRate, 1);
    expect(r.result!.successRate).toBeGreaterThanOrEqual(base.result!.successRate);
    expect((await call("PUT", "/api/retirement/settings", { guardrails: { enabled: true, upperPct: 20, lowerPct: 20, adjustPct: 10, floorPct: 10 } })).status).toBe(400);
  });

  it("compares Roth conversion levels with the same futures", async () => {
    expect((await ok<ConversionsResponse>("GET", "/api/retirement/conversions")).ready).toBe(false);
    await household();
    const c = await ok<ConversionsResponse>("GET", "/api/retirement/conversions");
    expect(c.ready).toBe(true);
    expect(c.window).toEqual({ from: 2051, to: 2060 });
    expect(c.options!.map((o) => o.ratePct)).toEqual([0, 12, 22, 24]);
    expect(c.options![0]!.medianConverted).toBe(0);
    expect(c.options![0]!.paired).toBeNull();
    // Every other row is compared with no conversions on the same futures.
    for (const o of c.options!.slice(1)) {
      expect(o.paired!.better + o.paired!.worse).toBeLessThanOrEqual(1);
      expect(o.paired!.saved).toBeGreaterThanOrEqual(0);
      expect(o.paired!.lost).toBeGreaterThanOrEqual(0);
    }
    expect(c.options![2]!.medianConverted!).toBeGreaterThanOrEqual(c.options![1]!.medianConverted!);
    // Choosing one puts it in the plan and shows up in the headline's conversion total.
    const r = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { rothConversionRatePct: 22 });
    expect(r.result!.medianConverted).toBeGreaterThan(0);
    expect((await ok<ConversionsResponse>("GET", "/api/retirement/conversions")).chosen).toBe(22);
    expect((await call("PUT", "/api/retirement/settings", { rothConversionRatePct: 15 })).status).toBe(400);
    // Flat tax mode cannot model them.
    await ok("PUT", "/api/retirement/settings", { taxMode: "flat" });
    expect((await ok<ConversionsResponse>("GET", "/api/retirement/conversions")).ready).toBe(false);
  });

  it("models early withdrawals, spousal benefits, a Social Security cut, care costs and the size of a shortfall", async () => {
    await household();
    const base = await ok<RetirementResponse>("GET", "/api/retirement");
    expect(base.settings).toMatchObject({ earlyWithdrawalRules: true, ruleOf55: true, rothBasisPct: 100, spousalBenefits: true, healthcareSharePct: 15, healthcareGrowthPct: 1 });
    expect(base.settings.ssShortfall).toEqual({ enabled: false, startYear: 2033, payablePct: 78 });
    expect(base.settings.longTermCare.enabled).toBe(false);
    // Early-withdrawal rules are on in bracket mode; the share of futures paying a penalty is reported.
    expect(base.result!.penalties).not.toBeNull();
    expect(base.result!.shortfall.expected).toBeGreaterThanOrEqual(0);
    // Each optional risk is shown the other way round next to the headline.
    expect(base.checks!.ssShortfall).toMatchObject({ applied: false, startYear: 2033, payablePct: 78 });
    expect(base.checks!.ssShortfall!.otherSuccessRate).toBeLessThanOrEqual(base.result!.successRate + 0.03);
    expect(base.checks!.longTermCare!.applied).toBe(false);
    expect(base.checks!.longTermCare!.otherSuccessRate).toBeLessThanOrEqual(base.result!.successRate + 0.03);

    const risky = await ok<RetirementResponse>("PUT", "/api/retirement/settings", {
      ssShortfall: { enabled: true, startYear: 2033, payablePct: 78 },
      longTermCare: { enabled: true, probabilityPct: 60, meanYears: 3, annualCost: 9_000_000, growthPct: 1 },
    });
    expect(risky.checks!.ssShortfall!.applied).toBe(true);
    expect(risky.checks!.longTermCare!.applied).toBe(true);
    expect(risky.result!.longTermCare!.share).toBeGreaterThan(0.4);
    expect(risky.result!.successRate).toBeLessThanOrEqual(base.result!.successRate);

    // Flat taxes leave out the early-withdrawal rules.
    const flatTax = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { taxMode: "flat" });
    expect(flatTax.result!.penalties).toBeNull();
    expect((await call("PUT", "/api/retirement/settings", { rothBasisPct: 120 })).status).toBe(400);
    expect((await call("PUT", "/api/retirement/settings", { longTermCare: { enabled: true, probabilityPct: 50, meanYears: 3, annualCost: -1, growthPct: 1 } })).status).toBe(400);
  });

  it("raises retirement spending for healthcare growth and shifts the rest by a yearly drift", async () => {
    await household();
    const flatSpending = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { healthcareGrowthPct: 0, otherSpendingDriftPct: 0 });
    expect(flatSpending.inputs!.spending.firstYear).toBe(3_960_000);
    const shaped = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { healthcareSharePct: 60, healthcareGrowthPct: 2 });
    const years = 2051 - shaped.inputs!.startYear;
    expect(shaped.inputs!.spending.firstYear).toBe(Math.round(3_960_000 * (0.6 * 1.02 ** years + 0.4)));
    const drifting = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { healthcareSharePct: 0, healthcareGrowthPct: 0, otherSpendingDriftPct: -1 });
    // Drift starts at retirement, so the first retirement year is unchanged.
    expect(drifting.inputs!.spending.firstYear).toBe(3_960_000);
    expect(drifting.result!.successRate).toBeGreaterThanOrEqual(flatSpending.result!.successRate);
  });

  it("feeds the retirement tax rate into the Roth-or-pre-tax advice in Next best moves", async () => {
    await household();
    const plan = await ok<PlanResponse>("GET", "/api/plan");
    // Alex earns $120,000 and puts 6% pre-tax: $80,600 is taxable after the deduction, in the 12% bracket.
    expect(plan.taxView).toMatchObject({ nowPct: 12, nowBasis: "income" });
    const later = plan.taxView.retirementPct;
    expect(later).not.toBeNull();
    const [low, high] = plan.taxView.retirementRange!;
    expect(low).toBeLessThanOrEqual(later!);
    expect(high).toBeGreaterThanOrEqual(later!);
    expect(plan.taxView.lean).toBe(leanFor(12, later));
    const ira = plan.result.recommendations.find((r) => r.step === "ira")!;
    expect(ira.facts.map((f) => f.label)).toEqual(expect.arrayContaining(["Tax rate on your next dollar now", "Expected rate on an extra pre-tax dollar in retirement"]));
    expect(ira.why).toMatch(/tax rate now/);

    // A rate typed in settings replaces the estimate for today's rate only.
    const typed = await ok<PlanResponse>("PUT", "/api/plan/settings", { marginalTaxPct: 30 });
    expect(typed.taxView).toMatchObject({ nowPct: 30, nowBasis: "you", retirementPct: later });
    expect(typed.taxView.lean).toBe("traditional");
    expect(typed.result.recommendations.find((r) => r.step === "ira")!.why).toMatch(/\(30%\) is higher than expected in retirement/);
  });

  it("compares which money to spend first on the same futures, and takes the choice into the plan", async () => {
    expect((await ok<WithdrawalOrderResponse>("GET", "/api/retirement/withdrawal-order")).ready).toBe(false);
    await household();
    const o = await ok<WithdrawalOrderResponse>("GET", "/api/retirement/withdrawal-order");
    expect(o.ready).toBe(true);
    expect(o.options!.map((x) => x.ratePct)).toEqual([0, 12, 22, 24]);
    expect(o.options![0]!.paired).toBeNull();
    for (const x of o.options!.slice(1)) {
      expect(x.paired!.better + x.paired!.worse).toBeLessThanOrEqual(1);
      expect(x.paired!.saved).toBeGreaterThanOrEqual(0);
    }
    expect(o.chosen).toBe(0);
    const r = await ok<RetirementResponse>("PUT", "/api/retirement/settings", { withdrawalFillRatePct: 12 });
    expect(r.settings.withdrawalFillRatePct).toBe(12);
    expect((await ok<WithdrawalOrderResponse>("GET", "/api/retirement/withdrawal-order")).chosen).toBe(12);
    expect((await call("PUT", "/api/retirement/settings", { withdrawalFillRatePct: 15 })).status).toBe(400);
    await ok("PUT", "/api/retirement/settings", { taxMode: "flat" });
    expect((await ok<WithdrawalOrderResponse>("GET", "/api/retirement/withdrawal-order")).ready).toBe(false);
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

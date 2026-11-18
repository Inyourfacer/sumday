import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compareStrategies, effectiveApr, payoffPlan, type Debt } from "./debt.ts";
import { emergencyMonthsDefault, goalProgress } from "./goals.ts";
import { hsaLimit, iraLimit, limitsFor, workplaceLimit, type ContributionLimits } from "./limits.ts";
import { DEFAULT_STEPS, STEP_IDS, STEP_TEMPLATES, fullMatchPct, matchValue, runWaterfall, type WaterfallInput } from "./waterfall.ts";

const load = (y: number) => JSON.parse(readFileSync(new URL(`../../../data/limits/${y}.json`, import.meta.url), "utf8")) as ContributionLimits;
const L2025 = load(2025);
const L2026 = load(2026);

describe("limits", () => {
  it("picks the year, falling back to the latest earlier year", () => {
    expect(limitsFor(2026, [L2025, L2026])).toMatchObject({ exact: true, limits: { year: 2026 } });
    expect(limitsFor(2027, [L2025, L2026])).toMatchObject({ exact: false, limits: { year: 2026 }, requestedYear: 2027 });
    expect(limitsFor(2020, [L2025, L2026]).limits.year).toBe(2025);
  });

  it("adds catch-ups by age", () => {
    expect(workplaceLimit(L2026, 40)).toBe(2_450_000);
    expect(workplaceLimit(L2026, 55)).toBe(3_250_000);
    expect(workplaceLimit(L2026, 61)).toBe(3_575_000);
    expect(workplaceLimit(L2026, 64)).toBe(3_250_000);
    expect(iraLimit(L2026, 49)).toBe(750_000);
    expect(iraLimit(L2026, 50)).toBe(860_000);
    expect(hsaLimit(L2026, "family", 56)).toBe(975_000);
    expect(hsaLimit(L2026, "self", null)).toBe(440_000);
  });
});

describe("goals", () => {
  it("works out the monthly amount to hit the date", () => {
    // Nov 8 → Jun 30 next year: Nov..Jun = 8 months.
    expect(goalProgress(1_200_000, 400_000, "2027-06-30", "2026-11-08")).toMatchObject({
      remaining: 800_000,
      monthsLeft: 8,
      requiredMonthly: 100_000,
      status: "in_progress",
      percent: 1 / 3,
    });
    expect(goalProgress(100_000, 150_000, "2027-01-01", "2026-11-08")).toMatchObject({ status: "funded", remaining: 0, percent: 1 });
    expect(goalProgress(100_000, 0, null, "2026-11-08")).toMatchObject({ status: "no_date", requiredMonthly: null });
    expect(goalProgress(100_000, 40_000, "2026-10-01", "2026-11-08")).toMatchObject({ status: "overdue", requiredMonthly: 60_000 });
    expect(goalProgress(100_000, 0, "2026-11-30", "2026-11-08").requiredMonthly).toBe(100_000);
  });

  it("sizes the emergency fund by earners", () => {
    expect(emergencyMonthsDefault(2)).toBe(3);
    expect(emergencyMonthsDefault(1)).toBe(6);
  });
});

const card: Debt = { id: 1, name: "Visa", balance: 500_000, apr: 24, minPayment: 15_000 };
const car: Debt = { id: 2, name: "Car loan", balance: 300_000, apr: 6, minPayment: 20_000 };

describe("debt payoff", () => {
  it("simulates minimums with interest", () => {
    const p = payoffPlan([{ id: 1, name: "Loan", balance: 100_000, apr: 12, minPayment: 50_000 }], 0, "avalanche", "2026-11-01");
    // Month 1: 1,000 + 10 interest − 500 = 510. Month 2: 510 + 5.10 − 500 = 15.10. Month 3: paid.
    expect(p.months).toBe(3);
    expect(p.balances).toEqual([51_000, 1_510, 0]);
    expect(p.totalInterest).toBe(1_000 + 510 + 15);
    expect(p.debtFreeDate).toBe("2027-01-01");
    expect(p.debts[0]).toMatchObject({ months: 3, payoffDate: "2027-01-01" });
  });

  it("rolls freed minimums into the next debt, and avalanche beats snowball on interest", () => {
    const c = compareStrategies([card, car], 20_000, "2026-11-01");
    expect(c.avalanche.months).not.toBeNull();
    // Avalanche pays the 24% card first; snowball pays the smaller car loan first.
    expect(c.avalanche.debts.find((d) => d.id === 1)!.months!).toBeLessThanOrEqual(c.snowball.debts.find((d) => d.id === 1)!.months!);
    expect(c.snowball.debts.find((d) => d.id === 2)!.months!).toBeLessThan(c.avalanche.debts.find((d) => d.id === 2)!.months!);
    expect(c.interestSaved).toBeGreaterThan(0);
    // Paid = principal + interest.
    expect(c.avalanche.totalPaid).toBe(800_000 + c.avalanche.totalInterest);
  });

  it("flags a minimum that doesn't cover interest, and uses promo rates until they end", () => {
    const stuck = payoffPlan([{ id: 1, name: "Card", balance: 1_000_000, apr: 30, minPayment: 20_000 }], 0, "avalanche", "2026-11-01");
    expect(stuck.growing).toEqual([1]);
    expect(stuck.months).toBeNull();
    const promo = payoffPlan(
      [{ id: 1, name: "Card", balance: 120_000, apr: 25, minPayment: 10_000, promoApr: 0, promoEnds: "2027-11-01" }],
      0,
      "avalanche",
      "2026-11-01",
    );
    expect(promo.totalInterest).toBe(0);
    expect(promo.months).toBe(12);
  });
});

describe("match math", () => {
  const tiers = [
    { matchPct: 100, upToPct: 3 },
    { matchPct: 50, upToPct: 2 },
  ];
  it("values the match", () => {
    expect(fullMatchPct(tiers)).toBe(5);
    // $100k: 3% fully matched = $3,000, next 2% half = $1,000.
    expect(matchValue(10_000_000, tiers, 5)).toBe(400_000);
    expect(matchValue(10_000_000, tiers, 4)).toBe(350_000);
    expect(matchValue(10_000_000, tiers, 10)).toBe(400_000);
    expect(matchValue(10_000_000, tiers, 0)).toBe(0);
  });
});

function input(over: Partial<WaterfallInput> = {}): WaterfallInput {
  return {
    today: "2026-11-08",
    limits: L2026,
    limitsExact: true,
    steps: DEFAULT_STEPS,
    params: { starterAmount: 200_000, highInterestApr: 7, emergencyMonths: 3 },
    available: 300_000,
    essentialMonthly: 400_000,
    emergencySaved: 500_000,
    filingStatus: "married_joint",
    hsaCoverage: "none",
    hsaProjected: 0,
    people: [
      {
        id: 1,
        name: "Alex",
        ageAtYearEnd: 40,
        income: 12_000_000,
        plan: { type: "401k", matchTiers: [{ matchPct: 100, upToPct: 3 }, { matchPct: 50, upToPct: 2 }], pretaxPct: 3, rothPct: 0 },
        iraYtd: 0,
      },
      { id: 2, name: "Sam", ageAtYearEnd: 38, income: 0, plan: { type: "none", matchTiers: [], pretaxPct: 0, rothPct: 0 }, iraYtd: 0 },
    ],
    debts: [
      { id: 10, name: "Visa", balance: 80_000, apr: 24.99, minPayment: 3_500, paysInFull: true },
      { id: 11, name: "Store card", balance: 150_000, apr: 26, minPayment: 4_000, paysInFull: false },
      { id: 12, name: "Car loan", balance: 900_000, apr: 4.5, minPayment: 30_000, paysInFull: false },
    ],
    goals: [{ id: 5, name: "House", remaining: 2_000_000, requiredMonthly: 100_000, targetDate: "2028-06-30" }],
    hasTaxableAccount: false,
    ...over,
  };
}

const byStep = (r: ReturnType<typeof runWaterfall>, step: string) => r.recommendations.filter((x) => x.step === step);

describe("waterfall", () => {
  it("pours the money through the steps in order", () => {
    const r = runWaterfall(input());
    // $5,000 saved ≥ $2,000 starter: done.
    expect(byStep(r, "starter_emergency")[0]).toMatchObject({ status: "done", amount: 0 });
    // Alex at 3%, full match at 5%: 2% of $120k / 12 = $200/mo.
    const match = byStep(r, "employer_match")[0]!;
    expect(match).toMatchObject({ status: "act", amount: 20_000, subject: { name: "Alex" } });
    expect(match.action).toBe("Raise Alex's 401k contribution from 3% to 5% of pay.");
    expect(match.facts.find((f) => f.label === "Extra employer money per year")?.value).toBe(120_000);
    // The store card at 26% gets the next $1,500 (its whole balance); the Visa paid in full is ignored.
    const debt = byStep(r, "high_interest_debt");
    expect(debt).toHaveLength(1);
    expect(debt[0]).toMatchObject({ status: "act", amount: 150_000, subject: { name: "Store card" } });
    // Then $1,300 left toward the $12,000 emergency fund (3 × $4,000), $7,000 short.
    expect(byStep(r, "full_emergency")[0]).toMatchObject({ status: "partial", amount: 130_000 });
    expect(byStep(r, "hsa")[0]!.status).toBe("not_applicable");
    expect(byStep(r, "ira").every((x) => x.status === "waiting")).toBe(true);
    expect(byStep(r, "taxable")[0]).toMatchObject({ status: "waiting", amount: 0 });
    expect(byStep(r, "low_interest_debt")[0]!.status).toBe("disabled");
    expect(r).toMatchObject({ available: 300_000, allocated: 300_000, leftover: 0, monthsLeftInYear: 2 });
  });

  it("reaches IRAs, the workplace max, goals and taxable when there's enough", () => {
    const r = runWaterfall(input({ available: 2_000_000, emergencySaved: 1_500_000, debts: [], hsaCoverage: "family", hsaProjected: 300_000 }));
    expect(byStep(r, "high_interest_debt")[0]!.status).toBe("done");
    expect(byStep(r, "full_emergency")[0]!.status).toBe("done");
    // HSA family $8,750 − $3,000 = $5,750, spread over the 2 months left plus 3 months of filing-deadline grace.
    expect(byStep(r, "hsa")[0]).toMatchObject({ status: "act", amount: 115_000 });
    // $7,500 each over 5 months; household income $120k → Roth.
    const ira = byStep(r, "ira");
    expect(ira.map((x) => x.amount)).toEqual([150_000, 150_000]);
    expect(ira[0]!.action).toContain("Roth IRA");
    // After the match step Alex is at 5% ($6,000/yr); room $18,500 → $1,542/mo, about 20.5% of pay.
    const max = byStep(r, "max_workplace")[0]!;
    expect(max.amount).toBe(154_167);
    expect(max.action).toContain("20%");
    expect(byStep(r, "goals")[0]).toMatchObject({ status: "act", amount: 100_000 });
    const taxable = byStep(r, "taxable")[0]!;
    expect(taxable.amount).toBe(2_000_000 - 20_000 - 115_000 - 300_000 - 154_167 - 100_000);
    expect(taxable.action).toContain("add one under Accounts");
    expect(r.leftover).toBe(0);
  });

  it("spreads IRA room so December doesn't demand the whole remainder", () => {
    const late = runWaterfall(input({ today: "2026-12-10", available: 2_000_000, emergencySaved: 1_500_000, debts: [], hsaCoverage: "none" }));
    // 1 month left + 3 grace = 4 months: $1,875 each, not $7,500.
    expect(byStep(late, "ira").map((x) => x.amount)).toEqual([187_500, 187_500]);
  });

  it("charges pre-tax payroll contributions at their take-home cost", () => {
    const base = input({ params: { ...input().params, marginalTaxPct: 20 } });
    const match = byStep(runWaterfall(base), "employer_match")[0]!;
    // 2% of $120k / 12 = $200 into the plan, which costs $160 of take-home at 20%.
    expect(match.amount).toBe(16_000);
    expect(match.contribution).toBe(20_000);
    expect(match.action).toBe("Raise Alex's 401k contribution from 3% to 5% of pay.");
    // A partly funded step still lands on a whole percentage.
    const tight = runWaterfall(input({ available: 8_000, params: { ...input().params, marginalTaxPct: 20 } }));
    expect(byStep(tight, "employer_match")[0]).toMatchObject({ status: "partial", amount: 8_000, contribution: 10_000 });
  });

  it("funds goals due within 5 years first when that step is on, and leaves the default alone", () => {
    const base = { available: 2_000_000, emergencySaved: 1_500_000, debts: [] as WaterfallInput["debts"], hsaCoverage: "family" as const };
    const goals = [
      { id: 5, name: "House", remaining: 2_000_000, requiredMonthly: 100_000, targetDate: "2028-06-30" },
      { id: 6, name: "Kid's college", remaining: 9_000_000, requiredMonthly: 40_000, targetDate: "2038-09-01" },
    ];
    // Default: near_goals is off and the goals step takes every goal in order.
    const std = runWaterfall(input({ ...base, goals }));
    expect(byStep(std, "near_goals")[0]!.status).toBe("disabled");
    expect(byStep(std, "goals").map((x) => x.subject?.name)).toEqual(["House", "Kid's college"]);
    // Liquidity first: the house moves ahead of HSA and IRA; college stays in the goals step.
    const liquid = runWaterfall(input({ ...base, goals, steps: STEP_TEMPLATES.liquidity_first.steps }));
    expect(byStep(liquid, "near_goals").map((x) => x.subject?.name)).toEqual(["House"]);
    expect(byStep(liquid, "goals").map((x) => x.subject?.name)).toEqual(["Kid's college"]);
    const order = (step: string) => liquid.recommendations.find((x) => x.step === step)!.order;
    expect(order("near_goals")).toBeLessThan(order("hsa"));
    // With little money, the near-term goal gets it and retirement accounts wait.
    const tight = runWaterfall(input({ ...base, goals, available: 150_000, steps: STEP_TEMPLATES.liquidity_first.steps }));
    expect(byStep(tight, "near_goals")[0]).toMatchObject({ status: "act", amount: 100_000 });
    expect(byStep(tight, "ira").every((x) => x.amount === 0 || x.status === "partial")).toBe(true);
  });

  it("ships templates that list every step once", () => {
    for (const t of Object.values(STEP_TEMPLATES)) {
      expect(t.steps.map((s) => s.id).sort()).toEqual([...STEP_IDS].sort());
    }
  });

  it("keys each move and gives it a deadline", () => {
    const r = runWaterfall(input({ available: 2_000_000, emergencySaved: 1_500_000, debts: [], hsaCoverage: "family" }));
    const keys = r.recommendations.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(byStep(r, "ira")[0]!.key).toBe("ira:person:1");
    expect(byStep(r, "ira")[0]!.deadline).toEqual({ date: "2027-04-15", label: "Counts for this year until Apr 15" });
    expect(byStep(r, "max_workplace")[0]!.deadline?.date).toBe("2026-12-31");
    expect(byStep(r, "goals")[0]!.deadline).toEqual({ date: "2028-06-30", label: "Goal date" });
    expect(byStep(r, "taxable")[0]!.deadline).toBeUndefined();
  });

  it("ranks debts by what they cost over the next year, counting an intro rate that is about to end", () => {
    // 0% for two more months, then 25%: nearly its full rate over the next year.
    const ending = { apr: 25, promoApr: 0, promoEnds: "2027-01-08" };
    expect(effectiveApr(ending, "2026-11-08")).toBeCloseTo(25 * (1 - 61 / 365), 5);
    // 0% for a year or more: close to free.
    expect(effectiveApr({ apr: 25, promoApr: 0, promoEnds: "2028-01-01" }, "2026-11-08")).toBe(0);
    expect(effectiveApr({ apr: 25 }, "2026-11-08")).toBe(25);
    expect(effectiveApr({ apr: 25, promoApr: 0, promoEnds: "2026-10-01" }, "2026-11-08")).toBe(25);

    const debts = [
      { id: 20, name: "Steady card", balance: 100_000, apr: 22, minPayment: 3_000, paysInFull: false },
      { id: 21, name: "Intro card", balance: 100_000, apr: 25, minPayment: 3_000, paysInFull: false, promoApr: 0, promoEnds: "2028-01-01" },
    ];
    const r = runWaterfall(input({ available: 5_000, debts }));
    const order = byStep(r, "high_interest_debt").map((x) => x.subject?.name);
    // The steady 22% card comes first even though the intro card's standard rate is higher; the intro card is not high-interest yet.
    expect(order).toEqual(["Steady card"]);
    expect(byStep(runWaterfall(input({ available: 5_000, debts: [debts[1]!], })), "high_interest_debt")[0]!.status).toBe("done");
  });

  it("says when a minimum payment is only a guess", () => {
    const r = runWaterfall(input({ available: 300_000, debts: [{ id: 30, name: "Card", balance: 50_000, apr: 20, minPayment: 2_500, paysInFull: false, minimumEstimated: true }] }));
    const fact = byStep(r, "high_interest_debt")[0]!.facts.find((f) => f.label === "Minimum payment")!;
    expect(fact.kind).toBe("text");
    expect(String(fact.value)).toContain("a guess");
  });

  it("respects order and disabled steps", () => {
    const steps = [...DEFAULT_STEPS].map((s) => (s.id === "employer_match" ? { ...s, enabled: false } : s));
    const r = runWaterfall(input({ steps }));
    expect(byStep(r, "employer_match")[0]!.status).toBe("disabled");
    expect(byStep(r, "high_interest_debt")[0]!.amount).toBe(150_000);
    expect(byStep(r, "full_emergency")[0]!.amount).toBe(150_000);
  });

  it("flags backdoor Roth at high income and handles unknown available money", () => {
    const rich = input({
      available: 1_000_000,
      emergencySaved: 5_000_000,
      debts: [],
      people: [{ ...input().people[0]!, income: 30_000_000, plan: { ...input().people[0]!.plan, pretaxPct: 10 } }],
    });
    const ira = byStep(runWaterfall(rich), "ira")[0]!;
    expect(ira.action).toContain("backdoor Roth IRA");
    const unknown = runWaterfall(input({ available: null }));
    expect(unknown.available).toBeNull();
    expect(unknown.allocated).toBe(0);
  });
});

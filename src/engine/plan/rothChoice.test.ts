import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ContributionLimits } from "./limits.ts";
import { iraDeductibility, leanFor, type TaxView } from "./rothChoice.ts";
import { DEFAULT_STEPS, runWaterfall, type WaterfallInput } from "./waterfall.ts";

const load = (y: number) => JSON.parse(readFileSync(new URL(`../../../data/limits/${y}.json`, import.meta.url), "utf8")) as ContributionLimits;
const L2026 = load(2026);
const dollars = (d: number) => d * 100;

describe("Roth or traditional", () => {
  it("leans toward the side with the clearly lower tax rate", () => {
    expect(leanFor(22, 12)).toBe("traditional");
    expect(leanFor(12, 22)).toBe("roth");
    expect(leanFor(22, 24)).toBe("either");
    expect(leanFor(22, 19)).toBe("traditional");
    expect(leanFor(22, 20)).toBe("either");
    expect(leanFor(null, 12)).toBeNull();
    expect(leanFor(22, null)).toBeNull();
  });

  it("works out whether a traditional IRA is deductible from the IRS ranges", () => {
    const d = (filing: Parameters<typeof iraDeductibility>[1], magi: number, covered: boolean, spouse = false) => iraDeductibility(L2026, filing, dollars(magi), covered, spouse);
    // Not covered by a plan: always deductible.
    expect(d("single", 500_000, false)).toBe("full");
    // Covered, single: $81,000 to $91,000.
    expect(d("single", 81_000, true)).toBe("full");
    expect(d("single", 86_000, true)).toBe("partial");
    expect(d("single", 91_000, true)).toBe("none");
    // Covered, joint: $129,000 to $149,000. Not covered but spouse is: $242,000 to $252,000.
    expect(d("married_joint", 120_000, true, true)).toBe("full");
    expect(d("married_joint", 140_000, true, true)).toBe("partial");
    expect(d("married_joint", 150_000, false, true)).toBe("full");
    expect(d("married_joint", 247_000, false, true)).toBe("partial");
    expect(d("married_joint", 252_000, false, true)).toBe("none");
    // Separate filers lose it from the first dollar if either of them is covered.
    expect(d("married_separate", 5_000, false, true)).toBe("partial");
    expect(d("married_separate", 10_000, true)).toBe("none");
    // Without the ranges, nothing is assumed deductible.
    const bare = { ...L2026 } as Partial<ContributionLimits>;
    delete bare.traditionalIraDeduction;
    expect(iraDeductibility(bare as ContributionLimits, "single", dollars(50_000), true, false)).toBe("none");
  });
});

function input(over: Partial<WaterfallInput> = {}): WaterfallInput {
  return {
    today: "2026-11-08",
    limits: L2026,
    limitsExact: true,
    steps: DEFAULT_STEPS,
    params: { starterAmount: 200_000, highInterestApr: 7, emergencyMonths: 3 },
    available: 2_000_000,
    essentialMonthly: 400_000,
    emergencySaved: 1_500_000,
    filingStatus: "married_joint",
    hsaCoverage: "none",
    hsaProjected: 0,
    people: [
      { id: 1, name: "Alex", ageAtYearEnd: 40, income: 12_000_000, plan: { type: "401k", matchTiers: [{ matchPct: 100, upToPct: 3 }], pretaxPct: 3, rothPct: 0 }, iraYtd: 0 },
      { id: 2, name: "Sam", ageAtYearEnd: 38, income: 0, plan: { type: "none", matchTiers: [], pretaxPct: 0, rothPct: 0 }, iraYtd: 0 },
    ],
    debts: [],
    goals: [],
    hasTaxableAccount: false,
    ...over,
  };
}
const view = (nowPct: number, retirementPct: number): TaxView => ({
  nowPct,
  nowBasis: "income",
  retirementPct,
  retirementRange: [retirementPct - 2, retirementPct + 3],
  lean: leanFor(nowPct, retirementPct),
});
const step = (i: WaterfallInput, id: string) => runWaterfall(i).recommendations.filter((r) => r.step === id);
const fact = (r: { facts: { label: string; value: number | string }[] }, label: string) => r.facts.find((f) => f.label === label)?.value;

describe("the IRA step with a tax view", () => {
  it("keeps suggesting Roth when there is no view", () => {
    const ira = step(input(), "ira");
    expect(ira[0]!.action).toContain("Roth IRA");
    expect(ira[0]!.why).toContain("Roth suits most people");
  });

  it("suggests a deductible traditional IRA when the rate now is clearly higher and the deduction is available", () => {
    const ira = step(input({ taxView: view(22, 12) }), "ira");
    for (const r of ira) {
      expect(r.action).toContain("traditional IRA (deductible)");
      expect(r.why).toContain("higher than expected in retirement");
    }
    expect(fact(ira[0]!, "Tax rate on your next dollar now")).toBe("22% (estimated from your income)");
    expect(String(fact(ira[0]!, "Expected rate on an extra pre-tax dollar in retirement"))).toContain("12%");
    expect(fact(ira[0]!, "Traditional IRA deduction")).toBe("Full");
  });

  it("falls back to Roth when the deduction would be lost, and says why", () => {
    const rich = input({
      taxView: view(32, 22),
      people: [
        { id: 1, name: "Alex", ageAtYearEnd: 40, income: 30_000_000, plan: { type: "401k", matchTiers: [], pretaxPct: 5, rothPct: 0 }, iraYtd: 0 },
        { id: 2, name: "Sam", ageAtYearEnd: 38, income: 0, plan: { type: "none", matchTiers: [], pretaxPct: 0, rothPct: 0 }, iraYtd: 0 },
      ],
    });
    const alex = step(rich, "ira")[0]!;
    expect(alex.action).toContain("backdoor Roth IRA");
    expect(alex.why).toContain("would not be deductible");
    expect(alex.why).toContain("backdoor Roth");
    expect(fact(alex, "Traditional IRA deduction")).toBe("None at your income");
  });

  it("explains a Roth choice when the rate now is lower, and a close call either way", () => {
    expect(step(input({ taxView: view(12, 22) }), "ira")[0]!.why).toContain("lower than expected in retirement");
    expect(step(input({ taxView: view(22, 24) }), "ira")[0]!.why).toContain("are close");
    expect(step(input({ taxView: view(12, 22) }), "ira")[0]!.action).toContain("Roth IRA");
  });

  it("does not claim a lean when the retirement side could not be worked out", () => {
    const partial: TaxView = { nowPct: 22, nowBasis: "income", retirementPct: null, retirementRange: null, lean: null };
    const ira = step(input({ taxView: partial }), "ira")[0]!;
    expect(ira.why).toContain("Roth suits most people");
    expect(fact(ira, "Expected rate on an extra pre-tax dollar in retirement")).toBeUndefined();
  });
});

describe("the workplace plan step with a tax view", () => {
  it("says which kind of money to add", () => {
    expect(step(input({ taxView: view(22, 12) }), "max_workplace")[0]!.why).toContain("pre-tax (traditional)");
    expect(step(input({ taxView: view(12, 22) }), "max_workplace")[0]!.why).toContain("Roth option");
    expect(step(input({ taxView: view(22, 23) }), "max_workplace")[0]!.why).toContain("Either works");
    expect(step(input(), "max_workplace")[0]!.why).toContain("Pre-tax or Roth contributions at work lower taxes");
  });

  it("uses the estimated rate for take-home cost unless one was entered", () => {
    const pretax = (over: Partial<WaterfallInput>) => step(input({ available: 8_000_000, ...over }), "employer_match")[0]!;
    // $120,000 at 3% match is 3% more; the cost in take-home pay shrinks by the rate.
    const none = pretax({});
    const estimated = pretax({ taxView: view(20, 12) });
    expect(estimated.amount).toBe(Math.round(none.amount * 0.8));
    // A rate typed by the user wins over the estimate.
    const typed = pretax({ taxView: view(20, 12), params: { starterAmount: 200_000, highInterestApr: 7, emergencyMonths: 3, marginalTaxPct: 30 } });
    expect(typed.amount).toBe(Math.round(none.amount * 0.7));
  });
});

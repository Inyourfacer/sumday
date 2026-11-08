import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { simulate, whatIfs, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import { benefitAtClaim, fullRetirementAge, requiredMinimum, rmdStartAge, seededRandom, type RmdTable } from "./rules.ts";
import { spendingAtAge, type SpendingPlan } from "./spending.ts";

const RMD = JSON.parse(readFileSync(new URL("../../../data/rmd/uniform-lifetime.json", import.meta.url), "utf8")) as RmdTable;
const HISTORY = (JSON.parse(readFileSync(new URL("../../../data/returns/us-annual.json", import.meta.url), "utf8")) as { years: HistoricalYear[] }).years;

describe("data files", () => {
  it("cover 1928 onward with sane values", () => {
    expect(HISTORY[0]!.year).toBe(1928);
    expect(HISTORY.length).toBeGreaterThanOrEqual(98);
    const y2008 = HISTORY.find((h) => h.year === 2008)!;
    expect(y2008.stocks).toBeCloseTo(-0.3655, 3);
    for (const h of HISTORY) {
      expect(Math.abs(h.stocks)).toBeLessThan(1);
      expect(Math.abs(h.inflation)).toBeLessThan(0.2);
    }
  });
});

describe("rules", () => {
  it("seeded random numbers repeat", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("knows full retirement age", () => {
    expect(fullRetirementAge(1950)).toBe(66);
    expect(fullRetirementAge(1957)).toBe(66.5);
    expect(fullRetirementAge(1966)).toBe(67);
  });

  it("adjusts Social Security for claiming early or late", () => {
    const ss = { at62: null, atFra: 200_000, at70: null };
    // FRA 67: at 62 that's 60 months early → 20% + 10% = 30% less.
    expect(benefitAtClaim(ss, 62, 1966)).toBe(140_000);
    // At 70: 36 months late → 24% more.
    expect(benefitAtClaim(ss, 70, 1966)).toBe(248_000);
    expect(benefitAtClaim(ss, 67, 1966)).toBe(200_000);
    // Without the FRA amount, interpolate between 62 and 70.
    expect(benefitAtClaim({ at62: 140_000, atFra: null, at70: 248_000 }, 66, 1966)).toBe(194_000);
    expect(benefitAtClaim({ at62: null, atFra: null, at70: null }, 67, 1966)).toBeNull();
  });

  it("uses the IRS table for required minimums", () => {
    expect(rmdStartAge(RMD, 1955)).toBe(73);
    expect(rmdStartAge(RMD, 1966)).toBe(75);
    // IRS example: age 75, $100,000 → $4,065.
    expect(requiredMinimum(RMD, 75, 10_000_000)).toBe(406_504);
    expect(requiredMinimum(RMD, 125, 10_000_000)).toBe(5_000_000); // 120+ divisor 2.0
    expect(requiredMinimum(RMD, 70, 10_000_000)).toBe(0);
  });
});

describe("retirement spending plan", () => {
  it("adds timed items and one-offs to the base", () => {
    const plan: SpendingPlan = {
      categories: [
        { categoryId: 1, name: "Housing", current: 3_000_000, retirement: 1_200_000 },
        { categoryId: 2, name: "Food", current: 1_000_000, retirement: null },
      ],
      items: [
        { label: "Travel", amount: 600_000, fromAge: null, toAge: 75 },
        { label: "Healthcare before Medicare", amount: 1_000_000, fromAge: null, toAge: 64 },
      ],
      oneOffs: [{ label: "Car", amount: 3_500_000, age: 66, everyYears: 8 }],
    };
    expect(spendingAtAge(plan, 64)).toBe(2_200_000 + 600_000 + 1_000_000);
    expect(spendingAtAge(plan, 66)).toBe(2_200_000 + 600_000 + 3_500_000);
    expect(spendingAtAge(plan, 74)).toBe(2_200_000 + 600_000 + 3_500_000);
    expect(spendingAtAge(plan, 80)).toBe(2_200_000);
  });
});

const flat = (over: Partial<HistoricalYear> = {}): HistoricalYear[] => [{ year: 2000, stocks: 0.05, bonds: 0.05, bills: 0.05, inflation: 0, ...over }];

const retiree = (over: Partial<SimPerson> = {}): SimPerson => ({
  id: 1,
  birthYear: 1956,
  retirementAge: 65,
  income: 0,
  raisePct: 0,
  pretaxPct: 0,
  rothPct: 0,
  matchTiers: [],
  hsaPayroll: 0,
  socialSecurity: null,
  claimAge: 67,
  pension: null,
  rmdStartAge: 73,
  ...over,
});

function input(over: Partial<SimInput> = {}): SimInput {
  const years = (over.endYear ?? 2055) - 2026 + 1;
  return {
    startYear: 2026,
    endYear: 2055,
    people: [retiree()],
    balances: { taxable: 100_000_000, taxableBasis: 100_000_000, roth: 0, hsa: 0, traditional: {} },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(years).fill(4_000_000),
    taxes: { ordinaryPct: 15, capitalGainsPct: 15 },
    history: flat(),
    rmd: RMD,
    runs: 20,
    blockLength: 5,
    seed: 1,
    ...over,
  };
}

describe("simulation mechanics (constant 5% returns, no inflation)", () => {
  it("withdraws, grows, and succeeds when spending is sustainable", () => {
    const r = simulate(input());
    expect(r.successRate).toBe(1);
    // Year 1: $1,000,000 − $40,000 (basis = value, so no tax), then +5%.
    expect(r.bands[0]!.p50).toBe(Math.round((100_000_000 - 4_000_000) * 1.05));
    // Every run is the same with constant returns.
    expect(r.bands[5]!.p10).toBe(r.bands[5]!.p90);
  });

  it("fails when the money runs out, and says when", () => {
    const r = simulate(input({ spending: Array(30).fill(10_000_000), taxes: { ordinaryPct: 0, capitalGainsPct: 0 } }));
    expect(r.successRate).toBe(0);
    // $1M at 5%, paying $100k at the start of each year: the balance before year k's payment is
    // $2.1M − $1.1M × 1.05^k, which drops below $100k at k = 13, so 2039 can't be paid.
    expect(r.medianDepletionYear).toBe(2039);
    // Tax on gains makes it run out sooner (or no later).
    const taxed = simulate(input({ spending: Array(30).fill(10_000_000) }));
    expect(taxed.medianDepletionYear).toBeLessThanOrEqual(2039);
  });

  it("counts Social Security and pensions as income", () => {
    const withSs = simulate(input({ people: [retiree({ socialSecurity: 300_000, claimAge: 70 })], spending: Array(30).fill(3_600_000) }));
    // From 70 (2026) on, Social Security covers the full $36,000: nothing withdrawn, 5% growth.
    expect(withSs.bands[0]!.p50).toBe(Math.round(100_000_000 * 1.05));
    // A pension without COLA shrinks in today's dollars when there's inflation.
    const pension = (cola: boolean) =>
      simulate(
        input({
          people: [retiree({ pension: { monthly: 300_000, startAge: 65, cola } })],
          spending: Array(30).fill(3_600_000),
          history: flat({ stocks: 0.08, bonds: 0.08, bills: 0.08, inflation: 0.03 }),
        }),
      ).bands.at(-1)!.p50;
    expect(pension(true)).toBeGreaterThan(pension(false));
  });

  it("takes required minimums from pre-tax money and reinvests what isn't needed", () => {
    const r = simulate(
      input({
        people: [retiree({ birthYear: 1951, rmdStartAge: 73 })], // 75 in 2026
        balances: { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: { 1: 100_000_000 } },
        spending: Array(30).fill(0),
      }),
    );
    const rmd = requiredMinimum(RMD, 75, 100_000_000);
    expect(r.bands[0]!.p50).toBe(Math.round((100_000_000 - rmd + rmd * 0.85) * 1.05));
  });

  it("adds contributions and employer match while working", () => {
    const worker = retiree({ birthYear: 1990, retirementAge: 65, income: 10_000_000, pretaxPct: 5, matchTiers: [{ matchPct: 100, upToPct: 5 }] });
    const r = simulate(input({ people: [worker], balances: { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: {} } }));
    // Year 1: $5,000 + $5,000 match, then 5%.
    expect(r.bands[0]!.p50).toBe(Math.round(1_000_000 * 1.05));
    expect(r.retireYear).toBe(2055);
  });
});

describe("simulation with real history", () => {
  const classic = (rate: number) =>
    simulate(
      input({
        history: HISTORY,
        runs: 2000,
        seed: 7,
        allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
        spending: Array(30).fill(rate * 100_000_000),
        taxes: { ordinaryPct: 0, capitalGainsPct: 0 },
      }),
    );

  it("matches the well-known shape: 4% over 30 years usually works, 8% usually doesn't", () => {
    const four = classic(0.04);
    const eight = classic(0.08);
    expect(four.successRate).toBeGreaterThan(0.8);
    expect(four.successRate).toBeLessThan(1);
    expect(eight.successRate).toBeLessThan(0.35);
    expect(four.bands[10]!.p10).toBeLessThan(four.bands[10]!.p50);
    expect(four.bands[10]!.p50).toBeLessThan(four.bands[10]!.p90);
  });

  it("is repeatable with the same seed", () => {
    expect(classic(0.05).successRate).toBe(classic(0.05).successRate);
  });

  it("answers the what-ifs", () => {
    const i = input({
      history: HISTORY,
      runs: 1000,
      people: [retiree({ birthYear: 1966, retirementAge: 65, income: 12_000_000, pretaxPct: 6, rmdStartAge: 75 })],
      balances: { taxable: 20_000_000, taxableBasis: 20_000_000, roth: 0, hsa: 0, traditional: { 1: 30_000_000 } },
      endYear: 2061,
      spending: Array(36).fill(9_000_000),
    });
    const base = simulate(i);
    const w = whatIfs(i, 0.85, base, 600);
    expect(w.retireAt.map((r) => r.shift)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    // Retiring later never makes things worse.
    for (let k = 1; k < w.retireAt.length; k++) expect(w.retireAt[k]!.successRate).toBeGreaterThanOrEqual(w.retireAt[k - 1]!.successRate - 0.03);
    expect(w.sustainableSpending).toBeGreaterThan(0);
    if (base.successRate < 0.85) {
      expect(w.toReachTarget.spendLessPerYear).toBeGreaterThan(0);
      expect(w.toReachTarget.extraMonthlySavings === null || w.toReachTarget.extraMonthlySavings > 0).toBe(true);
    }
  });
});

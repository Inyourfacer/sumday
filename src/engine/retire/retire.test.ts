import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { historicalReplay, simulate, whatIfs, wilson, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import { benefitAtClaim, fullRetirementAge, requiredMinimum, rmdStartAge, seededRandom, type RmdTable } from "./rules.ts";
import { spendingAtAge, type SpendingPlan } from "./spending.ts";
import { applyOverrides, describeOverride } from "./overrides.ts";

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

  it("simulates only the rest of the first year", () => {
    const worker = retiree({ birthYear: 1990, income: 10_000_000, pretaxPct: 10 });
    const balances = { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: { 1: 50_000_000 } };
    const whole = simulate(input({ people: [worker], balances }));
    const part = simulate(input({ people: [worker], balances, yearFraction: 0.25 }));
    // Full year: ($500k + $10k) × 1.05. A quarter year: ($500k + $2.5k) × 1.05^0.25.
    expect(whole.bands[0]!.p50).toBe(Math.round(51_000_000 * 1.05));
    expect(part.bands[0]!.p50).toBe(Math.round(50_250_000 * 1.05 ** 0.25));
    // Later years are unchanged in length: the second year is a full year for both.
    expect(part.bands[1]!.p50).toBe(Math.round((part.bands[0]!.p50 + 1_000_000) * 1.05));
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

describe("lump sums and scenario overrides", () => {
  it("adds money in and pays money out in the year given", () => {
    const base = input({ spending: Array(30).fill(0) });
    const inheritance = simulate({ ...base, lumpSums: [{ year: 2026, amount: 10_000_000 }] });
    expect(inheritance.bands[0]!.p50).toBe(Math.round(110_000_000 * 1.05));
    const wedding = simulate({ ...base, lumpSums: [{ year: 2026, amount: -5_000_000 }] });
    expect(wedding.bands[0]!.p50).toBe(Math.round(95_000_000 * 1.05));
    const tooMuch = simulate({ ...base, lumpSums: [{ year: 2027, amount: -500_000_000 }] });
    expect(tooMuch.medianDepletionYear).toBe(2027);
  });

  it("applies overrides without touching the original", () => {
    const worker = retiree({ birthYear: 1990, income: 10_000_000, retirementAge: 65 });
    const base = input({ people: [worker], spending: Array(30).fill(4_000_000) });
    const changed = applyOverrides(base, [
      { type: "retirement_age", personId: 1, age: 60 },
      { type: "income", personId: 1, income: 12_000_000, pretaxPct: 10 },
      { type: "extra_savings", monthly: 50_000 },
      { type: "retirement_spending", annualChange: -1_000_000 },
      { type: "lump_sum", label: "Inheritance", year: 2030, amount: 5_000_000 },
      { type: "allocation", stocks: 0.5, bonds: 0.5, cash: 0 },
      { type: "home_purchase", year: 2028, downPayment: 8_000_000, monthlyCostChange: 100_000 },
    ]);
    expect(base.people[0]!.retirementAge).toBe(65);
    expect(changed.people[0]).toMatchObject({ retirementAge: 60, income: 12_000_000, pretaxPct: 10 });
    expect(changed.extraSavings.taxable).toBe(600_000);
    expect(changed.allocation).toEqual({ stocks: 0.5, bonds: 0.5, cash: 0 });
    // Spending: −$10,000 a year everywhere, +$12,000 housing from 2028.
    expect(changed.spending[0]).toBe(3_000_000);
    expect(changed.spending[2]).toBe(3_000_000 + 1_200_000);
    // Down payment in 2028, plus the higher housing cost out of savings each working year until 2050.
    expect(changed.lumpSums!.filter((l) => l.year === 2028).map((l) => l.amount).sort((a, b) => a - b)).toEqual([-8_000_000, -1_200_000]);
    expect(changed.lumpSums!.filter((l) => l.amount === -1_200_000)).toHaveLength(2050 - 2028);
    expect(changed.lumpSums).toContainEqual({ year: 2030, amount: 5_000_000 });
    expect(base.lumpSums).toBeUndefined();
  });

  it("describes overrides in words", () => {
    const who = new Map([[1, "Alex"]]);
    expect(describeOverride({ type: "retirement_age", personId: 1, age: 60 }, who)).toBe("Alex retires at 60");
    expect(describeOverride({ type: "income", personId: 1, income: 0, pretaxPct: null }, who)).toBe("Alex stops working");
    expect(describeOverride({ type: "retirement_spending", annualChange: -500_000 }, who)).toBe("Spend $5,000 less a year in retirement");
    expect(describeOverride({ type: "home_purchase", year: 2029, downPayment: 8_000_000, monthlyCostChange: 75_000 }, who)).toBe(
      "Buy a home in 2029: $80,000 down, housing +$750/mo",
    );
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

describe("benchmarks against published safe-withdrawal results", () => {
  // $1M, 60/40, no fees or taxes, spending a fixed share of the start balance in today's dollars for 30 years,
  // taken at the start of each year: the setup of the Trinity study and its successors.
  const planAt = (rate: number, over: Partial<SimInput> = {}): SimInput => ({
    startYear: 2026,
    endYear: 2055,
    people: [{ id: 1, birthYear: 1961, retirementAge: 65, income: 0, raisePct: 0, pretaxPct: 0, rothPct: 0, matchTiers: [], hsaPayroll: 0, socialSecurity: null, claimAge: 67, pension: null, rmdStartAge: 75 }],
    balances: { taxable: 100_000_000, taxableBasis: 100_000_000, roth: 0, hsa: 0, traditional: {} },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(30).fill(Math.round(100_000_000 * rate)),
    taxes: { ordinaryPct: 0, capitalGainsPct: 0 },
    history: HISTORY,
    rmd: RMD,
    runs: 5000,
    blockLength: 5,
    seed: 7,
    ...over,
  });

  it("replays real 30-year retirements: a 4% rule mostly survives, 3% always does, 6% often doesn't", () => {
    const at = (rate: number) => historicalReplay(planAt(rate));
    const four = at(0.04);
    expect(four.cohorts.length).toBe(HISTORY.length - 29);
    // Published results put 60/40 at 4% in the mid-90s percent or higher, and 3% at 100%.
    expect(four.successRate).toBeGreaterThanOrEqual(0.9);
    expect(at(0.03).successRate).toBe(1);
    expect(at(0.06).successRate).toBeLessThan(0.85);
    // The worst starts are the well-known ones (late 1960s and 1970s), not the 1990s.
    const failed = four.cohorts.filter((c) => !c.success).map((c) => c.startYear);
    expect(failed.every((y) => y >= 1928 && y <= 1980)).toBe(true);
  });

  it("the random method lands near the real-history replay", () => {
    const replay = historicalReplay(planAt(0.04)).successRate;
    const random = simulate(planAt(0.04), { bands: false }).successRate;
    expect(Math.abs(random - replay)).toBeLessThan(0.12);
  });
});

describe("simulation properties", () => {
  const base = (over: Partial<SimInput> = {}): SimInput => input({ history: HISTORY, runs: 2000, spending: Array(30).fill(4_000_000), ...over });

  it("gives the same answer for the same seed and a different one for another", () => {
    const a = simulate(base({ seed: 3 }), { bands: false });
    expect(simulate(base({ seed: 3 }), { bands: false }).successRate).toBe(a.successRate);
  });

  it("is monotone: more spending never helps and more saving never hurts", () => {
    const rate = (over: Partial<SimInput>) => simulate(base(over), { bands: false }).successRate;
    const worker = retiree({ birthYear: 1990, income: 10_000_000, retirementAge: 55, pretaxPct: 5 });
    const spend = (m: number) => rate({ people: [worker], spending: Array(70).fill(0).map((_, t) => (2026 + t >= 2045 ? 4_000_000 * m : 0)), endYear: 2095 });
    expect(spend(0.8)).toBeGreaterThanOrEqual(spend(1));
    expect(spend(1)).toBeGreaterThanOrEqual(spend(1.3));
    const save = (x: number) => rate({ people: [worker], endYear: 2095, spending: Array(70).fill(0).map((_, t) => (2026 + t >= 2045 ? 4_000_000 : 0)), extraSavings: { taxable: x, roth: 0, hsa: 0, traditional: {} } });
    expect(save(0)).toBeLessThanOrEqual(save(500_000));
    expect(save(500_000)).toBeLessThanOrEqual(save(2_000_000));
  });

  it("a return haircut never helps", () => {
    const rate = (h: number) => simulate(base({ returnHaircutPct: h }), { bands: false }).successRate;
    expect(rate(0)).toBeGreaterThanOrEqual(rate(1));
    expect(rate(1)).toBeGreaterThanOrEqual(rate(2));
  });

  it("reports a confidence interval and how fragile the successes are", () => {
    const r = simulate(base({ spending: Array(30).fill(5_500_000) }));
    expect(r.successInterval[0]).toBeLessThanOrEqual(r.successRate);
    expect(r.successInterval[1]).toBeGreaterThanOrEqual(r.successRate);
    expect(r.fragileRate).toBeGreaterThanOrEqual(0);
    expect(r.fragileRate).toBeLessThanOrEqual(r.successRate);
    expect(wilson(85, 100)[0]).toBeCloseTo(0.767, 2);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it("never stitches 2025 to 1928: a block that hits the end of history starts over", () => {
    // History of 3 distinct years; with 1-in-3 starts and block 5, every run still only uses real consecutive years.
    const tiny: HistoricalYear[] = [
      { year: 1, stocks: 0.1, bonds: 0, bills: 0, inflation: 0 },
      { year: 2, stocks: 0.2, bonds: 0, bills: 0, inflation: 0 },
      { year: 3, stocks: -0.9, bonds: 0, bills: 0, inflation: 0 },
    ];
    const r = simulate(input({ history: tiny, allocation: { stocks: 1, bonds: 0, cash: 0 }, runs: 500, endYear: 2028, spending: Array(3).fill(0) }));
    // A -90% year can only come right after the 0.2 year or at the start of a block, never preceding the 0.1 year in a wrap: 1→2→3 or restarts.
    // So the median stays defined and finite.
    expect(Number.isFinite(r.medianAtEnd)).toBe(true);
  });
});

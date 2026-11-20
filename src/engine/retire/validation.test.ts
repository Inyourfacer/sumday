/**
 * Checks of the model against things published elsewhere, so a formula error shows up as a
 * disagreement with the outside world instead of passing quietly because the code agrees with itself.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MORTALITY, survival } from "./longevity.ts";
import { historicalReplay, simulate, type HistoricalYear, type SimInput } from "./montecarlo.ts";
import type { RmdTable } from "./rules.ts";
import { irmaaSurcharge, type TaxTable } from "./tax.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../data/${path}`, import.meta.url), "utf8"));
const HISTORY = (read("returns/us-annual.json") as { years: HistoricalYear[] }).years;
const RMD = read("rmd/uniform-lifetime.json") as RmdTable;
const TABLE = read("tax/2026.json") as TaxTable;
const SSA = read("mortality/ssa-period-2023.json") as { lives: Record<"male" | "female", Record<string, number>> };
const dollars = (d: number) => d * 100;

describe("lifespans against the SSA 2023 period life table", () => {
  const ages = [70, 75, 80, 85, 90, 95, 100, 105];
  const alive = (sex: "male" | "female", age: number) => SSA.lives[sex][String(age)]! / SSA.lives[sex]["65"]!;

  it("matches the average of men and women at 65 within a point and a half", () => {
    for (const age of ages) {
      const table = (alive("male", age) + alive("female", age)) / 2;
      expect(Math.abs(survival(65, age, DEFAULT_MORTALITY) - table)).toBeLessThan(0.015);
    }
  });

  it("sits between the male and female tables, so changing the mode can reach either", () => {
    for (const age of [80, 85, 90, 95]) {
      const s = survival(65, age, DEFAULT_MORTALITY);
      expect(s).toBeGreaterThan(alive("male", age));
      expect(s).toBeLessThan(alive("female", age));
    }
  });
});

describe("Medicare surcharges against SSA's published 2026 tiers", () => {
  const irmaa = TABLE.irmaa!;
  const monthly = (filing: "single" | "married_joint" | "married_separate", magi: number) => irmaaSurcharge(dollars(magi), filing, irmaa) / 100;

  it("charges nothing up to the first threshold and steps up just over it", () => {
    expect(monthly("single", 109_000)).toBe(0);
    expect(monthly("single", 109_001)).toBe(81.2);
    expect(monthly("married_joint", 218_000)).toBe(0);
    expect(monthly("married_joint", 218_001)).toBe(81.2);
  });

  it("matches every tier for single and joint filers", () => {
    const single: [number, number][] = [[137_000, 81.2], [137_001, 202.9], [171_000, 202.9], [171_001, 324.6], [205_000, 324.6], [205_001, 446.3], [499_999, 446.3], [500_000, 487]];
    for (const [magi, extra] of single) expect(monthly("single", magi)).toBe(extra);
    const joint: [number, number][] = [[274_000, 81.2], [274_001, 202.9], [342_000, 202.9], [342_001, 324.6], [410_000, 324.6], [410_001, 446.3], [749_999, 446.3], [750_000, 487]];
    for (const [magi, extra] of joint) expect(monthly("married_joint", magi)).toBe(extra);
  });

  it("puts married-filing-separately above $109,000 straight into the high tiers", () => {
    expect(monthly("married_separate", 109_000)).toBe(0);
    expect(monthly("married_separate", 109_001)).toBe(446.3);
    expect(monthly("married_separate", 390_999)).toBe(446.3);
    expect(monthly("married_separate", 391_000)).toBe(487);
  });
});

describe("the classic safe-withdrawal results", () => {
  const retiree = (rate: number, years: number, stocks: number, history = HISTORY): SimInput => ({
    startYear: 2026,
    endYear: 2026 + years - 1,
    people: [{ id: 1, birthYear: 1960, retirementAge: 60, income: 0, raisePct: 0, pretaxPct: 0, rothPct: 0, matchTiers: [], hsaPayroll: 0, socialSecurity: null, claimAge: 67, pension: null, rmdStartAge: 99 }],
    balances: { taxable: dollars(1_000_000), taxableBasis: dollars(1_000_000), roth: 0, hsa: 0, traditional: {} },
    allocation: { stocks, bonds: 1 - stocks, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(years).fill(Math.round(dollars(1_000_000) * rate)),
    taxes: { ordinaryPct: 0, capitalGainsPct: 0 },
    history,
    rmd: RMD,
    runs: 1,
    blockLength: 5,
    seed: 1,
  });

  // Bengen (1994) and the Trinity study (1998) found that 4% of the starting portfolio, raised with
  // inflation, lasted 30 years in about 95% of historical starts for a 50/50 mix, and that the failures
  // were the retirees of the mid-1960s. Their bond series differ from ours (they use intermediate
  // Treasuries, we use the 10-year), so we expect close agreement, not equality.
  it("lets a 50/50 portfolio spend about 4% for 30 years in over nine in ten historical starts, failing only in the mid-1960s", () => {
    const r = historicalReplay(retiree(0.04, 30, 0.5));
    expect(r.successRate).toBeGreaterThan(0.9);
    expect(r.successRate).toBeLessThan(0.97);
    const failures = r.cohorts.filter((c) => !c.success).map((c) => c.startYear);
    expect(failures.length).toBeGreaterThan(0);
    for (const year of failures) expect(year).toBeGreaterThanOrEqual(1964);
    for (const year of failures) expect(year).toBeLessThanOrEqual(1969);
  });

  it("finds the worst-case 30-year rate near 4%, set by a 1960s start", () => {
    let worst = { year: 0, rate: 1 };
    const starts = HISTORY.length - 30 + 1;
    for (let s = 0; s < starts; s++) {
      const window = HISTORY.slice(s, s + 30);
      let lo = 0.01;
      let hi = 0.12;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (historicalReplay(retiree(mid, 30, 0.5, window)).cohorts[0]!.success) lo = mid;
        else hi = mid;
      }
      if (lo < worst.rate) worst = { year: window[0]!.year, rate: lo };
    }
    // Bengen's SAFEMAX is 4.15% (1968 start); with the 10-year Treasury, which fell harder in the 1970s, we get a bit less.
    expect(worst.rate).toBeGreaterThan(0.034);
    expect(worst.rate).toBeLessThan(0.042);
    expect(worst.year).toBeGreaterThanOrEqual(1964);
    expect(worst.year).toBeLessThanOrEqual(1969);
  });

  it("does worse the longer the retirement and the higher the withdrawal", () => {
    const rate = (r: number, years: number) => historicalReplay(retiree(r, years, 0.5)).successRate;
    expect(rate(0.04, 20)).toBeGreaterThanOrEqual(rate(0.04, 30));
    expect(rate(0.04, 30)).toBeGreaterThanOrEqual(rate(0.05, 30));
    expect(rate(0.03, 30)).toBeGreaterThan(0.98);
    expect(rate(0.06, 30)).toBeLessThan(0.7);
  });
});

describe("closed-form checks", () => {
  it("matches the annuity formula with real growth after inflation", () => {
    // 8% nominal, 3% inflation: real growth 1.08/1.03 − 1. A fixed real withdrawal at the start of each year.
    const history: HistoricalYear[] = [{ year: 2000, stocks: 0.08, bonds: 0.08, bills: 0.08, inflation: 0.03 }];
    const g = 1.08 / 1.03;
    const w = dollars(40_000);
    const b0 = dollars(1_000_000);
    const input: SimInput = {
      startYear: 2026,
      endYear: 2035,
      people: [{ id: 1, birthYear: 1960, retirementAge: 60, income: 0, raisePct: 0, pretaxPct: 0, rothPct: 0, matchTiers: [], hsaPayroll: 0, socialSecurity: null, claimAge: 67, pension: null, rmdStartAge: 99 }],
      balances: { taxable: b0, taxableBasis: b0, roth: 0, hsa: 0, traditional: {} },
      allocation: { stocks: 1, bonds: 0, cash: 0 },
      feePct: 0,
      extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
      spending: Array(10).fill(w),
      taxes: { ordinaryPct: 0, capitalGainsPct: 0 },
      history,
      rmd: RMD,
      runs: 3,
      blockLength: 5,
      seed: 1,
    };
    const r = simulate(input);
    let b = b0;
    for (let t = 0; t < 10; t++) {
      b = (b - w) * g;
      expect(r.bands[t]!.p50).toBeCloseTo(b, -1);
    }
  });
});

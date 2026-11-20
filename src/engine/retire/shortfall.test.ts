import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareRuns, simulate, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import type { RmdTable } from "./rules.ts";

const RMD = JSON.parse(readFileSync(new URL("../../../data/rmd/uniform-lifetime.json", import.meta.url), "utf8")) as RmdTable;
const HISTORY = (JSON.parse(readFileSync(new URL("../../../data/returns/us-annual.json", import.meta.url), "utf8")) as { years: HistoricalYear[] }).years;
const dollars = (d: number) => d * 100;
const flat: HistoricalYear[] = [{ year: 2000, stocks: 0.05, bonds: 0.05, bills: 0.05, inflation: 0 }];

const person = (over: Partial<SimPerson> = {}): SimPerson => ({
  id: 1,
  birthYear: 1959,
  retirementAge: 60,
  income: 0,
  raisePct: 0,
  pretaxPct: 0,
  rothPct: 0,
  matchTiers: [],
  hsaPayroll: 0,
  socialSecurity: null,
  claimAge: 67,
  pension: null,
  rmdStartAge: 75,
  ...over,
});

function plan(over: Partial<SimInput> = {}): SimInput {
  return {
    startYear: 2026,
    endYear: 2035,
    people: [person()],
    balances: { taxable: dollars(100_000), taxableBasis: dollars(100_000), roth: 0, hsa: 0, traditional: {} },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(10).fill(dollars(50_000)),
    taxes: { ordinaryPct: 0, capitalGainsPct: 0 },
    history: flat,
    rmd: RMD,
    runs: 20,
    blockLength: 5,
    seed: 5,
    ...over,
  };
}

describe("how big the shortfall is", () => {
  it("adds up the spending nothing covers from the year the money runs out", () => {
    // $100,000 lasts two years at $50,000 with 5% growth; the third year onward (eight years) goes unfunded.
    const r = simulate(plan(), { bands: false });
    expect(r.successRate).toBe(0);
    expect(r.shortfall.failedMedian).toBe(dollars(400_000));
    expect(r.shortfall.failedMedianYears).toBe(8);
    expect(r.shortfall.expected).toBe(dollars(400_000));
  });

  it("subtracts income that keeps arriving", () => {
    const r = simulate(plan({ people: [person({ socialSecurity: dollars(1_000) })] }), { bands: false });
    // $12,000 a year of Social Security leaves $38,000 a year unfunded for the eight years.
    expect(r.shortfall.failedMedian).toBeCloseTo(dollars(38_000 * 8), -3);
  });

  it("is zero, and has no failing futures to describe, when the money lasts", () => {
    const r = simulate(plan({ balances: { taxable: dollars(2_000_000), taxableBasis: dollars(2_000_000), roth: 0, hsa: 0, traditional: {} } }), { bands: false });
    expect(r.shortfall).toEqual({ expected: 0, failedMedian: null, failedP90: null, failedMedianYears: null });
  });

  it("separates a plan that barely fails from one that fails badly", () => {
    const run = (spend: number) =>
      simulate(plan({ history: HISTORY, runs: 500, endYear: 2055, spending: Array(30).fill(dollars(spend)), balances: { taxable: dollars(1_000_000), taxableBasis: dollars(1_000_000), roth: 0, hsa: 0, traditional: {} } }), { bands: false });
    const mild = run(45_000);
    const harsh = run(80_000);
    expect(harsh.shortfall.expected).toBeGreaterThan(mild.shortfall.expected);
    expect(harsh.shortfall.failedMedian!).toBeGreaterThan(mild.shortfall.failedMedian ?? 0);
    expect(harsh.shortfall.failedP90!).toBeGreaterThanOrEqual(harsh.shortfall.failedMedian!);
  });
});

describe("comparing two plans on the same futures", () => {
  const stress = (over: Partial<SimInput> = {}) =>
    plan({ history: HISTORY, runs: 400, endYear: 2055, spending: Array(30).fill(dollars(55_000)), balances: { taxable: dollars(1_000_000), taxableBasis: dollars(1_000_000), roth: 0, hsa: 0, traditional: {} }, ...over });

  it("finds no difference between a plan and itself", () => {
    const a = simulate(stress(), { bands: false, perRun: true }).perRun!;
    const b = simulate(stress(), { bands: false, perRun: true }).perRun!;
    expect(compareRuns(a, b)).toEqual({ better: 0, worse: 0, medianEndDifference: 0, medianTaxDifference: 0, saved: 0, lost: 0 });
  });

  it("counts the futures a change saves, and none it loses, when it only adds money", () => {
    const base = simulate(stress(), { bands: false, perRun: true });
    const richer = simulate(stress({ balances: { taxable: dollars(1_200_000), taxableBasis: dollars(1_200_000), roth: 0, hsa: 0, traditional: {} } }), { bands: false, perRun: true });
    const c = compareRuns(base.perRun!, richer.perRun!);
    expect(c.lost).toBe(0);
    expect(c.saved).toBeGreaterThan(0);
    expect(c.medianEndDifference).toBeGreaterThan(0);
    expect(c.saved).toBeCloseTo(richer.successRate - base.successRate, 10);
  });
});

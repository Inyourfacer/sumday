import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareRuns, simulate, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import type { RmdTable } from "./rules.ts";
import type { TaxSetup, TaxTable } from "./tax.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../data/${path}`, import.meta.url), "utf8"));
const RMD = read("rmd/uniform-lifetime.json") as RmdTable;
const TABLE = read("tax/2026.json") as TaxTable;
const HISTORY = (read("returns/us-annual.json") as { years: HistoricalYear[] }).years;
const dollars = (d: number) => d * 100;
const flat: HistoricalYear[] = [{ year: 2000, stocks: 0.05, bonds: 0.05, bills: 0.05, inflation: 0 }];
const joint: TaxSetup = { table: TABLE, filing: "married_joint", statePct: 0 };

const person = (id: number, birthYear: number, over: Partial<SimPerson> = {}): SimPerson => ({
  id,
  birthYear,
  retirementAge: 55,
  income: 0,
  raisePct: 0,
  pretaxPct: 0,
  rothPct: 0,
  matchTiers: [],
  hsaPayroll: 0,
  socialSecurity: null,
  claimAge: 67,
  pia: null,
  fra: 67,
  pension: null,
  rmdStartAge: 75,
  ...over,
});

function plan(over: Partial<SimInput> = {}): SimInput {
  return {
    startYear: 2026,
    endYear: 2026,
    people: [person(1, 1976)], // 50: no senior deductions; no penalty rules unless asked
    balances: { taxable: dollars(500_000), taxableBasis: dollars(500_000), roth: 0, hsa: 0, traditional: { 1: dollars(500_000) } },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: [dollars(60_000)],
    taxes: { ordinaryPct: 15, capitalGainsPct: 15, brackets: joint },
    history: flat,
    rmd: RMD,
    runs: 3,
    blockLength: 5,
    seed: 8,
    ...over,
  };
}
const tax = (over: Partial<SimInput>) => simulate(plan(over), { bands: false }).medianLifetimeTax! / 100;

describe("drawing pre-tax money first, up to a bracket", () => {
  it("is off by default: taxable savings come first and there is no tax on them here", () => {
    expect(tax({})).toBe(0);
  });

  it("stops at the top of the chosen bracket", () => {
    // 10% bracket tops out at $24,800 of taxable income, so $57,000 of income with the $32,200 deduction: $2,480 of tax.
    // The other $5,480 of spending comes from taxable savings, which have no gain.
    expect(tax({ withdrawalFill: { ratePct: 10 } })).toBeCloseTo(2_480, 0);
  });

  it("draws only what spending needs when that fits inside the bracket", () => {
    // Net $60,000 needs G with G − (2,480 + 12% × (G − 57,000)) = 60,000, so G ≈ $63,227 and tax ≈ $3,227: inside the 12% bracket.
    expect(tax({ withdrawalFill: { ratePct: 12 } })).toBeCloseTo(3_227.27, 0);
    expect(tax({ withdrawalFill: { ratePct: 22 } })).toBeCloseTo(tax({ withdrawalFill: { ratePct: 12 } }), 0);
  });

  it("fills only the bracket and takes the rest from taxable savings when spending is large", () => {
    // $300,000 of spending: pre-tax up to $133,000 of income (12% bracket), $11,600 of tax, then taxable savings.
    const big = { spending: [dollars(300_000)], balances: { taxable: dollars(1_000_000), taxableBasis: dollars(1_000_000), roth: 0, hsa: 0, traditional: { 1: dollars(1_000_000) } } };
    expect(tax({ ...big, withdrawalFill: { ratePct: 12 } })).toBeCloseTo(11_600, -1);
  });

  it("leaves money that carries a penalty alone", () => {
    // Under 60 with the early-withdrawal rules on and no rule of 55: pre-tax money is not drawn first.
    const early = plan({ penalties: { rothBasisShare: 1, ruleOf55: false, freeTraditional: {} }, withdrawalFill: { ratePct: 12 } });
    const r = simulate(early, { bands: false });
    expect(r.medianLifetimeTax).toBe(0);
    expect(r.penalties!.median).toBe(0);
  });

  it("counts pensions and Social Security as income already using the bracket", () => {
    const withPension = (monthly: number, over: Partial<SimInput> = {}) =>
      tax({ people: [person(1, 1976, { pension: { monthly: dollars(monthly), startAge: 50, cola: true } })], ...over });
    // $50,000 of pension leaves only $7,000 of room in the 10% bracket: tax is $2,480 whether or not that room is used.
    expect(withPension(50_000 / 12, { withdrawalFill: { ratePct: 10 } })).toBeCloseTo(2_480, 0);
    // The same pension without the bracket rule is taxed on the pension alone: $17,800 taxable, $1,780.
    expect(withPension(50_000 / 12)).toBeCloseTo(1_780, 0);
    // $80,000 of pension is already past the bracket: nothing is drawn first, so the tax is the same either way.
    expect(withPension(80_000 / 12, { withdrawalFill: { ratePct: 10 } })).toBeCloseTo(withPension(80_000 / 12), 0);
  });
});

describe("over a retirement", () => {
  const couple = (over: Partial<SimInput> = {}): SimInput =>
    plan({
      startYear: 2026,
      endYear: 2061,
      people: [person(1, 1961, { socialSecurity: dollars(2_800), pia: dollars(2_800) }), person(2, 1962, { socialSecurity: dollars(2_800), pia: dollars(2_800) })],
      balances: { taxable: dollars(600_000), taxableBasis: dollars(350_000), roth: dollars(200_000), hsa: 0, traditional: { 1: dollars(1_000_000), 2: dollars(500_000) } },
      spending: Array(36).fill(dollars(100_000)),
      history: HISTORY,
      runs: 400,
      seed: 11,
      spousalBenefits: true,
      ...over,
    });

  it("lowers lifetime tax and leaves more after tax in nearly every future", () => {
    const standard = simulate(couple(), { bands: false, perRun: true });
    const filled = simulate(couple({ withdrawalFill: { ratePct: 12 } }), { bands: false, perRun: true });
    expect(filled.medianLifetimeTax!).toBeLessThan(standard.medianLifetimeTax!);
    const c = compareRuns(standard.perRun!, filled.perRun!);
    expect(c.better).toBeGreaterThan(0.8);
    expect(c.medianEndDifference).toBeGreaterThan(0);
    expect(c.medianTaxDifference).toBeLessThan(0);
    expect(c.lost).toBe(0);
  });

  it("does nothing when pre-tax savings are gone", () => {
    const none = { balances: { taxable: dollars(1_500_000), taxableBasis: dollars(900_000), roth: dollars(200_000), hsa: 0, traditional: {} } };
    const a = simulate(couple(none), { bands: false });
    const b = simulate(couple({ ...none, withdrawalFill: { ratePct: 12 } }), { bands: false });
    expect(b.medianLifetimeTax).toBe(a.medianLifetimeTax);
    expect(b.successRate).toBe(a.successRate);
  });
});

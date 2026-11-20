import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { simulate, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import type { RmdTable } from "./rules.ts";
import { marginalOrdinaryPct, type TaxSetup, type TaxTable } from "./tax.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../data/${path}`, import.meta.url), "utf8"));
const RMD = read("rmd/uniform-lifetime.json") as RmdTable;
const TABLE = read("tax/2026.json") as TaxTable;
const dollars = (d: number) => d * 100;
const flat: HistoricalYear[] = [{ year: 2000, stocks: 0.05, bonds: 0.05, bills: 0.05, inflation: 0 }];

const person = (over: Partial<SimPerson> = {}): SimPerson => ({
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

function plan(setup: TaxSetup, over: Partial<SimInput> = {}): SimInput {
  return {
    startYear: 2026,
    endYear: 2040,
    people: [person()],
    balances: { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: { 1: dollars(2_000_000) } },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(15).fill(dollars(80_000)),
    taxes: { ordinaryPct: 15, capitalGainsPct: 15, brackets: setup },
    history: flat,
    rmd: RMD,
    runs: 5,
    blockLength: 5,
    seed: 6,
    trackMarginal: true,
    ...over,
  };
}
const joint: TaxSetup = { table: TABLE, filing: "married_joint", statePct: 0 };

describe("the tax rate on an extra dollar in retirement", () => {
  it("finds the bracket for a taxable income", () => {
    expect(marginalOrdinaryPct(TABLE, "married_joint", 0)).toBe(10);
    expect(marginalOrdinaryPct(TABLE, "married_joint", dollars(24_799))).toBe(10);
    expect(marginalOrdinaryPct(TABLE, "married_joint", dollars(24_800))).toBe(12);
    expect(marginalOrdinaryPct(TABLE, "married_joint", dollars(500_000))).toBe(32);
    expect(marginalOrdinaryPct(TABLE, "married_joint", dollars(600_000))).toBe(35);
    expect(marginalOrdinaryPct(TABLE, "single", dollars(1_000_000))).toBe(37);
  });

  it("is the bracket that the withdrawals reach, plus the state rate", () => {
    // About $85,000 drawn from pre-tax money for $80,000 of spending: taxable income is in the 12% bracket.
    const r = simulate(plan(joint), { bands: false });
    expect(r.marginal!.median).toBe(12);
    expect(simulate(plan({ ...joint, statePct: 5 }), { bands: false }).marginal!.median).toBe(17);
  });

  it("is higher with more income and lower with less", () => {
    const rate = (spend: number) => simulate(plan(joint, { spending: Array(15).fill(dollars(spend)) }), { bands: false }).marginal!.median;
    expect(rate(30_000)).toBeLessThan(rate(80_000));
    expect(rate(80_000)).toBeLessThan(rate(260_000));
  });

  it("counts the extra tax on Social Security", () => {
    // With benefits in the range where each extra dollar makes more of them taxable, the rate runs above the bracket.
    const withSs = simulate(plan(joint, { people: [person({ socialSecurity: dollars(3_000), claimAge: 65 })], spending: Array(15).fill(dollars(75_000)) }), { bands: false });
    expect(withSs.marginal!.median).toBeGreaterThan(12.5);
  });

  it("is not reported unless asked for, or without bracket taxes", () => {
    expect(simulate(plan(joint, { trackMarginal: false }), { bands: false }).marginal).toBeNull();
    expect(simulate(plan(joint, { taxes: { ordinaryPct: 15, capitalGainsPct: 15 } }), { bands: false }).marginal).toBeNull();
  });
});

describe("retirees aged 65 and over", () => {
  it("owe less tax on the same withdrawals", () => {
    const tax = (birthYear: number) =>
      simulate(plan(joint, { people: [person({ birthYear })], endYear: 2026, spending: [dollars(60_000)], runs: 2 }), { bands: false }).medianLifetimeTax!;
    // 70 against 50 in 2026: $1,650 more standard deduction and the $6,000 senior deduction.
    expect(tax(1976)).toBeGreaterThan(tax(1956));
    const gap = tax(1976) - tax(1956);
    expect(gap).toBeGreaterThan(dollars(700));
    expect(gap).toBeLessThan(dollars(1_100));
  });

  it("lose the senior deduction after 2028", () => {
    // Same person and withdrawals in 2026 and in 2030 (through the same one-year plan shifted forward): the later year owes more.
    const tax = (startYear: number) =>
      simulate(plan(joint, { people: [person({ birthYear: startYear - 70 })], startYear, endYear: startYear, spending: [dollars(60_000)], runs: 2 }), { bands: false }).medianLifetimeTax!;
    expect(tax(2030)).toBeGreaterThan(tax(2027));
  });
});

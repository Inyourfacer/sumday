import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { simulate, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import type { RmdTable } from "./rules.ts";
import type { TaxSetup, TaxTable } from "./tax.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../data/${path}`, import.meta.url), "utf8"));
const RMD = read("rmd/uniform-lifetime.json") as RmdTable;
const TABLE = read("tax/2026.json") as TaxTable;
const dollars = (d: number) => d * 100;
const flat: HistoricalYear[] = [{ year: 2000, stocks: 0.05, bonds: 0.05, bills: 0.05, inflation: 0 }];
const single: TaxSetup = { table: TABLE, filing: "single", statePct: 0 };

const person = (over: Partial<SimPerson> = {}): SimPerson => ({
  id: 1,
  birthYear: 1976, // 50 in 2026
  retirementAge: 50,
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
    endYear: 2055,
    people: [person()],
    balances: { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: { 1: dollars(1_000_000) } },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(30).fill(dollars(40_000)),
    taxes: { ordinaryPct: 15, capitalGainsPct: 15, brackets: single },
    history: flat,
    rmd: RMD,
    runs: 20,
    blockLength: 5,
    seed: 3,
    ...over,
  };
}
const rules = (over: Partial<NonNullable<SimInput["penalties"]>> = {}) => ({ rothBasisShare: 1, ruleOf55: true, freeTraditional: {}, ...over });
const run = (over: Partial<SimInput>) => simulate(plan(over), { bands: false });

describe("early-withdrawal penalties", () => {
  it("charge 10% on pre-tax money drawn before 60, and only until then", () => {
    const r = run({ penalties: rules() });
    // About ten years of $40,000 plus the tax on it, at 10%.
    expect(r.penalties!.median).toBeGreaterThan(dollars(35_000));
    expect(r.penalties!.median).toBeLessThan(dollars(60_000));
    expect(r.penalties!.share).toBe(1);
    // Someone already past 60 pays none.
    const later = run({ people: [person({ birthYear: 1960, retirementAge: 66 })], penalties: rules() });
    expect(later.penalties!.median).toBe(0);
  });

  it("make an early retirement fail sooner, never help", () => {
    const base = run({});
    const withRules = run({ penalties: rules() });
    expect(base.penalties).toBeNull();
    expect(withRules.medianEndAfterTax).toBeLessThan(base.medianEndAfterTax);
  });

  it("apply only in bracket tax mode", () => {
    expect(run({ penalties: rules(), taxes: { ordinaryPct: 15, capitalGainsPct: 15 } }).penalties).toBeNull();
  });

  it("are skipped for workplace money under the rule of 55, but not without it", () => {
    // 56 in 2026, stopped work at 55: the 401(k) is open until 60.
    const person56 = [person({ birthYear: 1970, retirementAge: 55 })];
    const free = run({ people: person56, penalties: rules({ freeTraditional: { 1: dollars(1_000_000) } }) });
    expect(free.penalties!.median).toBe(0);
    expect(run({ people: person56, penalties: rules({ freeTraditional: {} }) }).penalties!.median).toBeGreaterThan(0);
    expect(run({ people: person56, penalties: rules({ ruleOf55: false, freeTraditional: { 1: dollars(1_000_000) } }) }).penalties!.median).toBeGreaterThan(0);
    // Stopping at 54 does not qualify.
    expect(run({ people: [person({ birthYear: 1970, retirementAge: 54 })], penalties: rules({ freeTraditional: { 1: dollars(1_000_000) } }) }).penalties!.median).toBeGreaterThan(0);
  });
});

describe("Roth withdrawals before 60", () => {
  const rothOnly = { taxable: 0, taxableBasis: 0, roth: dollars(1_000_000), hsa: 0, traditional: {} };

  it("take contributions penalty-free but charge for growth", () => {
    const contributions = run({ balances: rothOnly, penalties: rules({ rothBasisShare: 1 }), spending: Array(30).fill(dollars(30_000)) });
    expect(contributions.penalties!.median).toBe(0);
    const growth = run({ balances: rothOnly, penalties: rules({ rothBasisShare: 0 }), spending: Array(30).fill(dollars(30_000)) });
    expect(growth.penalties!.median).toBeGreaterThan(dollars(20_000));
  });

  it("let a conversion ladder open pre-tax money after five years", () => {
    // Taxable savings last about three years; after that only pre-tax money (penalized) or aged conversions are left.
    const balances = { taxable: dollars(100_000), taxableBasis: dollars(100_000), roth: 0, hsa: 0, traditional: { 1: dollars(1_000_000) } };
    const spending = Array(30).fill(dollars(40_000));
    const without = run({ balances, spending, penalties: rules() });
    const ladder = run({ balances, spending, penalties: rules(), conversion: { targetRatePct: 12, startYear: 2026, endYear: 2040 } });
    expect(ladder.medianConverted!).toBeGreaterThan(dollars(100_000));
    expect(ladder.penalties!.median).toBeLessThan(without.penalties!.median);
  });

  it("charge 10% on a conversion spent inside its five years", () => {
    // Taxable money runs out after about two years; the only other money is what was just converted.
    const balances = { taxable: dollars(70_000), taxableBasis: dollars(70_000), roth: 0, hsa: 0, traditional: { 1: dollars(300_000) } };
    const spending = Array(30).fill(dollars(35_000));
    const early = run({ balances, spending, penalties: rules(), conversion: { targetRatePct: 22, startYear: 2026, endYear: 2026 } });
    expect(early.penalties!.median).toBeGreaterThan(0);
  });
});

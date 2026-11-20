import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { simulate, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import type { RmdTable } from "./rules.ts";

const RMD = JSON.parse(readFileSync(new URL("../../../data/rmd/uniform-lifetime.json", import.meta.url), "utf8")) as RmdTable;
const dollars = (d: number) => d * 100;
const flat: HistoricalYear[] = [{ year: 2000, stocks: 0.05, bonds: 0.05, bills: 0.05, inflation: 0 }];

const person = (over: Partial<SimPerson> = {}): SimPerson => ({
  id: 1,
  birthYear: 1959, // 67 in 2026
  retirementAge: 60,
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
    endYear: 2040,
    people: [person()],
    balances: { taxable: dollars(1_000_000), taxableBasis: dollars(1_000_000), roth: 0, hsa: 0, traditional: {} },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(15).fill(dollars(60_000)),
    taxes: { ordinaryPct: 0, capitalGainsPct: 0 },
    history: flat,
    rmd: RMD,
    runs: 2,
    blockLength: 5,
    seed: 2,
    ...over,
  };
}
const after1 = (over: Partial<SimInput>) => simulate(plan(over)).bands[0]!.p50;

describe("spousal Social Security benefits", () => {
  const earner = person({ id: 1, socialSecurity: dollars(3_000), pia: dollars(3_000) });

  it("give a spouse with no record of their own half of the other's benefit", () => {
    const people = [earner, person({ id: 2, birthYear: 1959 })];
    const without = after1({ people });
    const withSpousal = after1({ people, spousalBenefits: true });
    // $1,500 a month more income, a year of 5% growth.
    expect(withSpousal - without).toBeCloseTo(dollars(18_000) * 1.05, -2);
  });

  it("top up a smaller own benefit to half the other's, not add half on top", () => {
    const people = [earner, person({ id: 2, socialSecurity: dollars(1_000), pia: dollars(1_000) })];
    const diff = after1({ people, spousalBenefits: true }) - after1({ people });
    expect(diff).toBeCloseTo(dollars(500 * 12) * 1.05, -2);
    // A benefit already above half gets nothing.
    const bigger = [earner, person({ id: 2, socialSecurity: dollars(2_000), pia: dollars(2_000) })];
    expect(after1({ people: bigger, spousalBenefits: true })).toBe(after1({ people: bigger }));
  });

  it("are cut by 35% when taken five years before full retirement age, and need the other to have claimed", () => {
    const early = person({ id: 2, birthYear: 1964, claimAge: 62, fra: 67 }); // 62 in 2026
    const people = [earner, early];
    expect(after1({ people, spousalBenefits: true }) - after1({ people })).toBeCloseTo(dollars(1_500 * 12) * 0.65 * 1.05, -2);
    // The other has not claimed yet, so nothing is paid.
    const waiting = [{ ...earner, claimAge: 70 }, early];
    expect(after1({ people: waiting, spousalBenefits: true })).toBe(after1({ people: waiting }));
  });

  it("are off unless it is a married couple", () => {
    const people = [earner, person({ id: 2 })];
    expect(after1({ people })).toBe(after1({ people, spousalBenefits: false }));
  });
});

describe("a Social Security shortfall", () => {
  it("cuts every benefit by the unpayable share from the start year", () => {
    const people = [person({ socialSecurity: dollars(3_000), pia: dollars(3_000) })];
    const full = simulate(plan({ people }));
    const cut = simulate(plan({ people, ssShortfall: { startYear: 2030, payablePct: 78 } }));
    // Nothing changes before the start year.
    expect(cut.bands[3]!.p50).toBe(full.bands[3]!.p50);
    // In 2030 and later 22% of $36,000 less comes in each year.
    const lost = (full.bands[5]!.p50 - cut.bands[5]!.p50) / dollars(36_000 * 0.22);
    expect(lost).toBeGreaterThan(2);
    expect(lost).toBeLessThan(2.5);
  });

  it("lowers the chance the money lasts for someone who depends on benefits", () => {
    const people = [person({ socialSecurity: dollars(3_000), pia: dollars(3_000) })];
    const modest = { balances: { taxable: dollars(300_000), taxableBasis: dollars(300_000), roth: 0, hsa: 0, traditional: {} }, spending: Array(15).fill(dollars(50_000)), endYear: 2040, people };
    const base = simulate(plan(modest)).successRate;
    const cut = simulate(plan({ ...modest, ssShortfall: { startYear: 2027, payablePct: 70 } })).successRate;
    expect(cut).toBeLessThanOrEqual(base);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { payrollTax, simulate, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import type { RmdTable } from "./rules.ts";
import type { TaxTable } from "./tax.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../data/${path}`, import.meta.url), "utf8"));
const RMD = read("rmd/uniform-lifetime.json") as RmdTable;
const TABLE = read("tax/2026.json") as TaxTable;
const dollars = (d: number) => d * 100;
const flat: HistoricalYear[] = [{ year: 2000, stocks: 0.05, bonds: 0.05, bills: 0.05, inflation: 0 }];

const person = (over: Partial<SimPerson> = {}): SimPerson => ({
  id: 1,
  birthYear: 1966,
  retirementAge: 60,
  income: dollars(100_000),
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
    endYear: 2045,
    // The first has already stopped working; the second works until 65 (2036).
    people: [person({ id: 1 }), person({ id: 2, birthYear: 1971, retirementAge: 65 })],
    balances: { taxable: dollars(1_000_000), taxableBasis: dollars(1_000_000), roth: 0, hsa: 0, traditional: {} },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(20).fill(dollars(80_000)),
    taxes: { ordinaryPct: 0, capitalGainsPct: 0 },
    history: flat,
    rmd: RMD,
    runs: 2,
    blockLength: 5,
    seed: 4,
    ...over,
  };
}
const year0 = (over: Partial<SimInput>) => simulate(plan(over)).bands[0]!.p50;

describe("pay while one of two has retired", () => {
  it("covers spending, saves the rest and is net of payroll tax", () => {
    // $100,000 of pay less 7.65% payroll tax is $92,350 against $80,000 of spending: $12,350 saved.
    expect(year0({})).toBeCloseTo(dollars(1_000_000 + 12_350) * 1.05, -2);
  });

  it("draws on savings for the part of spending the pay does not cover", () => {
    expect(year0({ spending: Array(20).fill(dollars(150_000)) })).toBeCloseTo(dollars(1_000_000 - 57_650) * 1.05, -2);
  });

  it("drops the plan's spare-money savings once an earner has retired, but keeps them while both work", () => {
    const extra = { taxable: dollars(20_000), roth: 0, hsa: 0, traditional: {} };
    expect(year0({ extraSavings: extra })).toBe(year0({}));
    // With both still working, the savings go in.
    const bothWorking = [person({ id: 1, retirementAge: 65 }), person({ id: 2, birthYear: 1971, retirementAge: 65 })];
    expect(year0({ people: bothWorking, extraSavings: extra }) - year0({ people: bothWorking })).toBeCloseTo(dollars(20_000) * 1.05, -2);
  });

  it("stops being counted as pay once the second has retired", () => {
    const r = simulate(plan({ spending: Array(20).fill(dollars(150_000)) }));
    // Until 2035 the pay covers part of spending; from 2036 all $150,000 is drawn, so the yearly drop gets much bigger.
    const dropBefore = r.bands[8]!.p50 - r.bands[9]!.p50;
    const dropAfter = r.bands[11]!.p50 - r.bands[12]!.p50;
    expect(dropAfter - dropBefore).toBeGreaterThan(dollars(50_000));
  });

  it("puts a worse picture on the plan than assuming pay covers everything", () => {
    // Same plan but spending is high and the pay is lower: ending money drops.
    const lowPay = [person({ id: 1 }), person({ id: 2, birthYear: 1971, retirementAge: 65, income: dollars(40_000) })];
    const high = simulate(plan({ people: lowPay, spending: Array(20).fill(dollars(120_000)) })).bands.at(-1)!.p50;
    const flatPay = simulate(plan({ spending: Array(20).fill(dollars(120_000)) })).bands.at(-1)!.p50;
    expect(high).toBeLessThan(flatPay);
  });

  it("charges Social Security tax only up to the wage base", () => {
    const input = plan({ taxes: { ordinaryPct: 0, capitalGainsPct: 0, brackets: { table: TABLE, filing: "married_joint", statePct: 0 } } });
    expect(payrollTax(dollars(100_000), input)).toBeCloseTo(dollars(7_650), 0);
    // $300,000: 6.2% of $184,500 plus 1.45% of everything.
    expect(payrollTax(dollars(300_000), input)).toBeCloseTo(dollars(0.062 * 184_500 + 0.0145 * 300_000), 0);
  });
});

describe("long-term care", () => {
  const base = (over: Partial<SimInput> = {}) =>
    plan({ people: [person({ id: 1, birthYear: 1946, retirementAge: 65 })], endYear: 2035, spending: Array(10).fill(dollars(40_000)), runs: 200, ...over });
  const care = (over: Partial<NonNullable<SimInput["longTermCare"]>> = {}) => ({ probability: 1, meanYears: 1, annualCost: dollars(100_000), extraGrowthPct: 0, ...over });

  it("adds a year of cost at the end of the horizon for someone who needs it", () => {
    const withCare = simulate(base({ longTermCare: care() }));
    const none = simulate(base());
    expect(withCare.longTermCare!.share).toBe(1);
    expect(none.longTermCare).toBeNull();
    expect(withCare.bands[8]!.p50).toBe(none.bands[8]!.p50);
    expect(none.bands[9]!.p50 - withCare.bands[9]!.p50).toBeCloseTo(dollars(100_000) * 1.05, -2);
  });

  it("happens in about the stated share of futures and costs nothing when it does not", () => {
    const some = simulate(base({ longTermCare: care({ probability: 0.4 }) }));
    expect(some.longTermCare!.share).toBeGreaterThan(0.3);
    expect(some.longTermCare!.share).toBeLessThan(0.5);
    expect(simulate(base({ longTermCare: care({ probability: 0 }) })).bands[9]!.p50).toBe(simulate(base()).bands[9]!.p50);
  });

  it("costs more as it grows faster than inflation, and lowers the chance of lasting", () => {
    const grow = (g: number) => simulate(base({ longTermCare: care({ extraGrowthPct: g }) })).bands[9]!.p50;
    expect(grow(5)).toBeLessThan(grow(0));
    const tight = (c?: SimInput["longTermCare"]) =>
      simulate(base({ balances: { taxable: dollars(200_000), taxableBasis: dollars(200_000), roth: 0, hsa: 0, traditional: {} }, ...(c ? { longTermCare: c } : {}) })).successRate;
    expect(tight(care({ meanYears: 4 }))).toBeLessThanOrEqual(tight());
  });

  it("follows the person's death when lifespans are drawn", () => {
    const mortality = { mode: 87, dispersion: 10, maxAge: 110, survivorSpendingPct: 75 };
    const r = simulate(base({ mortality, endYear: 2060, spending: Array(35).fill(dollars(40_000)), longTermCare: care({ probability: 0.5, meanYears: 3 }) }), { bands: false });
    expect(r.longTermCare!.share).toBeGreaterThan(0.4);
    expect(r.longTermCare!.share).toBeLessThan(0.6);
  });
});

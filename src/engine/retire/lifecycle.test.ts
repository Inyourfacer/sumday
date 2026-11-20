import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MORTALITY, deathAge, survival } from "./longevity.ts";
import { simulate, type HistoricalYear, type SimInput, type SimPerson } from "./montecarlo.ts";
import { seededRandom, type RmdTable } from "./rules.ts";
import { bracketTop, irmaaSurcharge, ordinaryTaxableIncome, type TaxSetup, type TaxTable } from "./tax.ts";

const RMD = JSON.parse(readFileSync(new URL("../../../data/rmd/uniform-lifetime.json", import.meta.url), "utf8")) as RmdTable;
const HISTORY = (JSON.parse(readFileSync(new URL("../../../data/returns/us-annual.json", import.meta.url), "utf8")) as { years: HistoricalYear[] }).years;
const TABLE = JSON.parse(readFileSync(new URL("../../../data/tax/2026.json", import.meta.url), "utf8")) as TaxTable;
const cents = (d: number) => d * 100;
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

function plan(over: Partial<SimInput> = {}): SimInput {
  const endYear = over.endYear ?? 2066;
  return {
    startYear: 2026,
    endYear,
    people: [person()],
    balances: { taxable: cents(1_000_000), taxableBasis: cents(1_000_000), roth: 0, hsa: 0, traditional: {} },
    allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
    feePct: 0,
    extraSavings: { taxable: 0, roth: 0, hsa: 0, traditional: {} },
    spending: Array(endYear - 2026 + 1).fill(cents(90_000)),
    taxes: { ordinaryPct: 15, capitalGainsPct: 15 },
    history: flat,
    rmd: RMD,
    runs: 400,
    blockLength: 5,
    seed: 7,
    ...over,
  };
}

describe("lifespans", () => {
  it("survival falls with age and is certain over no time", () => {
    const m = DEFAULT_MORTALITY;
    expect(survival(65, 65, m)).toBe(1);
    expect(survival(65, 80, m)).toBeGreaterThan(survival(65, 90, m));
    expect(survival(65, 90, m)).toBeGreaterThan(survival(65, 100, m));
    expect(survival(65, 110, m)).toBeLessThan(0.02);
  });

  it("draws ages that match the curve and never exceed the cap", () => {
    const rand = seededRandom(3);
    const ages = Array.from({ length: 4000 }, () => deathAge(65, rand(), DEFAULT_MORTALITY)).sort((a, b) => a - b);
    const median = ages[2000]!;
    expect(median).toBeGreaterThan(82);
    expect(median).toBeLessThan(90);
    expect(ages.at(-1)!).toBeLessThanOrEqual(DEFAULT_MORTALITY.maxAge);
    expect(ages[0]!).toBeGreaterThanOrEqual(65);
    // The draws agree with the survival function: about half live past the median.
    expect(survival(65, median, DEFAULT_MORTALITY)).toBeCloseTo(0.5, 1);
  });

  it("lets money that would not last to 110 last for a realistic lifetime", () => {
    // $1M, $90k a year: gone in about 17 years. Fixed to age 110 always fails; real lifespans sometimes end sooner.
    const fixed = simulate(plan(), { bands: false });
    const modeled = simulate(plan({ mortality: DEFAULT_MORTALITY }), { bands: false });
    expect(fixed.successRate).toBe(0);
    expect(modeled.successRate).toBeGreaterThan(0.2);
    expect(modeled.successRate).toBeLessThan(1);
    expect(modeled.medianLastDeathYear!).toBeGreaterThan(2040);
  });

  it("is repeatable and gives the same draws to compared plans", () => {
    const a = simulate(plan({ mortality: DEFAULT_MORTALITY }), { bands: false });
    const b = simulate(plan({ mortality: DEFAULT_MORTALITY }), { bands: false });
    expect(b.successRate).toBe(a.successRate);
    expect(b.medianLastDeathYear).toBe(a.medianLastDeathYear);
  });

  it("spends less after the first death of two", () => {
    const couple = [person({ id: 1 }), person({ id: 2, birthYear: 1958 })];
    const run = (survivorSpendingPct: number) =>
      simulate(plan({ people: couple, mortality: { ...DEFAULT_MORTALITY, survivorSpendingPct }, balances: { taxable: cents(1_300_000), taxableBasis: cents(1_300_000), roth: 0, hsa: 0, traditional: {} } }), { bands: false }).successRate;
    expect(run(60)).toBeGreaterThan(run(100));
  });

  it("limits the bands to the planning age", () => {
    const r = simulate(plan({ mortality: DEFAULT_MORTALITY, displayEndYear: 2051 }));
    expect(r.bands.at(-1)!.year).toBe(2051);
  });
});

describe("spending guardrails", () => {
  const stressed = (over: Partial<SimInput> = {}) =>
    plan({ history: HISTORY, runs: 800, endYear: 2055, spending: Array(30).fill(cents(52_000)), balances: { taxable: cents(1_000_000), taxableBasis: cents(1_000_000), roth: 0, hsa: 0, traditional: {} }, ...over });
  const guardrails = { upperPct: 20, lowerPct: 20, adjustPct: 10, floorPct: 70 };

  it("raise the chance the money lasts by cutting spending in bad years", () => {
    const without = simulate(stressed(), { bands: false });
    const withRails = simulate(stressed({ guardrails }), { bands: false });
    expect(without.guardrails).toBeNull();
    expect(withRails.successRate).toBeGreaterThan(without.successRate);
    expect(withRails.guardrails!.cutShare).toBeGreaterThan(0);
    expect(withRails.guardrails!.medianLowestPct!).toBeGreaterThanOrEqual(70);
    expect(withRails.guardrails!.medianLowestPct!).toBeLessThan(100);
  });

  it("never cut below the floor", () => {
    const r = simulate(stressed({ guardrails: { ...guardrails, floorPct: 90 } }), { bands: false });
    expect(r.guardrails!.medianLowestPct!).toBeGreaterThanOrEqual(90);
  });

  it("leave steady returns alone", () => {
    const r = simulate(plan({ endYear: 2055, spending: Array(30).fill(cents(40_000)), guardrails }), { bands: false });
    expect(r.guardrails!.cutShare).toBe(0);
    expect(r.successRate).toBe(1);
  });
});

describe("Roth conversions", () => {
  const setup: TaxSetup = { table: TABLE, filing: "married_joint", statePct: 0 };
  const taxes = { ordinaryPct: 15, capitalGainsPct: 15, brackets: setup };

  it("finds the top of a bracket and the room left in it", () => {
    expect(bracketTop(setup, 12)).toBe(10_080_000);
    expect(bracketTop(setup, 37)).toBe(Infinity);
    expect(bracketTop(setup, 13)).toBeNull();
    const { taxableOrdinary } = ordinaryTaxableIncome({ ordinary: cents(100_000), socialSecurity: 0, gains: 0 }, setup);
    expect(taxableOrdinary).toBe(cents(100_000) - TABLE.filing.married_joint.standardDeduction);
  });

  it("converts up to the top of the chosen bracket and no further", () => {
    // One year, nothing else: income that fills the 12% bracket is the top edge plus the standard deduction.
    const input = plan({
      endYear: 2026,
      spending: [0],
      taxes,
      balances: { taxable: cents(500_000), taxableBasis: cents(500_000), roth: 0, hsa: 0, traditional: { 1: cents(900_000) } },
      conversion: { targetRatePct: 12, startYear: 2026, endYear: 2026 },
      runs: 5,
    });
    const r = simulate(input);
    const expected = 10_080_000 + TABLE.filing.married_joint.standardDeduction;
    expect(r.medianConverted!).toBeGreaterThan(expected - 5_000);
    expect(r.medianConverted!).toBeLessThanOrEqual(expected + 1);
    // Tax on it is 10% and 12% of the bracket: $2,480 + 12% of $76,000 = $11,600.
    expect(r.medianLifetimeTax!).toBeCloseTo(cents(11_600), -2);
  });

  it("converts more under a higher bracket and nothing when off", () => {
    const base = (rate: number | null) =>
      simulate(
        plan({
          people: [person({ birthYear: 1961 })],
          endYear: 2055,
          spending: Array(30).fill(cents(50_000)),
          taxes,
          history: HISTORY,
          runs: 200,
          balances: { taxable: cents(400_000), taxableBasis: cents(300_000), roth: 0, hsa: 0, traditional: { 1: cents(1_500_000) } },
          ...(rate === null ? {} : { conversion: { targetRatePct: rate, startYear: 2026, endYear: 2035 } }),
        }),
        { bands: false },
      );
    expect(base(null).medianConverted).toBeNull();
    expect(base(22).medianConverted!).toBeGreaterThan(base(12).medianConverted!);
    expect(base(12).medianConverted!).toBeGreaterThan(0);
  });

  it("cuts the taxes owed on required minimums in later years", () => {
    const run = (conversion?: SimInput["conversion"]) =>
      simulate(
        plan({
          people: [person({ birthYear: 1961, rmdStartAge: 75 })],
          endYear: 2060,
          spending: Array(35).fill(cents(60_000)),
          taxes,
          history: HISTORY,
          runs: 300,
          balances: { taxable: cents(300_000), taxableBasis: cents(300_000), roth: 0, hsa: 0, traditional: { 1: cents(2_000_000) } },
          ...(conversion ? { conversion } : {}),
        }),
        { bands: false },
      );
    const off = run();
    const on = run({ targetRatePct: 22, startYear: 2026, endYear: 2035 });
    expect(on.medianConverted!).toBeGreaterThan(cents(300_000));
    expect(on.medianLifetimeTax!).toBeLessThan(off.medianLifetimeTax!);
  });
});

describe("Medicare surcharges", () => {
  it("looks up the surcharge for an income", () => {
    const irmaa = TABLE.irmaa!;
    expect(irmaaSurcharge(cents(100_000), "single", irmaa)).toBe(0);
    expect(irmaaSurcharge(cents(110_000), "single", irmaa)).toBeGreaterThan(0);
    expect(irmaaSurcharge(cents(1_000_000), "single", irmaa)).toBe(irmaa.tiers.single!.at(-1)![1]);
    expect(irmaaSurcharge(cents(200_000), "married_joint", irmaa)).toBe(0);
    expect(irmaaSurcharge(cents(300_000), "married_joint", irmaa)).toBeGreaterThan(irmaaSurcharge(cents(230_000), "married_joint", irmaa));
  });

  it("charges high-income retirees on Medicare and leaves others alone", () => {
    const setup: TaxSetup = { table: TABLE, filing: "single", statePct: 0 };
    const base = (spend: number, medicare: boolean) =>
      simulate(
        plan({
          endYear: 2050,
          spending: Array(25).fill(cents(spend)),
          taxes: { ordinaryPct: 15, capitalGainsPct: 15, brackets: setup },
          history: HISTORY,
          runs: 200,
          balances: { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: { 1: cents(4_000_000) } },
          medicare,
        }),
        { bands: false },
      );
    const rich = base(150_000, true);
    expect(rich.medianMedicareSurcharge!).toBeGreaterThan(0);
    expect(base(150_000, false).medianMedicareSurcharge).toBeNull();
    const modest = simulate(
      plan({
        endYear: 2050,
        spending: Array(25).fill(cents(35_000)),
        taxes: { ordinaryPct: 15, capitalGainsPct: 15, brackets: setup },
        history: HISTORY,
        runs: 200,
        balances: { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: { 1: cents(500_000) } },
        medicare: true,
      }),
      { bands: false },
    );
    expect(modest.medianMedicareSurcharge!).toBe(0);
    // The surcharge is real money: it never helps.
    expect(rich.successRate).toBeLessThanOrEqual(base(150_000, false).successRate);
  });
});

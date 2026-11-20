import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { incomeTax, ordinaryTaxableIncome, taxableSocialSecurity, totalDeduction, type TaxSetup, type TaxTable } from "./tax.ts";

const TABLE = JSON.parse(readFileSync(new URL("../../../data/tax/2026.json", import.meta.url), "utf8")) as TaxTable;
const mfj: TaxSetup = { table: TABLE, filing: "married_joint", statePct: 0 };
const single: TaxSetup = { table: TABLE, filing: "single", statePct: 0 };
const dollars = (d: number) => d * 100;

describe("data file", () => {
  it("has a complete, increasing table for every filing status", () => {
    for (const status of ["single", "married_joint", "married_separate", "head_of_household"] as const) {
      const f = TABLE.filing[status];
      expect(f.standardDeduction).toBeGreaterThan(0);
      expect(f.ordinary.map((r) => r[1])).toEqual([10, 12, 22, 24, 32, 35, 37]);
      expect(f.ordinary.at(-1)![0]).toBeNull();
      const edges = f.ordinary.slice(0, -1).map((r) => r[0]!);
      expect([...edges].sort((a, b) => a - b)).toEqual(edges);
      expect(f.ltcg.map((r) => r[1])).toEqual([0, 15, 20]);
      expect(TABLE.ssThresholds[status]).toHaveLength(2);
    }
  });
});

describe("data file details", () => {
  it("keeps separate filers at half the joint top brackets and increasing Medicare tiers", () => {
    expect(TABLE.filing.married_separate.ordinary[5]![0]).toBe(TABLE.filing.married_joint.ordinary[5]![0]! / 2);
    expect(TABLE.filing.married_separate.ltcg[1]![0]).toBe(30_685_000);
    for (const rows of Object.values(TABLE.irmaa!.tiers)) {
      const edges = rows!.slice(0, -1).map((r) => r[0]!);
      expect([...edges].sort((x, y) => x - y)).toEqual(edges);
      const extras = rows!.map((r) => r[1]);
      expect([...extras].sort((x, y) => x - y)).toEqual(extras);
      expect(rows!.at(-1)![0]).toBeNull();
    }
    expect(TABLE.irmaa!.lookbackYears).toBe(2);
  });
});

describe("federal income tax", () => {
  it("applies the standard deduction and the bands", () => {
    expect(incomeTax({ ordinary: 0, socialSecurity: 0, gains: 0 }, mfj).total).toBe(0);
    // $100,000 ordinary, married: taxable $67,800 = 10% of $24,800 + 12% of $43,000.
    expect(incomeTax({ ordinary: dollars(100_000), socialSecurity: 0, gains: 0 }, mfj).federal).toBeCloseTo(dollars(2_480 + 5_160), 0);
    // Same income, single: taxable $83,900 = 1,240 + 12% of 38,000 + 22% of 33,500.
    expect(incomeTax({ ordinary: dollars(100_000), socialSecurity: 0, gains: 0 }, single).federal).toBeCloseTo(dollars(1_240 + 4_560 + 7_370), 0);
  });

  it("taxes gains at 0% while taxable income is low, then 15% above the line", () => {
    // $50,000 of gains and nothing else: all under the deduction and the 0% band.
    expect(incomeTax({ ordinary: 0, socialSecurity: 0, gains: dollars(50_000) }, mfj).federal).toBe(0);
    // $150,000 of gains, married: taxable $117,800; the first $98,900 is 0%, the rest 15%.
    expect(incomeTax({ ordinary: 0, socialSecurity: 0, gains: dollars(150_000) }, mfj).federal).toBeCloseTo(dollars(0.15 * (117_800 - 98_900)), 0);
    // Gains stack on ordinary income: $80,000 ordinary (taxable $47,800) plus $60,000 gains straddles the line.
    const stacked = incomeTax({ ordinary: dollars(80_000), socialSecurity: 0, gains: dollars(60_000) }, mfj).federal;
    const ordinaryOnly = incomeTax({ ordinary: dollars(80_000), socialSecurity: 0, gains: 0 }, mfj).federal;
    // Gains fill $47,800 to $107,800, of which $98,900 − $47,800 is 0% and the rest 15%.
    expect(stacked - ordinaryOnly).toBeCloseTo(dollars(0.15 * (107_800 - 98_900)), 0);
  });

  it("adds a flat state tax on ordinary income and gains", () => {
    const r = incomeTax({ ordinary: dollars(100_000), socialSecurity: dollars(30_000), gains: dollars(10_000) }, { ...mfj, statePct: 5 });
    expect(r.state).toBeCloseTo(dollars(5_500), 0);
    expect(r.total).toBeCloseTo(r.federal + r.state, 6);
  });

  it("never lets a bigger income reduce what is kept", () => {
    let prevNet = -Infinity;
    for (let income = 0; income <= dollars(400_000); income += dollars(2_500)) {
      const net = income + dollars(30_000) - incomeTax({ ordinary: income, socialSecurity: dollars(30_000), gains: dollars(20_000) }, mfj).total;
      expect(net).toBeGreaterThanOrEqual(prevNet);
      prevNet = net;
    }
  });
});

describe("Social Security taxation", () => {
  const t: [number, number] = [dollars(32_000), dollars(44_000)];
  it("is untaxed with low other income", () => {
    expect(taxableSocialSecurity(dollars(10_000), dollars(30_000), t)).toBe(0);
    expect(taxableSocialSecurity(dollars(10_000), 0, t)).toBe(0);
  });
  it("taxes half of the excess between the thresholds, then up to 85%", () => {
    // Other $40k + half of $30k = $55k provisional, over the $44k line:
    // 85% of $11k + the smaller of $15k and $6k = $9,350 + $6,000.
    expect(taxableSocialSecurity(dollars(40_000), dollars(30_000), t)).toBeCloseTo(dollars(15_350), 0);
    // $24k other + $15k = $39k, between the lines: half of the $7k excess.
    expect(taxableSocialSecurity(dollars(24_000), dollars(30_000), t)).toBeCloseTo(dollars(3_500), 0);
    // Capped at 85% of the benefit.
    expect(taxableSocialSecurity(dollars(500_000), dollars(30_000), t)).toBeCloseTo(dollars(25_500), 0);
  });
  it("taxes more of the benefit as inflation erodes the unindexed thresholds", () => {
    const base = incomeTax({ ordinary: dollars(20_000), socialSecurity: dollars(30_000), gains: 0 }, mfj, 1).taxableSocialSecurity;
    const later = incomeTax({ ordinary: dollars(20_000), socialSecurity: dollars(30_000), gains: 0 }, mfj, 2).taxableSocialSecurity;
    expect(later).toBeGreaterThan(base);
  });
});

describe("deductions for people 65 and older", () => {
  const single65: TaxSetup = { table: TABLE, filing: "single", statePct: 0, seniors: 1, year: 2026 };
  const joint65: TaxSetup = { table: TABLE, filing: "married_joint", statePct: 0, seniors: 2, year: 2026 };

  it("adds the extra standard deduction and the senior deduction", () => {
    // Single: $16,100 + $2,050 (unmarried) + $6,000.
    expect(totalDeduction(single65, dollars(50_000))).toBe(dollars(16_100 + 2_050 + 6_000));
    // Joint, both 65: $32,200 + 2 × $1,650 + $12,000.
    expect(totalDeduction(joint65, dollars(100_000))).toBe(dollars(32_200 + 3_300 + 12_000));
    // Nobody 65: the standard deduction alone.
    expect(totalDeduction({ ...single65, seniors: 0 }, dollars(50_000))).toBe(dollars(16_100));
  });

  it("phases the senior deduction out at 6% of income over $75,000 ($150,000 joint)", () => {
    expect(totalDeduction(single65, dollars(100_000))).toBe(dollars(16_100 + 2_050 + 6_000 - 1_500));
    expect(totalDeduction(single65, dollars(175_000))).toBe(dollars(16_100 + 2_050));
    expect(totalDeduction(single65, dollars(400_000))).toBe(dollars(16_100 + 2_050));
    expect(totalDeduction(joint65, dollars(200_000))).toBe(dollars(32_200 + 3_300 + 12_000 - 3_000));
    // The extra standard deduction does not phase out.
    expect(totalDeduction(joint65, dollars(900_000))).toBe(dollars(32_200 + 3_300));
  });

  it("applies the senior deduction only in 2025 through 2028, and never to separate filers", () => {
    expect(totalDeduction({ ...single65, year: 2028 }, 0)).toBe(dollars(24_150));
    expect(totalDeduction({ ...single65, year: 2029 }, 0)).toBe(dollars(16_100 + 2_050));
    expect(totalDeduction({ ...single65, year: 2024 }, 0)).toBe(dollars(16_100 + 2_050));
    expect(totalDeduction({ ...single65, year: undefined }, 0)).toBe(dollars(16_100 + 2_050));
    expect(totalDeduction({ ...single65, filing: "married_separate" }, 0)).toBe(dollars(16_100 + 1_650));
  });

  it("holds the senior deduction fixed in nominal dollars, so it shrinks in today's dollars", () => {
    // After prices double: $3,000 in today's dollars, and the phase-out starts at $37,500 of today's dollars.
    expect(totalDeduction(single65, dollars(30_000), 2)).toBe(dollars(16_100 + 2_050 + 3_000));
    expect(totalDeduction(single65, dollars(50_000), 2)).toBe(dollars(16_100 + 2_050 + 3_000 - 750));
  });

  it("lowers the tax", () => {
    const young = incomeTax({ ordinary: dollars(60_000), socialSecurity: 0, gains: 0 }, { ...single65, seniors: 0 }).federal;
    const old = incomeTax({ ordinary: dollars(60_000), socialSecurity: 0, gains: 0 }, single65).federal;
    // Taxable $35,850 against $43,900: 10% of $12,400 plus 12% of the rest.
    expect(old).toBeCloseTo(dollars(1_240 + 0.12 * (35_850 - 12_400)), 0);
    expect(young).toBeGreaterThan(old);
    expect(ordinaryTaxableIncome({ ordinary: dollars(60_000), socialSecurity: 0, gains: 0 }, single65).taxableOrdinary).toBe(dollars(35_850));
  });

  it("adds an extra 6% to the rate on income inside the phase-out", () => {
    const tax = (income: number) => incomeTax({ ordinary: dollars(income), socialSecurity: 0, gains: 0 }, single65).federal;
    // Single, $100,000 to $101,000: the 22% bracket, plus 6% × 22% from the shrinking deduction.
    expect((tax(101_000) - tax(100_000)) / dollars(1_000)).toBeCloseTo(0.22 * 1.06, 3);
    // Beyond the phase-out it is just the bracket.
    expect((tax(201_000) - tax(200_000)) / dollars(1_000)).toBeCloseTo(0.24, 3);
  });
});

import { describe, expect, it } from "vitest";
import { parseCsv } from "../import/csv.ts";
import { defaultMix, dominantClass, validateMix } from "./classify.ts";
import { allocation, drift, driftBand, fees, locationHints, rebalance, splitByMix, splitContribution, type Position } from "./portfolio.ts";
import { applyHoldingsMapping, cleanTicker, suggestHoldingsMapping } from "./positions.ts";
import { xirr } from "./xirr.ts";

describe("classification", () => {
  it("knows common funds and guesses from names", () => {
    expect(defaultMix("VTI", "")).toEqual({ mix: { us_stock: 1 }, source: "known" });
    expect(defaultMix("vxus", "")?.mix).toEqual({ intl_stock: 1 });
    expect(defaultMix(null, "Fidelity Government Money Market")).toEqual({ mix: { cash: 1 }, source: "guessed" });
    expect(defaultMix(null, "BlackRock U.S. Debt Index Fund - Aggregate Bond")?.mix).toEqual({ bonds: 1 });
    expect(defaultMix(null, "Vanguard Developed Markets Index")?.mix).toEqual({ intl_stock: 1 });
    expect(defaultMix(null, "State Street S&P 500 Index Non-Lending Fund")?.mix).toEqual({ us_stock: 1 });
    expect(defaultMix(null, "Stable Value Fund")?.mix).toEqual({ bonds: 1 });
    // Blended funds are left for the user.
    expect(defaultMix(null, "Vanguard Target Retirement 2055 Fund")).toBeUndefined();
    expect(defaultMix("XYZQ", "Mystery Holdings LLC")).toBeUndefined();
  });

  it("validates mixes and finds the dominant class", () => {
    expect(validateMix({ us_stock: 0.6, intl_stock: 0.4 })).toBeUndefined();
    expect(validateMix({ us_stock: 0.6 })).toMatch(/60%/);
    expect(validateMix({ crypto: 1 } as never)).toMatch(/Unknown/);
    expect(dominantClass({ us_stock: 0.95, cash: 0.05 })).toBe("us_stock");
    expect(dominantClass({ us_stock: 0.6, intl_stock: 0.4 })).toBeNull();
  });
});

const pos = (over: Partial<Position> & Pick<Position, "holdingId" | "value">): Position => ({
  accountId: 1,
  accountName: "Brokerage",
  ownerId: null,
  taxTreatment: "taxable",
  label: `H${over.holdingId}`,
  mix: { us_stock: 1 },
  costBasis: null,
  expenseRatio: null,
  ...over,
});

const TARGET = { us_stock: 0.6, intl_stock: 0.3, bonds: 0.1 };

describe("allocation and drift", () => {
  it("splits values by mix exactly", () => {
    expect(splitByMix(100_001, { us_stock: 0.6, intl_stock: 0.4 })).toMatchObject({ us_stock: 60_001, intl_stock: 40_000, bonds: 0 });
  });

  it("totals by class and keeps unclassified apart", () => {
    const a = allocation([
      pos({ holdingId: 1, value: 600_000 }),
      pos({ holdingId: 2, value: 200_000, mix: { intl_stock: 1 } }),
      pos({ holdingId: 3, value: 100_000, mix: null }),
    ]);
    expect(a).toMatchObject({ total: 900_000, classified: 800_000, unclassified: 100_000 });
    expect(a.byClass.us_stock).toBe(600_000);
  });

  it("uses a 5-point / 25% band, whichever is smaller", () => {
    expect(driftBand(0.6)).toBe(0.05);
    expect(driftBand(0.1)).toBeCloseTo(0.025);
    expect(driftBand(0)).toBe(0.01);
    const a = allocation([
      pos({ holdingId: 1, value: 700_000 }),
      pos({ holdingId: 2, value: 250_000, mix: { intl_stock: 1 } }),
      pos({ holdingId: 3, value: 50_000, mix: { bonds: 1 } }),
    ]);
    const d = drift(a, TARGET);
    expect(d.rows.map((r) => [r.assetClass, r.status])).toEqual([
      ["us_stock", "over"], // 70% vs 60% ± 5
      ["intl_stock", "in"], // 25% vs 30% ± 5
      ["bonds", "under"], // 5% vs 10% ± 2.5
    ]);
    expect(d.outOfBand).toBe(true);
  });
});

describe("next contribution", () => {
  it("fills shortfalls first, then follows the target", () => {
    const a = allocation([pos({ holdingId: 1, value: 700_000 }), pos({ holdingId: 2, value: 300_000, mix: { intl_stock: 1 } })]);
    // After $1,000: total $11,000 → targets 6,600 / 3,300 / 1,100. Short: intl 300, bonds 1,100 = 1,400 > 1,000 → proportional.
    expect(splitContribution(a, TARGET, 100_000)).toEqual([
      { assetClass: "intl_stock", amount: 21_429 },
      { assetClass: "bonds", amount: 78_571 },
    ]);
    // A bigger contribution covers the shortfalls and spreads the rest by target.
    const big = splitContribution(a, TARGET, 1_000_000);
    expect(big.reduce((s, x) => s + x.amount, 0)).toBe(1_000_000);
    expect(big.find((x) => x.assetClass === "us_stock")!.amount).toBeGreaterThan(0);
    expect(splitContribution(a, TARGET, 0)).toEqual([]);
  });
});

describe("rebalancing", () => {
  it("does nothing inside the band", () => {
    const plan = rebalance(
      [pos({ holdingId: 1, value: 600_000 }), pos({ holdingId: 2, value: 300_000, mix: { intl_stock: 1 } }), pos({ holdingId: 3, value: 100_000, mix: { bonds: 1 } })],
      TARGET,
    );
    expect(plan.needed).toBe(false);
  });

  it("trades in tax-advantaged accounts before selling anything taxable", () => {
    const positions = [
      pos({ holdingId: 1, value: 500_000, taxTreatment: "traditional", accountName: "401k" }),
      pos({ holdingId: 2, value: 300_000, costBasis: 100_000 }), // taxable US, big gain
      pos({ holdingId: 3, value: 200_000, mix: { intl_stock: 1 }, taxTreatment: "roth", accountName: "Roth" }),
    ];
    // Total $10,000: US 80% vs 60%, intl 20% vs 30%, bonds 0% vs 10%. Need: sell $2,000 US; buy $1,000 intl + $1,000 bonds.
    const plan = rebalance(positions, TARGET);
    expect(plan.needed).toBe(true);
    expect(plan.trades).toEqual([
      { where: "tax_advantaged", sell: "us_stock", buy: "intl_stock", amount: 100_000 },
      { where: "tax_advantaged", sell: "us_stock", buy: "bonds", amount: 100_000 },
    ]);
    expect(plan.taxableSales).toEqual([]);
    expect(plan.remaining).toEqual([]);
  });

  it("sells taxable holdings with losses first and estimates the gain", () => {
    const positions = [
      pos({ holdingId: 1, value: 400_000, costBasis: 200_000, label: "VTI" }),
      pos({ holdingId: 2, value: 400_000, costBasis: 500_000, label: "VOO" }),
      pos({ holdingId: 3, value: 200_000, mix: { intl_stock: 1 } }),
    ];
    const plan = rebalance(positions, TARGET);
    expect(plan.taxableSales).toEqual([{ holdingId: 2, label: "VOO", accountName: "Brokerage", amount: 200_000, estimatedGain: -50_000 }]);
    expect(plan.trades.every((t) => t.where === "taxable")).toBe(true);
  });
});

describe("location, fees", () => {
  it("suggests holding bonds in pre-tax accounts", () => {
    const hints = locationHints([
      pos({ holdingId: 1, value: 500_000, mix: { bonds: 1 } }),
      pos({ holdingId: 2, value: 800_000, taxTreatment: "traditional" }),
    ]);
    expect(hints).toEqual([expect.objectContaining({ kind: "bonds_in_taxable", amount: 500_000 })]);
    expect(locationHints([pos({ holdingId: 1, value: 500_000 })])).toEqual([]);
  });

  it("weights expense ratios and projects the drag", () => {
    const f = fees([
      pos({ holdingId: 1, value: 9_000_000, expenseRatio: 0.03 }),
      pos({ holdingId: 2, value: 1_000_000, expenseRatio: 0.75, label: "Active fund" }),
      pos({ holdingId: 3, value: 500_000 }),
    ]);
    expect(f.weighted).toBeCloseTo(0.102, 3);
    expect(f.knownValue).toBe(10_000_000);
    expect(f.unknownValue).toBe(500_000);
    expect(f.yearly).toBe(10_200);
    expect(f.drag30).toBeGreaterThan(f.drag10);
    expect(f.expensive.map((e) => e.label)).toEqual(["Active fund"]);
    expect(fees([]).weighted).toBeNull();
  });
});

describe("xirr", () => {
  it("finds the annual rate", () => {
    // $1,000 in, $1,100 out a year later → 10%.
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 1100 }])).toBeCloseTo(0.1, 4);
    // Contributions along the way.
    const r = xirr([
      { date: "2025-01-01", amount: -1000 },
      { date: "2025-07-01", amount: -1000 },
      { date: "2026-01-01", amount: 2150 },
    ]);
    expect(r).toBeGreaterThan(0.09);
    expect(r).toBeLessThan(0.11);
  });

  it("gives up on unusable input", () => {
    expect(xirr([{ date: "2025-01-01", amount: -1000 }])).toBeNull();
    expect(xirr([{ date: "2025-01-01", amount: 1000 }, { date: "2026-01-01", amount: 1100 }])).toBeNull();
    expect(xirr([{ date: "2026-01-01", amount: -1000 }, { date: "2026-01-10", amount: 1100 }])).toBeNull();
  });
});

const FIDELITY = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total
X123,Individual,SPAXX**,HELD IN MONEY MARKET,,,$1250.33,
X123,Individual,VTI,VANGUARD TOTAL STOCK MKT ETF,40.5,$376.92,"$15,265.26","$12,000.00"
X123,Individual,VXUS,VANGUARD TOTAL INTL STOCK ETF,100,$71.10,"$7,110.00",$6500.00
X123,Individual,Pending Activity,,,,$-20.00,
,,,,,,,
"The data and information in this spreadsheet is provided to you solely for your use..."
`;

describe("positions CSV", () => {
  it("maps a typical brokerage export", () => {
    const rows = parseCsv(FIDELITY);
    const { mapping, columns } = suggestHoldingsMapping(rows);
    expect(columns[2]).toBe("Symbol");
    expect(mapping).toEqual({ hasHeader: true, symbolColumn: 2, nameColumn: 3, quantityColumn: 4, priceColumn: 5, valueColumn: 6, costBasisColumn: 7 });
    const { positions, skipped } = applyHoldingsMapping(rows, mapping!);
    expect(positions).toEqual([
      { ticker: "SPAXX", name: "HELD IN MONEY MARKET", shares: 1250.33, price: 1, value: 125_033, costBasis: null, line: 2 },
      { ticker: "VTI", name: "VANGUARD TOTAL STOCK MKT ETF", shares: 40.5, price: 376.92, value: 1_526_526, costBasis: 1_200_000, line: 3 },
      { ticker: "VXUS", name: "VANGUARD TOTAL INTL STOCK ETF", shares: 100, price: 71.1, value: 711_000, costBasis: 650_000, line: 4 },
    ]);
    // Footer text and the "Pending Activity" line are ignored quietly.
    expect(skipped).toEqual([]);
  });

  it("handles 401(k) funds without tickers and works out a missing price", () => {
    const rows = parseCsv("Fund,Shares,Balance\nState Street S&P 500 Index Fund,1234.5678,$45678.90\nTotal,,$45678.90\n");
    const { mapping } = suggestHoldingsMapping(rows);
    expect(mapping).toBeUndefined(); // no Symbol column: user maps by hand
    const { positions } = applyHoldingsMapping(rows, { hasHeader: true, nameColumn: 0, quantityColumn: 1, valueColumn: 2 });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ ticker: null, name: "State Street S&P 500 Index Fund", shares: 1234.5678, value: 4_567_890 });
    expect(positions[0]!.price).toBeCloseTo(37.0, 1);
  });

  it("keeps funds whose names start with Total, and skips real total lines", () => {
    const rows = parseCsv("Symbol,Description,Quantity,Current Value\nFSKAX,TOTAL MARKET INDEX,10,$1500.00\nTotal,,,$1500.00\nAccount Total:,,,$1500.00\n");
    const { mapping } = suggestHoldingsMapping(rows);
    const { positions, skipped } = applyHoldingsMapping(rows, mapping!);
    expect(positions.map((p) => p.ticker)).toEqual(["FSKAX"]);
    expect(skipped).toEqual([]);
  });

  it("cleans tickers", () => {
    expect(cleanTicker("spaxx**")).toBe("SPAXX");
    expect(cleanTicker("BRK.B")).toBe("BRK.B");
    expect(cleanTicker("Pending Activity")).toBeNull();
    expect(cleanTicker("")).toBeNull();
  });
});

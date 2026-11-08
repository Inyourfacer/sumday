/**
 * Allocation, drift and rebalancing (DESIGN §10).
 *
 * - Allocation: each holding's value is split by its asset mix and summed.
 * - Drift: a class is out of band when it's off target by more than 5
 *   percentage points or 25% of its target, whichever is smaller (with a
 *   1-point floor so tiny cash balances don't nag).
 * - Rebalancing, cheapest first: steer new money to underweight classes;
 *   then trade inside tax-advantaged accounts (no tax); then, only if still
 *   needed, sell in taxable accounts, losses first.
 */
import { allocateCents, multiplyCents, type Cents } from "../money.ts";
import { ASSET_CLASSES, dominantClass, type AssetClass, type AssetMix } from "./classify.ts";

export type TaxTreatment = "taxable" | "traditional" | "roth" | "hsa";

export interface Position {
  holdingId: number;
  accountId: number;
  accountName: string;
  ownerId: number | null;
  taxTreatment: TaxTreatment;
  label: string;
  /** Market value, cents. */
  value: Cents;
  /** null = not classified yet. */
  mix: AssetMix | null;
  costBasis: Cents | null;
  /** Annual expense ratio in percent (0.03 = 0.03%). */
  expenseRatio: number | null;
}

export type Target = Partial<Record<AssetClass, number>>;
export type ClassAmounts = Record<AssetClass, Cents>;

function zero(): ClassAmounts {
  return { us_stock: 0, intl_stock: 0, bonds: 0, cash: 0, real_estate: 0, other: 0 };
}

/** Split a value across a mix exactly (parts add up to the value). */
export function splitByMix(value: Cents, mix: AssetMix): ClassAmounts {
  const out = zero();
  const parts = allocateCents(
    value,
    ASSET_CLASSES.map((c) => mix[c] ?? 0),
  );
  ASSET_CLASSES.forEach((c, i) => (out[c] = parts[i]!));
  return out;
}

export interface Allocation {
  total: Cents;
  classified: Cents;
  unclassified: Cents;
  byClass: ClassAmounts;
}

export function allocation(positions: readonly Position[]): Allocation {
  const byClass = zero();
  let unclassified = 0;
  let total = 0;
  for (const p of positions) {
    total += p.value;
    if (!p.mix) {
      unclassified += p.value;
      continue;
    }
    const split = splitByMix(p.value, p.mix);
    for (const c of ASSET_CLASSES) byClass[c] += split[c];
  }
  return { total, classified: total - unclassified, unclassified, byClass };
}

/** Allowed distance from target, as a fraction of the portfolio. */
export function driftBand(target: number): number {
  return Math.max(0.01, Math.min(0.05, 0.25 * target));
}

export interface DriftRow {
  assetClass: AssetClass;
  value: Cents;
  /** Fractions of the classified portfolio. */
  current: number;
  target: number;
  drift: number;
  band: number;
  status: "in" | "over" | "under";
}

export function drift(alloc: Allocation, target: Target): { rows: DriftRow[]; outOfBand: boolean } {
  const base = alloc.classified;
  const rows = ASSET_CLASSES.filter((c) => (target[c] ?? 0) > 0 || alloc.byClass[c] > 0).map((c) => {
    const current = base > 0 ? alloc.byClass[c] / base : 0;
    const t = target[c] ?? 0;
    const band = driftBand(t);
    const d = current - t;
    return { assetClass: c, value: alloc.byClass[c], current, target: t, drift: d, band, status: Math.abs(d) <= band ? "in" : d > 0 ? "over" : "under" } as DriftRow;
  });
  return { rows, outOfBand: rows.some((r) => r.status !== "in") };
}

/**
 * How to split a new contribution so the portfolio moves toward target:
 * fill each class's shortfall (measured after the contribution), in
 * proportion; if nothing is short, follow the target weights.
 */
export function splitContribution(alloc: Allocation, target: Target, amount: Cents): { assetClass: AssetClass; amount: Cents }[] {
  if (amount <= 0) return [];
  const after = alloc.classified + amount;
  const shortfall = ASSET_CLASSES.map((c) => Math.max(0, multiplyCents(after, target[c] ?? 0) - alloc.byClass[c]));
  const totalShort = shortfall.reduce((a, b) => a + b, 0);
  const weights = totalShort > 0 ? shortfall : ASSET_CLASSES.map((c) => target[c] ?? 0);
  if (weights.every((w) => w === 0)) return [];
  // Never send more to a class than its shortfall when there is one; the rest follows target weights.
  let parts: number[];
  if (totalShort > 0 && totalShort < amount) {
    const rest = allocateCents(
      amount - totalShort,
      ASSET_CLASSES.map((c) => target[c] ?? 0),
    );
    parts = shortfall.map((s, i) => s + rest[i]!);
  } else {
    parts = allocateCents(amount, weights);
  }
  return ASSET_CLASSES.map((c, i) => ({ assetClass: c, amount: parts[i]! })).filter((x) => x.amount > 0);
}

export interface Trade {
  where: "tax_advantaged" | "taxable";
  sell: AssetClass;
  buy: AssetClass;
  amount: Cents;
}

export interface TaxableSale {
  holdingId: number;
  label: string;
  accountName: string;
  amount: Cents;
  /** Estimated capital gain (negative = loss); null without a cost basis. */
  estimatedGain: Cents | null;
}

export interface RebalancePlan {
  needed: boolean;
  trades: Trade[];
  taxableSales: TaxableSale[];
  /** Amount per class still off target after the trades (when tax-advantaged room ran out and taxable wasn't enough). */
  remaining: { assetClass: AssetClass; amount: Cents }[];
}

/**
 * Trades that bring a drifted portfolio back to target. Tax-advantaged
 * accounts first; taxable sales only for what's left, cheapest tax first.
 */
export function rebalance(positions: readonly Position[], target: Target): RebalancePlan {
  const alloc = allocation(positions);
  const { outOfBand } = drift(alloc, target);
  if (!outOfBand) return { needed: false, trades: [], taxableSales: [], remaining: [] };

  const delta = new Map<AssetClass, number>(ASSET_CLASSES.map((c) => [c, multiplyCents(alloc.classified, target[c] ?? 0) - alloc.byClass[c]]));
  const sheltered = (p: Position) => p.taxTreatment !== "taxable";
  const shelteredByClass = allocation(positions.filter(sheltered)).byClass;
  const trades: Trade[] = [];

  const over = () => ASSET_CLASSES.filter((c) => delta.get(c)! < 0).sort((a, b) => delta.get(a)! - delta.get(b)!);
  const under = () => ASSET_CLASSES.filter((c) => delta.get(c)! > 0).sort((a, b) => delta.get(b)! - delta.get(a)!);

  // 1. Inside tax-advantaged accounts: selling there has no tax cost.
  for (const sell of over()) {
    for (const buy of under()) {
      const amount = Math.min(-delta.get(sell)!, delta.get(buy)!, shelteredByClass[sell]);
      if (amount <= 0) continue;
      trades.push({ where: "tax_advantaged", sell, buy, amount });
      delta.set(sell, delta.get(sell)! + amount);
      delta.set(buy, delta.get(buy)! - amount);
      shelteredByClass[sell] -= amount;
    }
  }

  // 2. Taxable: sell holdings of overweight classes, biggest losses / smallest gains first.
  const taxableSales: TaxableSale[] = [];
  const gainRatio = (p: Position) => (p.costBasis === null || p.value <= 0 ? 1 : (p.value - p.costBasis) / p.value);
  for (const sell of over()) {
    const candidates = positions
      .filter((p) => !sheltered(p) && dominantClass(p.mix) === sell && p.value > 0)
      .sort((a, b) => gainRatio(a) - gainRatio(b));
    for (const p of candidates) {
      const need = -delta.get(sell)!;
      if (need <= 0) break;
      const amount = Math.min(need, p.value);
      const buys = under();
      if (buys.length === 0) break;
      taxableSales.push({
        holdingId: p.holdingId,
        label: p.label,
        accountName: p.accountName,
        amount,
        estimatedGain: p.costBasis === null ? null : multiplyCents(amount, gainRatio(p)),
      });
      // Spread the proceeds over the underweight classes in order.
      let left = amount;
      for (const buy of buys) {
        const put = Math.min(left, delta.get(buy)!);
        if (put <= 0) continue;
        trades.push({ where: "taxable", sell, buy, amount: put });
        delta.set(buy, delta.get(buy)! - put);
        left -= put;
        if (left === 0) break;
      }
      delta.set(sell, delta.get(sell)! + amount - left);
    }
  }

  return {
    needed: true,
    trades: mergeTrades(trades),
    taxableSales,
    remaining: ASSET_CLASSES.map((c) => ({ assetClass: c, amount: delta.get(c)! })).filter((x) => Math.abs(x.amount) >= 100),
  };
}

function mergeTrades(trades: Trade[]): Trade[] {
  const merged = new Map<string, Trade>();
  for (const t of trades) {
    const key = `${t.where}|${t.sell}|${t.buy}`;
    const existing = merged.get(key);
    if (existing) existing.amount += t.amount;
    else merged.set(key, { ...t });
  }
  return [...merged.values()];
}

export interface LocationHint {
  kind: "bonds_in_taxable" | "bonds_in_roth";
  amount: Cents;
  message: string;
}

/**
 * Asset location: bonds are taxed as income every year, so they belong in
 * pre-tax accounts; Roth money grows tax-free, so it suits stocks.
 */
export function locationHints(positions: readonly Position[]): LocationHint[] {
  const by = (t: TaxTreatment) => allocation(positions.filter((p) => p.taxTreatment === t)).byClass;
  const taxable = by("taxable");
  const roth = by("roth");
  const traditional = by("traditional");
  const tradStocks = traditional.us_stock + traditional.intl_stock + traditional.real_estate;
  const hints: LocationHint[] = [];
  const min = 100_000;
  if (taxable.bonds >= min && tradStocks >= min) {
    const amount = Math.min(taxable.bonds, tradStocks);
    hints.push({
      kind: "bonds_in_taxable",
      amount,
      message: "Bonds in a taxable account pay tax on their interest every year. Holding bonds in pre-tax accounts and stocks in taxable keeps the same mix with less tax.",
    });
  }
  if (roth.bonds >= min && tradStocks >= min) {
    const amount = Math.min(roth.bonds, tradStocks);
    hints.push({
      kind: "bonds_in_roth",
      amount,
      message: "Roth money is never taxed again, so it's best used for what grows most (stocks). Consider holding bonds in pre-tax accounts instead.",
    });
  }
  return hints;
}

export interface FeeSummary {
  /** Value-weighted expense ratio (%) over holdings with a known ratio. */
  weighted: number | null;
  knownValue: Cents;
  unknownValue: Cents;
  /** Yearly cost at today's value. */
  yearly: Cents;
  /** Growth lost to fees over 10 and 30 years, assuming 6% a year before fees. */
  drag10: Cents;
  drag30: Cents;
  /** Holdings costing more than 0.5% a year. */
  expensive: { holdingId: number; label: string; accountName: string; expenseRatio: number; value: Cents }[];
}

export const FEE_GROWTH = 0.06;

export function fees(positions: readonly Position[]): FeeSummary {
  const known = positions.filter((p) => p.expenseRatio !== null && p.value > 0);
  const knownValue = known.reduce((s, p) => s + p.value, 0);
  const unknownValue = positions.filter((p) => p.expenseRatio === null).reduce((s, p) => s + p.value, 0);
  const weighted = knownValue > 0 ? known.reduce((s, p) => s + p.value * p.expenseRatio!, 0) / knownValue : null;
  const total = knownValue;
  const drag = (years: number) =>
    weighted === null ? 0 : Math.round(total * (1 + FEE_GROWTH) ** years - total * (1 + FEE_GROWTH - weighted / 100) ** years);
  return {
    weighted,
    knownValue,
    unknownValue,
    yearly: weighted === null ? 0 : Math.round((total * weighted) / 100),
    drag10: drag(10),
    drag30: drag(30),
    expensive: known
      .filter((p) => p.expenseRatio! > 0.5)
      .map((p) => ({ holdingId: p.holdingId, label: p.label, accountName: p.accountName, expenseRatio: p.expenseRatio!, value: p.value })),
  };
}

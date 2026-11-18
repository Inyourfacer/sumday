/**
 * Federal income tax for retirement withdrawals, from brackets (DESIGN §11).
 *
 * Replaces a flat rate with what the tax code does: a standard deduction, rising
 * ordinary brackets, 0/15/20% rates on long-term gains stacked on top of
 * ordinary income, and the partial taxation of Social Security. State tax is a
 * flat rate on income the user sets. Everything is in the simulation's
 * today's dollars: brackets and the deduction are indexed to inflation, so they
 * stay put; the Social Security thresholds are not indexed, so the caller
 * passes in how much inflation has eroded them.
 */
import type { FilingStatus } from "../plan/limits.ts";

/** [upper edge in cents or null for "and above", rate in percent] */
export type BracketRow = [number | null, number];

export interface FilingTable {
  standardDeduction: number;
  ordinary: BracketRow[];
  ltcg: BracketRow[];
}

export interface TaxTable {
  year: number;
  source: string;
  ssThresholds: Record<FilingStatus, [number, number]>;
  filing: Record<FilingStatus, FilingTable>;
}

/** Everything the tax depends on for one year, in today's dollars. */
export interface TaxableYear {
  /** Pre-tax withdrawals, required minimums, pensions: ordinary income other than Social Security. */
  ordinary: number;
  /** Social Security benefits received (before tax). */
  socialSecurity: number;
  /** Long-term capital gains realized. */
  gains: number;
}

export interface TaxSetup {
  table: TaxTable;
  filing: FilingStatus;
  /** Flat state income tax on ordinary income and gains, percent. */
  statePct: number;
}

/** The part of Social Security that is taxable, from "provisional income". */
export function taxableSocialSecurity(otherIncome: number, ss: number, [t1, t2]: [number, number]): number {
  if (ss <= 0) return 0;
  const provisional = otherIncome + ss / 2;
  if (provisional <= t1) return 0;
  const half = Math.min(ss / 2, (provisional - t1) / 2);
  if (provisional <= t2) return half;
  return Math.min(0.85 * ss, 0.85 * (provisional - t2) + Math.min(ss / 2, (t2 - t1) / 2));
}

/** Tax on `amount` of income, starting at `from`, using rows of [upper edge, rate]. */
function layered(rows: readonly BracketRow[], from: number, amount: number): number {
  let tax = 0;
  let lo = 0;
  const top = from + amount;
  for (const [edge, rate] of rows) {
    const hi = edge ?? Infinity;
    const slice = Math.min(top, hi) - Math.max(from, lo);
    if (slice > 0) tax += (slice * rate) / 100;
    lo = hi;
    if (hi >= top) break;
  }
  return tax;
}

export interface TaxResult {
  federal: number;
  state: number;
  total: number;
  /** Taxable Social Security, for checking. */
  taxableSocialSecurity: number;
}

/**
 * Tax for a year. `ssErosion` is cumulative inflation since today (1 = none):
 * the unindexed Social Security thresholds are divided by it.
 */
export function incomeTax(year: TaxableYear, setup: TaxSetup, ssErosion = 1): TaxResult {
  const f = setup.table.filing[setup.filing];
  const [t1, t2] = setup.table.ssThresholds[setup.filing];
  const ssTaxable = taxableSocialSecurity(year.ordinary + year.gains, year.socialSecurity, [t1 / ssErosion, t2 / ssErosion]);
  const ordinaryIncome = year.ordinary + ssTaxable;
  const taxableTotal = Math.max(0, ordinaryIncome + year.gains - f.standardDeduction);
  const taxableOrdinary = Math.max(0, ordinaryIncome - f.standardDeduction);
  const taxableGains = taxableTotal - taxableOrdinary;
  const federal = layered(f.ordinary, 0, taxableOrdinary) + layered(f.ltcg, taxableOrdinary, taxableGains);
  const state = (setup.statePct / 100) * Math.max(0, year.ordinary + year.gains);
  return { federal, state, total: federal + state, taxableSocialSecurity: ssTaxable };
}

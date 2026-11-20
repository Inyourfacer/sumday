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

/** Medicare income-related premium surcharges (IRMAA): per filing status, rows of [upper income edge or null, extra monthly Part B cents per person]. */
export interface IrmaaTable {
  year: number;
  source: string;
  /** Years between the income that counts and the premium it sets (2). */
  lookbackYears: number;
  tiers: Partial<Record<FilingStatus, [number | null, number][]>>;
}

export interface SeniorRules {
  source: string;
  /** Extra standard deduction per person aged 65 or more: for married filers, and for unmarried ones. */
  additionalStandardDeduction: { married: number; unmarried: number };
  /** A further deduction per person aged 65 or more for a few years, phased out over higher incomes. Nominal dollars, not indexed. */
  extraDeduction: { amount: number; phaseOutPct: number; phaseOutStart: Partial<Record<FilingStatus, number>>; firstYear: number; lastYear: number };
}

export interface TaxTable {
  year: number;
  source: string;
  seniors?: SeniorRules;
  irmaa?: IrmaaTable;
  /** Employee payroll tax: Social Security applies up to this yearly pay (cents). */
  payroll?: { socialSecurityWageBase: number; source: string };
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
  /** People on the return aged 65 or more by year end: each adds to the deduction. */
  seniors?: number;
  /** The calendar year, for deductions that expire (the extra senior deduction runs 2025 through 2028). */
  year?: number;
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

/**
 * Everything subtracted from income before the brackets: the standard deduction, the extra amount for each person 65 or
 * older, and, in the years it exists, the senior deduction, which shrinks as income (`magi`) passes its start. `erosion`
 * is cumulative inflation: the senior deduction and its thresholds are fixed in nominal dollars.
 */
export function totalDeduction(setup: TaxSetup, magi: number, erosion = 1): number {
  const f = setup.table.filing[setup.filing];
  const rules = setup.table.seniors;
  const seniors = setup.seniors ?? 0;
  if (!rules || seniors <= 0) return f.standardDeduction;
  const married = setup.filing === "married_joint" || setup.filing === "married_separate";
  let deduction = f.standardDeduction + seniors * (married ? rules.additionalStandardDeduction.married : rules.additionalStandardDeduction.unmarried);
  const extra = rules.extraDeduction;
  const start = setup.filing === "married_separate" ? undefined : extra.phaseOutStart[setup.filing];
  if (setup.year !== undefined && start !== undefined && setup.year >= extra.firstYear && setup.year <= extra.lastYear) {
    const reduction = Math.max(0, magi - start / erosion) * (extra.phaseOutPct / 100);
    deduction += Math.max(0, (seniors * extra.amount) / erosion - reduction);
  }
  return deduction;
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
  const deduction = totalDeduction(setup, ordinaryIncome + year.gains, ssErosion);
  const taxableTotal = Math.max(0, ordinaryIncome + year.gains - deduction);
  const taxableOrdinary = Math.max(0, ordinaryIncome - deduction);
  const taxableGains = taxableTotal - taxableOrdinary;
  const federal = layered(f.ordinary, 0, taxableOrdinary) + layered(f.ltcg, taxableOrdinary, taxableGains);
  const state = (setup.statePct / 100) * Math.max(0, year.ordinary + year.gains);
  return { federal, state, total: federal + state, taxableSocialSecurity: ssTaxable };
}

/**
 * Ordinary income that is left to tax after the standard deduction, and the
 * taxable part of Social Security. Used to see how much room is left in a bracket.
 */
export function ordinaryTaxableIncome(year: TaxableYear, setup: TaxSetup, ssErosion = 1): { taxableOrdinary: number; taxableSocialSecurity: number } {
  const [t1, t2] = setup.table.ssThresholds[setup.filing];
  const ssTaxable = taxableSocialSecurity(year.ordinary + year.gains, year.socialSecurity, [t1 / ssErosion, t2 / ssErosion]);
  const deduction = totalDeduction(setup, year.ordinary + ssTaxable + year.gains, ssErosion);
  return { taxableOrdinary: Math.max(0, year.ordinary + ssTaxable - deduction), taxableSocialSecurity: ssTaxable };
}

/**
 * Top of the ordinary bracket taxed at `ratePct`, in taxable income. Infinity
 * for the top bracket; null when the table has no such rate.
 */
export function bracketTop(setup: TaxSetup, ratePct: number): number | null {
  const row = setup.table.filing[setup.filing].ordinary.find((r) => r[1] === ratePct);
  return row ? (row[0] ?? Infinity) : null;
}

/** Extra Part B premium per person per month, in cents, for a given income (MAGI) two years back. */
export function irmaaSurcharge(magi: number, filing: FilingStatus, table: IrmaaTable): number {
  const rows = table.tiers[filing] ?? table.tiers.single ?? [];
  for (const [edge, extra] of rows) if (edge === null || magi <= edge) return extra;
  return 0;
}

/** Federal rate on the next dollar of ordinary income, given taxable income (after the standard deduction), in percent. */
export function marginalOrdinaryPct(table: TaxTable, filing: FilingStatus, taxableIncome: number): number {
  for (const [edge, rate] of table.filing[filing].ordinary) if (edge === null || taxableIncome < edge) return rate;
  return table.filing[filing].ordinary.at(-1)![1];
}

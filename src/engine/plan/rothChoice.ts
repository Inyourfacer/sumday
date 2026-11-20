/**
 * Roth or pre-tax? The tax rate on your next dollar now, against what an extra dollar of
 * pre-tax income is expected to cost in retirement (DESIGN §8). If the rate now is clearly higher,
 * the deduction now is worth more than tax-free withdrawals later, and the reverse if it is lower.
 * Close calls go either way: mixing both gives more control over taxable income in retirement.
 */
import type { Cents } from "../money.ts";
import type { ContributionLimits, FilingStatus } from "./limits.ts";

export type Lean = "traditional" | "roth" | "either";

export interface TaxView {
  /** Tax rate on the next dollar of income now, percent (federal plus state). Null when it can't be worked out. */
  nowPct: number | null;
  /** The rate you typed (`you`) or the one estimated from income (`income`). */
  nowBasis: "you" | "income" | null;
  /** Expected rate on an extra pre-tax dollar in retirement, percent: the median across simulated futures and its middle half. */
  retirementPct: number | null;
  retirementRange: [number, number] | null;
  lean: Lean | null;
}

/** Percentage points of difference before one side is preferred. */
export const LEAN_MARGIN = 3;

export function leanFor(nowPct: number | null, retirementPct: number | null, margin = LEAN_MARGIN): Lean | null {
  if (nowPct === null || retirementPct === null) return null;
  if (nowPct - retirementPct >= margin) return "traditional";
  if (retirementPct - nowPct >= margin) return "roth";
  return "either";
}

export type Deduction = "full" | "partial" | "none";

/**
 * Whether a traditional IRA contribution is deductible. Anyone covered by a workplace plan (or, for married filing
 * separately, whose spouse is) loses the deduction as income rises through a range; married-joint filers who are not
 * covered lose it only if their spouse is, and at a higher income. Without the ranges in the data, assume it is lost.
 */
export function iraDeductibility(
  limits: ContributionLimits,
  filing: FilingStatus,
  magi: Cents,
  covered: boolean,
  spouseCovered: boolean,
): Deduction {
  const rules = limits.traditionalIraDeduction;
  if (!rules) return "none";
  let range: [Cents, Cents] | null = null;
  if (covered || (filing === "married_separate" && spouseCovered)) range = rules.coveredByWorkplacePlan[filing];
  else if (filing === "married_joint" && spouseCovered) range = rules.spouseCoveredOnly;
  if (range === null) return "full";
  const [lo, hi] = range;
  return magi <= lo ? "full" : magi >= hi ? "none" : "partial";
}

/** Savings goals (DESIGN §6): progress and the monthly amount needed to hit the date. */
import { monthsBetween, type IsoDate } from "../dates.ts";
import type { Cents } from "../money.ts";

export type GoalStatus = "funded" | "in_progress" | "overdue" | "no_date";

export interface GoalProgress {
  saved: Cents;
  target: Cents;
  remaining: Cents;
  /** 0–1, capped at 1. */
  percent: number;
  /** Months left including this one; null without a date. */
  monthsLeft: number | null;
  /** Monthly amount needed to reach the target by the date; null without a date. */
  requiredMonthly: Cents | null;
  status: GoalStatus;
}

export function goalProgress(target: Cents, saved: Cents, targetDate: IsoDate | null, today: IsoDate): GoalProgress {
  const remaining = Math.max(0, target - saved);
  const percent = target > 0 ? Math.min(1, Math.max(0, saved / target)) : 1;
  if (remaining === 0) {
    return { saved, target, remaining, percent, monthsLeft: null, requiredMonthly: 0, status: "funded" };
  }
  if (targetDate === null) {
    return { saved, target, remaining, percent, monthsLeft: null, requiredMonthly: null, status: "no_date" };
  }
  if (targetDate < today) {
    // Past the date: everything that's left is due now.
    return { saved, target, remaining, percent, monthsLeft: 1, requiredMonthly: remaining, status: "overdue" };
  }
  // A goal due later this month counts this month; due next month gives two months, and so on.
  const monthsLeft = monthsBetween(today, targetDate) + 1;
  return { saved, target, remaining, percent, monthsLeft, requiredMonthly: Math.ceil(remaining / monthsLeft), status: "in_progress" };
}

/** Emergency fund target: months of essential spending. Two earners → 3 months; one → 6. */
export function emergencyMonthsDefault(earners: number): number {
  return earners >= 2 ? 3 : 6;
}

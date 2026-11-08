/**
 * Retirement spending, built from today's budget (DESIGN §11.1): each
 * category's yearly amount, adjusted for retirement, plus timed changes
 * ("travel +$6,000 until 75", "healthcare premium until 65") and one-off
 * costs ("a car every 8 years"). Everything is in today's dollars.
 */

export interface SpendingCategory {
  categoryId: number;
  name: string;
  /** What you spend now per year. */
  current: number;
  /** What it becomes in retirement; null = the same as now. */
  retirement: number | null;
}

export interface SpendingItem {
  label: string;
  /** Per year; negative for a reduction. */
  amount: number;
  /** Ages of the primary person, inclusive; null = no limit. */
  fromAge: number | null;
  toAge: number | null;
}

export interface OneOff {
  label: string;
  amount: number;
  age: number;
  /** Repeats every N years after that, if set. */
  everyYears: number | null;
}

export interface SpendingPlan {
  categories: SpendingCategory[];
  items: SpendingItem[];
  oneOffs: OneOff[];
}

export function baseRetirementSpending(categories: readonly SpendingCategory[]): number {
  return categories.reduce((s, c) => s + Math.max(0, c.retirement ?? c.current), 0);
}

/** Spending for the year the primary person turns `age`. */
export function spendingAtAge(plan: SpendingPlan, age: number): number {
  let total = baseRetirementSpending(plan.categories);
  for (const item of plan.items) {
    if ((item.fromAge === null || age >= item.fromAge) && (item.toAge === null || age <= item.toAge)) total += item.amount;
  }
  for (const o of plan.oneOffs) {
    if (age === o.age || (o.everyYears !== null && o.everyYears > 0 && age > o.age && (age - o.age) % o.everyYears === 0)) total += o.amount;
  }
  return Math.max(0, total);
}

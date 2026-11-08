/**
 * The monthly budget: Fixed / Flex / Non-monthly (DESIGN §5.1).
 *
 * - Fixed categories have an expected monthly amount.
 * - Non-monthly categories have a yearly amount; 1/12 is set aside each
 *   month into a virtual sinking fund, and spending draws it down.
 * - Flex is one pool: expected income − fixed − non-monthly set-aside −
 *   planned savings.
 *
 * Everything here is pure: the server passes in per-category, per-month
 * totals and gets back the numbers the Budget page shows.
 */
import { addMonths, daysInMonth, parseIsoDate, type IsoDate, type MonthKey } from "../dates.ts";
import { allocateCents, multiplyCents, type Cents } from "../money.ts";

export type BudgetType = "income" | "fixed" | "flex" | "non_monthly" | "transfer";

export interface BudgetCategory {
  id: number;
  name: string;
  group: string;
  budgetType: BudgetType;
  isEssential: boolean;
  /** Monthly for Fixed, yearly for Non-monthly, unused otherwise. null = not set. */
  budget: Cents | null;
  /** Non-monthly only: sinking fund balance at the start of the fund. */
  startingBalance: Cents;
}

/** Net posted amount (signed: spending is negative) by category id and month. */
export type MonthlyActuals = ReadonlyMap<number, ReadonlyMap<MonthKey, Cents>>;

export function monthOf(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function firstDay(month: MonthKey): IsoDate {
  return `${month}-01`;
}

export function nextMonth(month: MonthKey, n = 1): MonthKey {
  return monthOf(addMonths(firstDay(month), n));
}

/** Months from `from` to `to` inclusive. Empty if `to` is before `from`. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

function actual(actuals: MonthlyActuals, categoryId: number, month: MonthKey): Cents {
  return actuals.get(categoryId)?.get(month) ?? 0;
}

/** Flip a sign without producing -0. */
const neg = (c: Cents): Cents => (c === 0 ? 0 : -c);

/**
 * The part of a yearly amount set aside in a given month. The 12 months of a
 * calendar year add up exactly to the yearly amount (spare cents go to the
 * earliest months).
 */
export function monthlySetAside(annual: Cents, month: MonthKey): Cents {
  const index = parseIsoDate(firstDay(month)).month - 1;
  return allocateCents(annual, Array<number>(12).fill(1))[index]!;
}

/**
 * Sinking fund balance at the end of `month`: starting balance plus every
 * month's set-aside since the fund started, minus what was spent.
 */
export function sinkingFundBalance(
  category: Pick<BudgetCategory, "id" | "budget" | "startingBalance">,
  fundStart: MonthKey,
  month: MonthKey,
  actuals: MonthlyActuals,
): Cents {
  let balance = category.startingBalance;
  for (const m of monthRange(fundStart, month)) {
    balance += monthlySetAside(category.budget ?? 0, m) + actual(actuals, category.id, m);
  }
  return balance;
}

export type FixedStatus = "ok" | "over" | "under" | "upcoming" | "unbudgeted";

export interface BudgetMonthInput {
  month: MonthKey;
  /** Today in the household time zone; decides past / current / future. */
  today: IsoDate;
  categories: readonly BudgetCategory[];
  /** Must cover every month from the fund start (or `month`) through `month`. */
  actuals: MonthlyActuals;
  /** Uncategorized money out this month, as a positive amount. */
  uncategorizedOut: Cents;
  /** Uncategorized money in this month. */
  uncategorizedIn: Cents;
  expectedIncome: Cents | null;
  plannedSavings: Cents;
  /** Money moved into savings and investment accounts this month. */
  actualSavings: Cents;
  /** When sinking funds started; null = this month. */
  fundStart: MonthKey | null;
}

export interface BudgetMonth {
  month: MonthKey;
  timing: "past" | "current" | "future";
  daysInMonth: number;
  /** Days left including today (current month only). */
  daysLeft: number | null;
  income: {
    expected: Cents | null;
    actual: Cents;
    uncategorizedIn: Cents;
    lines: { categoryId: number; name: string; actual: Cents }[];
  };
  fixed: {
    budget: Cents;
    actual: Cents;
    lines: { categoryId: number; name: string; group: string; budget: Cents | null; actual: Cents; status: FixedStatus }[];
  };
  nonMonthly: {
    setAside: Cents;
    actual: Cents;
    lines: { categoryId: number; name: string; annual: Cents | null; setAside: Cents; actual: Cents; fundBalance: Cents }[];
  };
  flex: {
    /** null until expected income is set. */
    budget: Cents | null;
    actual: Cents;
    left: Cents | null;
    uncategorized: Cents;
    lines: { categoryId: number; name: string; group: string; actual: Cents }[];
    pace: { expectedByNow: Cents; perDayLeft: Cents; status: "under" | "on" | "over" } | null;
  };
  savings: { planned: Cents; actual: Cents };
  totals: { income: Cents; spending: Cents; net: Cents; savingsRate: number | null };
}

function fixedStatus(budget: Cents | null, spent: Cents, timing: BudgetMonth["timing"]): FixedStatus {
  if (budget === null || budget === 0) return spent === 0 ? "ok" : "unbudgeted";
  if (spent === 0 && timing !== "past") return "upcoming";
  if (spent > multiplyCents(budget, 1.1)) return "over";
  if (spent < multiplyCents(budget, 0.9)) return timing === "past" ? "under" : "upcoming";
  return "ok";
}

export function computeBudgetMonth(input: BudgetMonthInput): BudgetMonth {
  const { month, today, categories, actuals } = input;
  const todayMonth = monthOf(today);
  const timing = month < todayMonth ? "past" : month > todayMonth ? "future" : "current";
  const parts = parseIsoDate(firstDay(month));
  const days = daysInMonth(parts.year, parts.month);
  const dayOfMonth = parseIsoDate(today).day;
  const daysLeft = timing === "current" ? days - dayOfMonth + 1 : null;
  const spent = (id: number) => neg(actual(actuals, id, month));
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

  const incomeLines = categories
    .filter((c) => c.budgetType === "income")
    .map((c) => ({ categoryId: c.id, name: c.name, actual: actual(actuals, c.id, month) }))
    .filter((l) => l.actual !== 0)
    .sort(byName);
  const incomeActual = incomeLines.reduce((s, l) => s + l.actual, 0);

  const fixedLines = categories
    .filter((c) => c.budgetType === "fixed")
    .map((c) => ({
      categoryId: c.id,
      name: c.name,
      group: c.group,
      budget: c.budget,
      actual: spent(c.id),
      status: fixedStatus(c.budget, spent(c.id), timing),
    }))
    .filter((l) => (l.budget ?? 0) > 0 || l.actual !== 0)
    .sort(byName);

  const fundStart = input.fundStart ?? month;
  const nonMonthlyLines = categories
    .filter((c) => c.budgetType === "non_monthly")
    .map((c) => ({
      categoryId: c.id,
      name: c.name,
      annual: c.budget,
      setAside: monthlySetAside(c.budget ?? 0, month),
      actual: spent(c.id),
      fundBalance: month < fundStart ? c.startingBalance : sinkingFundBalance(c, fundStart, month, actuals),
    }))
    .filter((l) => (l.annual ?? 0) > 0 || l.actual !== 0 || l.fundBalance !== 0)
    .sort(byName);

  const flexLines = categories
    .filter((c) => c.budgetType === "flex")
    .map((c) => ({ categoryId: c.id, name: c.name, group: c.group, actual: spent(c.id) }))
    .filter((l) => l.actual !== 0)
    .sort((a, b) => b.actual - a.actual);

  const fixedBudget = fixedLines.reduce((s, l) => s + (l.budget ?? 0), 0);
  const fixedActual = fixedLines.reduce((s, l) => s + l.actual, 0);
  const setAside = nonMonthlyLines.reduce((s, l) => s + l.setAside, 0);
  const nonMonthlyActual = nonMonthlyLines.reduce((s, l) => s + l.actual, 0);
  // Uncategorized spending counts against Flex until it's categorized.
  const flexActual = flexLines.reduce((s, l) => s + l.actual, 0) + input.uncategorizedOut;

  const flexBudget =
    input.expectedIncome === null ? null : input.expectedIncome - fixedBudget - setAside - input.plannedSavings;
  const left = flexBudget === null ? null : flexBudget - flexActual;

  let pace: BudgetMonth["flex"]["pace"] = null;
  if (timing === "current" && flexBudget !== null && left !== null && daysLeft !== null) {
    const expectedByNow = multiplyCents(Math.max(0, flexBudget), dayOfMonth / days);
    const status = flexActual <= expectedByNow ? "under" : flexActual <= multiplyCents(expectedByNow, 1.1) ? "on" : "over";
    pace = { expectedByNow, perDayLeft: Math.floor(Math.max(0, left) / daysLeft), status };
  }

  const spending = fixedActual + nonMonthlyActual + flexActual;
  return {
    month,
    timing,
    daysInMonth: days,
    daysLeft,
    income: { expected: input.expectedIncome, actual: incomeActual, uncategorizedIn: input.uncategorizedIn, lines: incomeLines },
    fixed: { budget: fixedBudget, actual: fixedActual, lines: fixedLines },
    nonMonthly: { setAside, actual: nonMonthlyActual, lines: nonMonthlyLines },
    flex: { budget: flexBudget, actual: flexActual, left, uncategorized: input.uncategorizedOut, lines: flexLines, pace },
    savings: { planned: input.plannedSavings, actual: input.actualSavings },
    totals: {
      income: incomeActual,
      spending,
      net: incomeActual - spending,
      savingsRate: incomeActual > 0 ? (incomeActual - spending) / incomeActual : null,
    },
  };
}

export interface CashFlowMonth {
  month: MonthKey;
  income: Cents;
  fixed: Cents;
  flex: Cents;
  nonMonthly: Cents;
  uncategorized: Cents;
  spending: Cents;
  net: Cents;
  savingsRate: number | null;
  movedToSavings: Cents;
}

/** Income and spending totals for each month, for the cash flow page. */
export function cashFlow(
  months: readonly MonthKey[],
  categories: readonly Pick<BudgetCategory, "id" | "budgetType">[],
  actuals: MonthlyActuals,
  uncategorizedOut: ReadonlyMap<MonthKey, Cents>,
  movedToSavings: ReadonlyMap<MonthKey, Cents>,
): CashFlowMonth[] {
  return months.map((month) => {
    const sum = (type: BudgetType) =>
      categories.filter((c) => c.budgetType === type).reduce((s, c) => s + actual(actuals, c.id, month), 0);
    const income = sum("income");
    const fixed = neg(sum("fixed"));
    const flex = neg(sum("flex"));
    const nonMonthly = neg(sum("non_monthly"));
    const uncategorized = uncategorizedOut.get(month) ?? 0;
    const spending = fixed + flex + nonMonthly + uncategorized;
    return {
      month,
      income,
      fixed,
      flex,
      nonMonthly,
      uncategorized,
      spending,
      net: income - spending,
      savingsRate: income > 0 ? (income - spending) / income : null,
      movedToSavings: movedToSavings.get(month) ?? 0,
    };
  });
}

export interface BudgetSuggestions {
  expectedIncome: Cents | null;
  /** Monthly for Fixed, yearly for Non-monthly. */
  budgets: { categoryId: number; amount: Cents }[];
  basedOnMonths: MonthKey[];
}

/**
 * Starting budgets from history: Fixed and income = average of recent
 * complete months; Non-monthly = yearly total (scaled up when there's less
 * than a year of data). Rounded to whole dollars.
 */
export function suggestBudgets(
  categories: readonly Pick<BudgetCategory, "id" | "budgetType">[],
  actuals: MonthlyActuals,
  completeMonths: readonly MonthKey[],
): BudgetSuggestions {
  const recent = completeMonths.slice(-3);
  const year = completeMonths.slice(-12);
  const dollars = (c: Cents) => Math.round(c / 100) * 100;
  const total = (id: number, months: readonly MonthKey[]) => months.reduce((s, m) => s + actual(actuals, id, m), 0);

  const budgets: BudgetSuggestions["budgets"] = [];
  let income = 0;
  for (const c of categories) {
    if (c.budgetType === "income" && recent.length > 0) income += total(c.id, recent) / recent.length;
    if (c.budgetType === "fixed" && recent.length > 0) {
      const avg = -total(c.id, recent) / recent.length;
      if (avg > 0) budgets.push({ categoryId: c.id, amount: dollars(avg) });
    }
    if (c.budgetType === "non_monthly" && year.length > 0) {
      const annual = (-total(c.id, year) / year.length) * 12;
      if (annual > 0) budgets.push({ categoryId: c.id, amount: dollars(annual) });
    }
  }
  return { expectedIncome: recent.length > 0 && income > 0 ? dollars(income) : null, budgets, basedOnMonths: [...year] };
}

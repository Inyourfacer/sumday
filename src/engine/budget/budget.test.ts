import { describe, expect, it } from "vitest";
import {
  cashFlow,
  computeBudgetMonth,
  monthRange,
  monthlySetAside,
  nextMonth,
  sinkingFundBalance,
  suggestBudgets,
  type BudgetCategory,
  type BudgetMonthInput,
} from "./budget.ts";
import { detectRecurring, upcoming, type RecurringInput } from "./recurring.ts";
import { balanceOn, netWorthHistory } from "./networth.ts";

const cat = (id: number, name: string, budgetType: BudgetCategory["budgetType"], budget: number | null = null, startingBalance = 0): BudgetCategory => ({
  id,
  name,
  group: "",
  budgetType,
  isEssential: false,
  budget,
  startingBalance,
});

const CATEGORIES = [
  cat(1, "Paycheck", "income"),
  cat(2, "Rent", "fixed", 200_000),
  cat(3, "Internet", "fixed", 8_000),
  cat(4, "Groceries", "flex"),
  cat(5, "Restaurants", "flex"),
  cat(6, "Travel", "non_monthly", 240_000),
  cat(7, "Car registration", "non_monthly", 30_000, 10_000),
  cat(8, "Transfer", "transfer"),
];

function actuals(entries: [number, string, number][]) {
  const map = new Map<number, Map<string, number>>();
  for (const [id, month, amount] of entries) {
    const inner = map.get(id) ?? new Map<string, number>();
    inner.set(month, (inner.get(month) ?? 0) + amount);
    map.set(id, inner);
  }
  return map;
}

describe("months", () => {
  it("steps and ranges", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(nextMonth("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthRange("2026-11", "2026-10")).toEqual([]);
  });
});

describe("sinking funds", () => {
  it("sets aside exactly the yearly amount across a calendar year", () => {
    const months = monthRange("2026-01", "2026-12");
    const parts = months.map((m) => monthlySetAside(100_001, m));
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100_001);
    expect(parts[0]).toBe(8_334);
    expect(parts[11]).toBe(8_333);
  });

  it("accumulates set-asides minus spending from the fund start", () => {
    const travel = CATEGORIES[5]!; // $2,400/yr → $200/mo
    const a = actuals([
      [6, "2026-09", -50_000],
      [6, "2026-10", 5_000], // a refund
    ]);
    expect(sinkingFundBalance(travel, "2026-08", "2026-08", a)).toBe(20_000);
    expect(sinkingFundBalance(travel, "2026-08", "2026-09", a)).toBe(40_000 - 50_000);
    expect(sinkingFundBalance(travel, "2026-08", "2026-11", a)).toBe(80_000 - 50_000 + 5_000);
    const car = CATEGORIES[6]!; // $300/yr = $25/mo, starts with $100
    expect(sinkingFundBalance(car, "2026-08", "2026-09", a)).toBe(10_000 + 5_000);
  });
});

function input(over: Partial<BudgetMonthInput> = {}): BudgetMonthInput {
  return {
    month: "2026-11",
    today: "2026-11-10",
    categories: CATEGORIES,
    actuals: actuals([
      [1, "2026-11", 500_000],
      [2, "2026-11", -200_000],
      [4, "2026-11", -30_000],
      [5, "2026-11", -12_000],
      [6, "2026-11", -10_000],
      [8, "2026-11", -100_000],
    ]),
    uncategorizedOut: 3_000,
    uncategorizedIn: 1_000,
    expectedIncome: 500_000,
    plannedSavings: 50_000,
    actualSavings: 40_000,
    fundStart: "2026-11",
    ...over,
  };
}

describe("computeBudgetMonth", () => {
  it("builds the Flex pool from income, fixed, non-monthly and savings", () => {
    const b = computeBudgetMonth(input());
    expect(b.timing).toBe("current");
    expect(b.daysLeft).toBe(21);
    expect(b.income).toMatchObject({ expected: 500_000, actual: 500_000, uncategorizedIn: 1_000 });
    expect(b.fixed.budget).toBe(208_000);
    expect(b.fixed.actual).toBe(200_000);
    expect(b.fixed.lines.map((l) => [l.name, l.status])).toEqual([
      ["Internet", "upcoming"],
      ["Rent", "ok"],
    ]);
    // $200 + $25 set aside
    expect(b.nonMonthly.setAside).toBe(22_500);
    expect(b.nonMonthly.lines.find((l) => l.name === "Travel")).toMatchObject({ setAside: 20_000, actual: 10_000, fundBalance: 10_000 });
    // 5,000 − 2,080 − 225 − 500 = 2,195
    expect(b.flex.budget).toBe(219_500);
    // groceries + restaurants + uncategorized
    expect(b.flex.actual).toBe(45_000);
    expect(b.flex.left).toBe(174_500);
    expect(b.flex.lines.map((l) => l.name)).toEqual(["Groceries", "Restaurants"]);
    // Transfers aren't spending.
    expect(b.totals).toEqual({ income: 500_000, spending: 255_000, net: 245_000, savingsRate: 0.49 });
    expect(b.savings).toEqual({ planned: 50_000, actual: 40_000 });
  });

  it("tracks daily pace in the current month", () => {
    // Day 10 of 30: a third of $2,195 ≈ $731.67 expected by now; $450 spent.
    const b = computeBudgetMonth(input());
    expect(b.flex.pace).toEqual({ expectedByNow: 73_167, perDayLeft: Math.floor(174_500 / 21), status: "under" });
    const over = computeBudgetMonth(input({ uncategorizedOut: 100_000 }));
    expect(over.flex.pace?.status).toBe("over");
  });

  it("has no Flex budget until expected income is set", () => {
    const b = computeBudgetMonth(input({ expectedIncome: null }));
    expect(b.flex.budget).toBeNull();
    expect(b.flex.left).toBeNull();
    expect(b.flex.pace).toBeNull();
  });

  it("marks fixed bills in a finished month", () => {
    const b = computeBudgetMonth(
      input({
        today: "2026-12-02",
        actuals: actuals([
          [2, "2026-11", -230_000],
          [3, "2026-11", -6_000],
          [5, "2026-11", -1_000],
        ]),
        categories: [...CATEGORIES, cat(9, "Gym", "fixed")],
      }),
    );
    expect(b.timing).toBe("past");
    expect(b.daysLeft).toBeNull();
    expect(b.flex.pace).toBeNull();
    expect(b.fixed.lines.map((l) => [l.name, l.status])).toEqual([
      ["Internet", "under"],
      ["Rent", "over"],
    ]);
    const withGym = computeBudgetMonth(input({ actuals: actuals([[9, "2026-11", -4_000]]), categories: [...CATEGORIES, cat(9, "Gym", "fixed")] }));
    expect(withGym.fixed.lines.find((l) => l.name === "Gym")?.status).toBe("unbudgeted");
  });

  it("knows future months", () => {
    expect(computeBudgetMonth(input({ month: "2026-12" })).timing).toBe("future");
  });
});

describe("cashFlow", () => {
  it("totals each month", () => {
    const rows = cashFlow(
      ["2026-10", "2026-11"],
      CATEGORIES,
      actuals([
        [1, "2026-10", 400_000],
        [2, "2026-10", -200_000],
        [4, "2026-10", -50_000],
        [6, "2026-11", -10_000],
      ]),
      new Map([["2026-10", 5_000]]),
      new Map([["2026-10", 30_000]]),
    );
    expect(rows[0]).toEqual({
      month: "2026-10",
      income: 400_000,
      fixed: 200_000,
      flex: 50_000,
      nonMonthly: 0,
      uncategorized: 5_000,
      spending: 255_000,
      net: 145_000,
      savingsRate: 145_000 / 400_000,
      movedToSavings: 30_000,
    });
    expect(rows[1]).toMatchObject({ income: 0, spending: 10_000, net: -10_000, savingsRate: null });
  });
});

describe("suggestBudgets", () => {
  it("averages recent months for fixed and income, and annualizes non-monthly", () => {
    const a = actuals([
      [1, "2026-08", 480_000],
      [1, "2026-09", 500_000],
      [1, "2026-10", 520_000],
      [2, "2026-09", -200_000],
      [2, "2026-10", -200_050],
      [6, "2026-08", -60_000],
    ]);
    const s = suggestBudgets(CATEGORIES, a, ["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(s.expectedIncome).toBe(500_000);
    expect(s.budgets).toEqual([
      { categoryId: 2, amount: 133_400 }, // (2000 + 2000.50) / 3 ≈ 1333.50 → $1,334
      { categoryId: 6, amount: 180_000 }, // $600 over 4 months → $1,800/yr
    ]);
    expect(suggestBudgets(CATEGORIES, a, [])).toEqual({ expectedIncome: null, budgets: [], basedOnMonths: [] });
  });
});

const tx = (id: number, date: string, amount: number, payee: string, accountId = 1, categoryId: number | null = null): RecurringInput => ({
  id,
  date,
  amount,
  payee,
  accountId,
  categoryId,
});

describe("detectRecurring", () => {
  it("finds monthly bills, including ones with varying amounts", () => {
    const rows = [
      tx(1, "2026-08-03", -1_549, "Netflix.com", 1, 7),
      tx(2, "2026-09-03", -1_549, "Netflix.com", 1, 7),
      tx(3, "2026-10-04", -1_549, "Netflix.com", 1, 7),
      tx(4, "2026-08-20", -9_100, "PG&E"),
      tx(5, "2026-09-21", -14_237, "PG&E"),
      tx(6, "2026-10-20", -12_800, "PG&E"),
    ];
    const series = detectRecurring(rows, "2026-10-25");
    expect(series.map((s) => [s.payee, s.frequency, s.amount, s.amountVaries, s.nextDate, s.active, s.categoryId])).toEqual([
      ["Netflix.com", "monthly", -1_549, false, "2026-11-04", true, 7],
      ["PG&E", "monthly", -12_800, true, "2026-11-20", true, null],
    ]);
  });

  it("finds biweekly paychecks and yearly charges", () => {
    const series = detectRecurring(
      [
        tx(1, "2026-09-04", 250_000, "ACME PAYROLL"),
        tx(2, "2026-09-18", 250_000, "ACME PAYROLL"),
        tx(3, "2026-10-02", 250_000, "ACME PAYROLL"),
        tx(4, "2026-10-16", 251_000, "ACME PAYROLL"),
        tx(5, "2025-03-10", -13_900, "Amazon Prime"),
        tx(6, "2026-03-10", -13_900, "Amazon Prime"),
      ],
      "2026-10-20",
    );
    const pay = series.find((s) => s.payee === "ACME PAYROLL")!;
    expect(pay).toMatchObject({ frequency: "biweekly", direction: "in", occurrences: 4, nextDate: "2026-10-30", active: true });
    const prime = series.find((s) => s.payee === "Amazon Prime")!;
    expect(prime).toMatchObject({ frequency: "yearly", nextDate: "2027-03-10", active: true });
  });

  it("ignores irregular spending but finds a subscription hidden among it", () => {
    const rows = [
      tx(1, "2026-08-02", -499, "Amazon"),
      tx(2, "2026-08-05", -2_350, "Amazon"),
      tx(3, "2026-08-15", -1_499, "Amazon"),
      tx(4, "2026-08-29", -8_812, "Amazon"),
      tx(5, "2026-09-15", -1_499, "Amazon"),
      tx(6, "2026-09-16", -3_100, "Amazon"),
      tx(7, "2026-10-15", -1_499, "Amazon"),
      tx(8, "2026-08-01", -550, "Blue Bottle"),
      tx(9, "2026-08-03", -625, "Blue Bottle"),
      tx(10, "2026-08-12", -550, "Blue Bottle"),
    ];
    const series = detectRecurring(rows, "2026-10-20");
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ payee: "Amazon", amount: -1_499, frequency: "monthly", transactionIds: [3, 5, 7] });
  });

  it("marks stopped series inactive and keeps accounts and directions apart", () => {
    const rows = [
      tx(1, "2026-03-01", -999, "Gym"),
      tx(2, "2026-04-01", -999, "Gym"),
      tx(3, "2026-05-01", -999, "Gym"),
      tx(4, "2026-08-01", -999, "Gym", 2),
      tx(5, "2026-09-01", -999, "Gym", 2),
    ];
    const series = detectRecurring(rows, "2026-10-20");
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ accountId: 1, active: false });
  });

  it("projects upcoming occurrences of active series", () => {
    const series = detectRecurring(
      [tx(1, "2026-09-04", 250_000, "Pay"), tx(2, "2026-09-18", 250_000, "Pay"), tx(3, "2026-10-02", 250_000, "Pay")],
      "2026-10-05",
    );
    expect(upcoming(series, "2026-10-05", "2026-11-10").map((u) => u.date)).toEqual(["2026-10-16", "2026-10-30"]);
  });
});

describe("net worth", () => {
  const checking = {
    id: 1,
    isLiability: false,
    snapshots: [{ date: "2026-10-31", balance: 100_000 }],
    transactions: [
      { date: "2026-10-15", amount: -20_000 },
      { date: "2026-10-20", amount: 30_000 },
      { date: "2026-11-05", amount: 5_000 },
    ],
  };
  const card = {
    id: 2,
    isLiability: true,
    snapshots: [],
    transactions: [
      { date: "2026-09-10", amount: -3_000 },
      { date: "2026-10-12", amount: -4_000 },
    ],
  };

  it("uses the nearest snapshot, forward or backward", () => {
    expect(balanceOn(checking, "2026-11-30")).toBe(105_000);
    expect(balanceOn(checking, "2026-10-31")).toBe(100_000);
    // Before the snapshot: work back from it.
    expect(balanceOn(checking, "2026-10-16")).toBe(70_000);
    expect(balanceOn(checking, "2026-10-14")).toBeNull();
    // Before any data: unknown.
    expect(balanceOn(checking, "2026-10-01")).toBeNull();
    // No snapshots: running total.
    expect(balanceOn(card, "2026-10-31")).toBe(-7_000);
    expect(balanceOn({ snapshots: [], transactions: [] }, "2026-10-31")).toBeNull();
  });

  it("builds monthly points from the first month with data", () => {
    const points = netWorthHistory(
      [checking, card],
      [
        { month: "2026-08", date: "2026-08-31" },
        { month: "2026-09", date: "2026-09-30" },
        { month: "2026-10", date: "2026-10-31" },
        { month: "2026-11", date: "2026-11-08" },
      ],
    );
    expect(points).toEqual([
      { month: "2026-09", date: "2026-09-30", assets: 0, liabilities: -3_000, netWorth: -3_000 },
      { month: "2026-10", date: "2026-10-31", assets: 100_000, liabilities: -7_000, netWorth: 93_000 },
      { month: "2026-11", date: "2026-11-08", assets: 105_000, liabilities: -7_000, netWorth: 98_000 },
    ]);
  });
});

/**
 * Monthly review report (DESIGN §13). Built from the data as it stands when
 * it's generated (the scheduler does it on the 1st for the month just
 * finished) and stored, so later edits don't rewrite history.
 */
import type { FastifyInstance } from "fastify";
import { firstDay, monthOf, monthRange, nextMonth } from "../engine/budget/budget.ts";
import { allocation, drift } from "../engine/invest/portfolio.ts";
import type { MonthlyReport, ReportSummary } from "../shared/api.ts";
import { reportMonthSchema } from "../shared/schemas.ts";
import { computeAlerts } from "./alerts.ts";
import { listAccounts } from "./accounts.ts";
import { budgetFor, loadActuals, loadBudgetCategories, netWorth, recurring, today } from "./budget.ts";
import type { Db } from "./db.ts";
import { PORTFOLIO_TYPES, getTarget, loadHoldings, toPositions } from "./holdings.ts";
import { badRequest, notFound, parse } from "./http.ts";
import { buildPlan, goalsWithPlan } from "./plan.ts";
import { retirement } from "./retirement.ts";

const prevMonth = (m: string) => nextMonth(m, -1);

export function buildReport(db: Db, month: string): MonthlyReport {
  const now = today(db);
  const { budget: b } = budgetFor(db, month);

  // Categories: this month against the 12 months before it.
  // Only months with data count toward the average.
  const first = (db.prepare("SELECT MIN(date) AS d FROM transactions WHERE status = 'posted'").get() as { d: string | null }).d;
  const from = first && monthOf(first) > nextMonth(month, -12) ? monthOf(first) : nextMonth(month, -12);
  const history = from <= prevMonth(month) ? monthRange(from, prevMonth(month)) : [];
  const actuals = loadActuals(db, history[0] ?? month, month);
  const categories = loadBudgetCategories(db)
    .filter((c) => c.budgetType !== "transfer" && c.budgetType !== "income")
    .map((c) => {
      const byMonth = actuals.get(c.id);
      const actual = -(byMonth?.get(month) ?? 0);
      const average = history.length ? Math.round(-history.reduce((s, m) => s + (byMonth?.get(m) ?? 0), 0) / history.length) : 0;
      return { name: c.name, budgetType: c.budgetType, actual, average, change: actual - average };
    })
    .filter((c) => c.actual !== 0 || c.average !== 0);
  const averageMonths = history.length;
  const top = [...categories].sort((x, y) => y.actual - x.actual).slice(0, 8);
  const changes = categories
    .filter((c) => c.average > 0 && Math.abs(c.change) >= 2_500)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change))
    .slice(0, 5);

  // Recurring charges that showed up this month for the first time.
  const newRecurring = recurring(db)
    .series.filter(
      (s) =>
        !s.ignored &&
        !s.isTransfer &&
        s.direction === "out" &&
        monthOf(s.lastDate) === month &&
        (s.frequency === "yearly" ? s.occurrences <= 2 : ["monthly", "quarterly"].includes(s.frequency) && s.occurrences <= 3),
    )
    .map((s) => ({ payee: s.payee, amount: -s.amount, frequency: s.frequency, accountName: s.accountName }));

  // Net worth: what changed, and how much came from income minus spending.
  const points = netWorth(db, 26).points;
  const end = points.find((p) => p.month === month);
  const start = points.find((p) => p.month === prevMonth(month));
  const netWorthChange =
    end && start
      ? {
          start: start.netWorth,
          end: end.netWorth,
          change: end.netWorth - start.netWorth,
          fromCashFlow: b.totals.net,
          marketAndOther: end.netWorth - start.netWorth - b.totals.net,
          debtPaidDown: end.liabilities - start.liabilities,
        }
      : null;

  const accounts = listAccounts(db).filter((a) => !a.isClosed);
  const debts = accounts.filter((a) => a.isLiability && a.balance < 0);
  const positions = toPositions(loadHoldings(db).filter((h) => accounts.some((a) => a.id === h.account_id && PORTFOLIO_TYPES.includes(a.type))));
  const d = positions.length > 0 ? drift(allocation(positions), getTarget(db).target) : null;

  // Retirement chance now, and in the last report before this one.
  let ret: MonthlyReport["retirement"] = null;
  try {
    const r = retirement(db);
    if (r.ready && r.result) {
      const previous = db.prepare("SELECT data FROM reports WHERE month < ? ORDER BY month DESC LIMIT 1").get(month) as { data: string } | undefined;
      const prior = previous ? (JSON.parse(previous.data) as MonthlyReport).retirement : null;
      ret = {
        successRate: r.result.successRate,
        target: r.settings.successTarget,
        retireYear: r.result.retireYear,
        portfolio: r.inputs!.balances.total,
        previous: prior ? { month: (JSON.parse(previous!.data) as MonthlyReport).month, successRate: prior.successRate, portfolio: prior.portfolio } : null,
      };
    }
  } catch {
    ret = null;
  }

  const plan = buildPlan(db);
  const alerts = computeAlerts(db);
  const uncategorized = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE status = 'posted' AND category_id IS NULL AND date >= ? AND date < ?")
    .get(firstDay(month), firstDay(nextMonth(month))) as { n: number };

  return {
    month,
    generatedAt: new Date().toISOString(),
    asOf: now,
    budget: {
      income: b.totals.income,
      expectedIncome: b.income.expected,
      spending: b.totals.spending,
      net: b.totals.net,
      savingsRate: b.totals.savingsRate,
      fixed: { budget: b.fixed.budget, actual: b.fixed.actual },
      flex: { budget: b.flex.budget, actual: b.flex.actual },
      nonMonthly: { budget: b.nonMonthly.setAside, actual: b.nonMonthly.actual },
      savings: b.savings,
    },
    averageMonths,
    topCategories: top,
    changes,
    newRecurring,
    netWorth: netWorthChange,
    goals: goalsWithPlan(db).map((g) => ({
      name: g.name,
      saved: g.progress.saved,
      target: g.progress.target,
      percent: g.progress.percent,
      status: g.progress.status,
      targetDate: g.targetDate,
    })),
    debt: {
      total: -debts.reduce((s, a) => s + a.balance, 0),
      paidDown: netWorthChange ? netWorthChange.debtPaidDown : null,
      accounts: debts.map((a) => ({ name: a.name, balance: -a.balance, apr: a.interestRatePct })),
    },
    drift: d ? { outOfBand: d.outOfBand, rows: d.rows.map((r) => ({ assetClass: r.assetClass, current: r.current, target: r.target, status: r.status })) } : null,
    retirement: ret,
    moves: plan.result.recommendations
      .filter((r) => r.amount > 0 || (r.action && r.status !== "done"))
      .slice(0, 6)
      .map((r) => ({ title: r.title, action: r.action, amount: r.amount, why: r.why })),
    alerts: alerts.map((a) => ({ kind: a.kind, title: a.title, message: a.message })),
    dataHealth: {
      stale: alerts.filter((a) => a.kind === "stale_data").map((a) => a.title),
      uncategorized: uncategorized.n,
      uncategorizedAmount: b.flex.uncategorized,
    },
  };
}

export function saveReport(db: Db, month: string): MonthlyReport {
  const report = buildReport(db, month);
  db.prepare("INSERT OR REPLACE INTO reports (month, data, created_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run(month, JSON.stringify(report));
  return report;
}

/** Last month's report, if it hasn't been made yet. Safe to call any time. */
export function ensureLastMonthReport(db: Db): string | null {
  const month = prevMonth(monthOf(today(db)));
  const hasData = db.prepare("SELECT 1 FROM transactions WHERE date < ? LIMIT 1").get(firstDay(nextMonth(month)));
  if (!hasData) return null;
  if (db.prepare("SELECT 1 FROM reports WHERE month = ?").get(month)) return null;
  saveReport(db, month);
  return month;
}

export function listReports(db: Db): ReportSummary[] {
  return (db.prepare("SELECT month, data, created_at AS createdAt FROM reports ORDER BY month DESC").all() as { month: string; data: string; createdAt: string }[]).map((r) => {
    const d = JSON.parse(r.data) as MonthlyReport;
    return {
      month: r.month,
      createdAt: r.createdAt,
      income: d.budget.income,
      spending: d.budget.spending,
      savingsRate: d.budget.savingsRate,
      netWorthChange: d.netWorth?.change ?? null,
      successRate: d.retirement?.successRate ?? null,
    };
  });
}

export function registerReportRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/reports", async () => ({ reports: listReports(db), lastMonth: prevMonth(monthOf(today(db))) }));

  app.get("/api/reports/:month", async (request) => {
    const { month } = parse(reportMonthSchema, request.params);
    const row = db.prepare("SELECT data FROM reports WHERE month = ?").get(month) as { data: string } | undefined;
    if (!row) throw notFound("Report");
    return JSON.parse(row.data) as MonthlyReport;
  });

  // Make (or remake) a report.
  app.post("/api/reports/:month", async (request) => {
    const { month } = parse(reportMonthSchema, request.params);
    if (month > monthOf(today(db))) throw badRequest("That month hasn't started yet.");
    return saveReport(db, month);
  });

  app.delete("/api/reports/:month", async (request, reply) => {
    const { month } = parse(reportMonthSchema, request.params);
    db.prepare("DELETE FROM reports WHERE month = ?").run(month);
    return reply.code(204).send();
  });
}


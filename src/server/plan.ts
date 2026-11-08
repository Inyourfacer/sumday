import { readdirSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { firstDay, monthOf, monthRange, monthlySetAside, nextMonth } from "../engine/budget/budget.ts";
import { addDays, parseIsoDate, type IsoDate } from "../engine/dates.ts";
import { compareStrategies, type Debt } from "../engine/plan/debt.ts";
import { emergencyMonthsDefault, goalProgress } from "../engine/plan/goals.ts";
import { limitsFor, type ContributionLimits } from "../engine/plan/limits.ts";
import { DEFAULT_STEPS, STEP_IDS, runWaterfall, type PlanDebt, type StepId } from "../engine/plan/waterfall.ts";
import type { AccountView, DebtsResponse, GoalView, PlanResponse, PlanSettings, PlanAlert } from "../shared/api.ts";
import {
  debtQuerySchema,
  goalAllocationsSchema,
  goalInputSchema,
  goalPatchSchema,
  goalReorderSchema,
  planSettingsSchema,
} from "../shared/schemas.ts";
import { listAccounts } from "./accounts.ts";
import { getTarget, loadHoldings, toPositions } from "./holdings.ts";
import { allocation, drift, fees } from "../engine/invest/portfolio.ts";
import { getBudgetSettings, loadActuals, loadBudgetCategories, today } from "./budget.ts";
import { getSetting, setSetting, type Db } from "./db.ts";
import { getHousehold, getPeople } from "./household.ts";
import { badRequest, idParam, notFound, parse } from "./http.ts";

// ---------- Contribution limits ----------

let limitsTable: ContributionLimits[] | undefined;
function allLimits(): ContributionLimits[] {
  if (!limitsTable) {
    const dir = new URL("../../data/limits/", import.meta.url);
    limitsTable = readdirSync(dir)
      .filter((f) => /^\d{4}\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as ContributionLimits);
  }
  return limitsTable;
}

// ---------- Settings ----------

const DEFAULT_SETTINGS: PlanSettings = {
  steps: DEFAULT_STEPS,
  starterAmount: 200_000,
  highInterestApr: 7,
  emergencyMonths: null,
  availableOverride: null,
};

export function getPlanSettings(db: Db): PlanSettings {
  const stored = getSetting<Partial<PlanSettings>>(db, "plan") ?? {};
  // Keep the saved order, drop unknown steps, append any new ones.
  const saved = (stored.steps ?? []).filter((s): s is { id: StepId; enabled: boolean } => (STEP_IDS as readonly string[]).includes(s.id));
  const steps = [...saved, ...DEFAULT_STEPS.filter((d) => !saved.some((s) => s.id === d.id))];
  return { ...DEFAULT_SETTINGS, ...stored, steps };
}

// ---------- Spending baselines ----------

/** The last up-to-3 complete months that have data. */
function recentCompleteMonths(db: Db, now: IsoDate): string[] {
  const row = db.prepare("SELECT MIN(date) AS d FROM transactions WHERE status = 'posted'").get() as { d: string | null };
  if (row.d === null) return [];
  const last = nextMonth(monthOf(now), -1);
  const first = monthOf(row.d);
  return first > last ? [] : monthRange(first, last).slice(-3);
}

export interface Baseline {
  /** Expected monthly spending per category: from its budget if set, else the recent average. */
  byCategory: Map<number, number>;
  fixed: number;
  nonMonthly: number;
  flex: number;
  essential: number;
  months: string[];
}

export function spendingBaseline(db: Db, now: IsoDate): Baseline {
  const months = recentCompleteMonths(db, now);
  const categories = loadBudgetCategories(db);
  const actuals = months.length ? loadActuals(db, months[0]!, months.at(-1)!) : new Map<number, Map<string, number>>();
  const avg = (id: number) =>
    months.length === 0 ? 0 : Math.round(-months.reduce((s, m) => s + (actuals.get(id)?.get(m) ?? 0), 0) / months.length);
  const uncategorized = months.length
    ? Math.round(
        (
          db
            .prepare(
              `SELECT COALESCE(SUM(-amount), 0) AS t FROM transactions
               WHERE status = 'posted' AND category_id IS NULL AND amount < 0 AND date >= ? AND date < ?`,
            )
            .get(firstDay(months[0]!), firstDay(nextMonth(months.at(-1)!))) as { t: number }
        ).t / months.length,
      )
    : 0;
  const byCategory = new Map<number, number>();
  const base: Baseline = { byCategory, fixed: 0, nonMonthly: 0, flex: uncategorized, essential: 0, months };
  const thisMonth = monthOf(now);
  for (const c of categories) {
    let monthly: number;
    if (c.budgetType === "fixed") monthly = c.budget ?? avg(c.id);
    else if (c.budgetType === "non_monthly") monthly = c.budget !== null ? monthlySetAside(c.budget, thisMonth) : avg(c.id);
    else if (c.budgetType === "flex") monthly = avg(c.id);
    else continue;
    monthly = Math.max(0, monthly);
    byCategory.set(c.id, monthly);
    if (c.budgetType === "fixed") base.fixed += monthly;
    else if (c.budgetType === "non_monthly") base.nonMonthly += monthly;
    else base.flex += monthly;
    if (c.isEssential) base.essential += monthly;
  }
  return base;
}

// ---------- Goals ----------

interface GoalRow {
  id: number;
  name: string;
  kind: "emergency" | "custom";
  target_amount: number | null;
  target_date: string | null;
  priority: number;
}

function loadGoals(db: Db): GoalRow[] {
  return db.prepare("SELECT id, name, kind, target_amount, target_date, priority FROM goals ORDER BY kind = 'custom', priority, id").all() as GoalRow[];
}

function loadAllocations(db: Db): { goal_id: number; account_id: number; amount: number }[] {
  return db.prepare("SELECT goal_id, account_id, amount FROM goal_allocations").all() as { goal_id: number; account_id: number; amount: number }[];
}

const SAVINGS_TYPES = new Set(["savings"]);

interface Context {
  now: IsoDate;
  accounts: AccountView[];
  baseline: Baseline;
  earners: number;
  emergencyMonths: number;
  emergencyTarget: number;
  emergencySaved: number;
  emergencyBasis: "earmarked" | "savings_accounts";
  goals: GoalView[];
  warnings: string[];
}

function buildContext(db: Db): Context {
  const now = today(db);
  const settings = getPlanSettings(db);
  const accounts = listAccounts(db).filter((a) => !a.isClosed);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const people = getPeople(db);
  const baseline = spendingBaseline(db, now);
  const earners = Math.max(1, people.filter((p) => (p.income ?? 0) > 0).length);
  const emergencyMonths = settings.emergencyMonths ?? emergencyMonthsDefault(earners);
  const goals = loadGoals(db);
  const allocations = loadAllocations(db);
  const warnings: string[] = [];

  // Earmarks larger than the account balance.
  for (const a of accounts) {
    const earmarked = allocations.filter((x) => x.account_id === a.id).reduce((s, x) => s + x.amount, 0);
    if (earmarked > Math.max(0, a.balance)) {
      warnings.push(`More is set aside for goals in ${a.name} than its balance ($${Math.round((earmarked - a.balance) / 100).toLocaleString("en-US")} over).`);
    }
  }

  const emergency = goals.find((g) => g.kind === "emergency");
  const emergencyAlloc = allocations.filter((x) => x.goal_id === emergency?.id);
  let emergencySaved: number;
  let emergencyBasis: Context["emergencyBasis"];
  if (emergencyAlloc.length > 0) {
    emergencySaved = emergencyAlloc.reduce((s, x) => s + x.amount, 0);
    emergencyBasis = "earmarked";
  } else {
    // Nothing earmarked: savings accounts count, minus what other goals have claimed there.
    emergencySaved = accounts
      .filter((a) => SAVINGS_TYPES.has(a.type))
      .reduce((s, a) => {
        const claimed = allocations.filter((x) => x.account_id === a.id).reduce((t, x) => t + x.amount, 0);
        return s + Math.max(0, a.balance - claimed);
      }, 0);
    emergencyBasis = "savings_accounts";
  }
  const autoTarget = Math.round(baseline.essential * emergencyMonths);
  const emergencyTarget = emergency?.target_amount ?? autoTarget;

  const views: GoalView[] = goals.map((g) => {
    const isEmergency = g.kind === "emergency";
    const allocs = allocations
      .filter((x) => x.goal_id === g.id)
      .map((x) => ({ accountId: x.account_id, accountName: byId.get(x.account_id)?.name ?? "(closed account)", amount: x.amount }));
    const saved = isEmergency ? emergencySaved : allocs.reduce((s, x) => s + x.amount, 0);
    const target = isEmergency ? emergencyTarget : (g.target_amount ?? 0);
    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      targetAmount: target,
      targetIsAuto: isEmergency && g.target_amount === null,
      targetDate: g.target_date,
      priority: g.priority,
      allocations: allocs,
      progress: goalProgress(target, saved, isEmergency ? null : g.target_date, now),
      plannedMonthly: 0,
      ...(isEmergency ? { emergency: { months: emergencyMonths, essentialMonthly: baseline.essential, autoTarget, basis: emergencyBasis } } : {}),
    };
  });

  return { now, accounts, baseline, earners, emergencyMonths, emergencyTarget, emergencySaved, emergencyBasis, goals: views, warnings };
}

// ---------- Debts ----------

function debtInputs(accounts: readonly AccountView[]): (PlanDebt & { minimumEstimated: boolean; aprMissing: boolean; type: string })[] {
  return accounts
    .filter((a) => a.isLiability && a.balance < 0)
    .map((a) => {
      const balance = -a.balance;
      // Without a stated minimum, assume 2% of the balance (at least $25), a common card minimum.
      const estimate = Math.max(2_500, Math.round(balance * 0.02));
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        balance,
        apr: a.interestRatePct ?? 0,
        aprMissing: a.interestRatePct === null,
        minPayment: a.minimumPayment ?? estimate,
        minimumEstimated: a.minimumPayment === null,
        promoApr: a.promoRatePct,
        promoEnds: a.promoEnds,
        paysInFull: a.paysInFull,
      };
    });
}

// ---------- Portfolio checks ----------

function portfolioAlerts(db: Db): PlanAlert[] {
  const positions = toPositions(loadHoldings(db));
  if (positions.length === 0) return [];
  const out: PlanAlert[] = [];
  const alloc = allocation(positions);
  const { target } = getTarget(db);
  const d = drift(alloc, target);
  if (d.outOfBand) {
    const off = d.rows.filter((r) => r.status !== "in");
    out.push({
      kind: "rebalance",
      title: "Investments have drifted from your target mix",
      message: `${off.map((r) => `${r.assetClass.replace("_", " ")} is ${Math.round(r.current * 100)}% (target ${Math.round(r.target * 100)}%)`).join("; ")}. See Investments for the cheapest way back.`,
      facts: off.map((r) => ({ label: r.assetClass, value: Math.round(r.drift * 1000) / 10, kind: "percent" as const })),
    });
  }
  if (alloc.unclassified > 0) {
    out.push({
      kind: "unclassified",
      title: "Some holdings need an asset class",
      message: "Sumday can't tell what some funds hold (target-date and blended funds, for example). Set their mix on the Investments page.",
      facts: [{ label: "Unclassified", value: alloc.unclassified, kind: "money" }],
    });
  }
  for (const e of fees(positions).expensive) {
    out.push({
      kind: "fees",
      title: `${e.label} costs ${e.expenseRatio}% a year`,
      message: `In ${e.accountName}. Broad index funds in the same asset class often cost under 0.1%. Check what your plan or brokerage offers.`,
      facts: [
        { label: "Value", value: e.value, kind: "money" },
        { label: "Yearly cost", value: Math.round((e.value * e.expenseRatio) / 100), kind: "money" },
      ],
    });
  }
  return out;
}

// ---------- The plan ----------

function yearStart(now: IsoDate): IsoDate {
  return `${now.slice(0, 4)}-01-01`;
}

export function buildPlan(db: Db): PlanResponse {
  const ctx = buildContext(db);
  const { now, accounts, baseline } = ctx;
  const settings = getPlanSettings(db);
  const household = getHousehold(db);
  const people = getPeople(db);
  const budget = getBudgetSettings(db);
  const year = parseIsoDate(now).year;
  const limitsChoice = limitsFor(year, allLimits());
  const warnings = [...ctx.warnings];
  if (!limitsChoice.exact) {
    warnings.push(`The IRS hasn't published ${year} contribution limits in Sumday's data yet, so ${limitsChoice.limits.year} limits are used.`);
  }

  // What's available each month: expected income minus the spending baseline.
  const computed = budget.expectedIncome === null ? null : budget.expectedIncome - baseline.fixed - baseline.nonMonthly - baseline.flex;
  const available = settings.availableOverride ?? computed;

  // Contributions so far this calendar year.
  const deposits = db
    .prepare(
      `SELECT a.type, a.owner_person_id AS owner, COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE t.status = 'posted' AND t.amount > 0 AND t.date >= ? AND a.type IN ('ira', 'roth_ira', 'hsa')
       GROUP BY a.type, a.owner_person_id`,
    )
    .all(yearStart(now)) as { type: string; owner: number | null; total: number }[];
  const hsaDeposits = deposits.filter((d) => d.type === "hsa").reduce((s, d) => s + d.total, 0);
  const hsaPayroll = people.reduce((s, p) => s + p.employerPlan.hsaPayrollAnnual, 0);

  const debts = debtInputs(accounts);
  for (const d of debts) {
    if (d.aprMissing && !d.paysInFull) warnings.push(`Add the interest rate for ${d.name} so it can be ranked correctly.`);
  }

  const customGoals = ctx.goals.filter((g) => g.kind === "custom");
  const result = runWaterfall({
    today: now,
    limits: limitsChoice.limits,
    limitsExact: limitsChoice.exact,
    steps: settings.steps,
    params: { starterAmount: settings.starterAmount, highInterestApr: settings.highInterestApr, emergencyMonths: ctx.emergencyMonths },
    available,
    essentialMonthly: baseline.essential,
    emergencySaved: ctx.emergencySaved,
    filingStatus: household.filingStatus,
    hsaCoverage: household.hsaCoverage,
    hsaProjected: hsaDeposits + hsaPayroll,
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      ageAtYearEnd: p.birthDate === null ? null : year - parseIsoDate(p.birthDate).year,
      income: p.income,
      plan: {
        type: p.employerPlan.type,
        matchTiers: p.employerPlan.matchTiers,
        pretaxPct: p.employerPlan.pretaxPct,
        rothPct: p.employerPlan.rothPct,
      },
      iraYtd: deposits.filter((d) => (d.type === "ira" || d.type === "roth_ira") && d.owner === p.id).reduce((s, d) => s + d.total, 0),
    })),
    debts,
    goals: customGoals.map((g) => ({
      id: g.id,
      name: g.name,
      remaining: g.progress.remaining,
      requiredMonthly: g.progress.requiredMonthly,
      targetDate: g.targetDate,
    })),
    hasTaxableAccount: accounts.some((a) => a.type === "brokerage"),
  });

  return {
    result,
    basis: {
      expectedIncome: budget.expectedIncome,
      fixed: baseline.fixed,
      nonMonthly: baseline.nonMonthly,
      flex: baseline.flex,
      computed,
      override: settings.availableOverride,
      averagedMonths: baseline.months,
      essentialMonthly: baseline.essential,
      emergencyTarget: ctx.emergencyTarget,
      emergencySaved: ctx.emergencySaved,
      emergencyBasis: ctx.emergencyBasis,
      emergencyMonths: ctx.emergencyMonths,
    },
    limits: { year: limitsChoice.limits.year, requestedYear: year, exact: limitsChoice.exact, source: limitsChoice.limits.source },
    settings,
    alerts: [...alerts(ctx, debts), ...portfolioAlerts(db)],
    warnings,
  };
}

/** Rule-based checks outside the waterfall (DESIGN §8.3). */
function alerts(ctx: Context, debts: ReturnType<typeof debtInputs>): PlanAlert[] {
  const out: PlanAlert[] = [];
  const monthlySpending = ctx.baseline.fixed + ctx.baseline.nonMonthly + ctx.baseline.flex;
  const allocations = ctx.goals.flatMap((g) => g.allocations);

  // Idle cash: checking holds more than two months of spending beyond anything set aside.
  const checking = ctx.accounts.filter((a) => a.type === "checking");
  const checkingBalance = checking.reduce((s, a) => s + a.balance, 0);
  const earmarkedInChecking = allocations.filter((x) => checking.some((a) => a.id === x.accountId)).reduce((s, x) => s + x.amount, 0);
  const cushion = monthlySpending * 2;
  const idle = checkingBalance - cushion - earmarkedInChecking;
  if (monthlySpending > 0 && idle >= 50_000) {
    out.push({
      kind: "idle_cash",
      title: "Cash sitting in checking",
      message: `Checking holds about $${Math.round(idle / 100).toLocaleString("en-US")} more than two months of spending. Moving it to savings, or to the first unfinished step above, puts it to work.`,
      facts: [
        { label: "Checking balance", value: checkingBalance, kind: "money" },
        { label: "Two months of spending", value: cushion, kind: "money" },
        { label: "Extra", value: idle, kind: "money" },
      ],
    });
  }

  // Low yield on savings.
  for (const a of ctx.accounts.filter((x) => x.type === "savings" && x.balance >= 100_000 && x.interestRatePct !== null && x.interestRatePct < 1)) {
    out.push({
      kind: "cash_yield",
      title: `${a.name} earns ${a.interestRatePct}%`,
      message: "Savings earning under 1% loses ground to inflation. Compare high-yield savings accounts for your emergency fund.",
      facts: [
        { label: "Balance", value: a.balance, kind: "money" },
        { label: "Interest rate", value: a.interestRatePct!, kind: "percent" },
      ],
    });
  }

  // Intro rates ending soon.
  for (const d of debts.filter((x) => x.promoEnds && x.promoEnds >= ctx.now && x.promoEnds <= addDays(ctx.now, 90))) {
    out.push({
      kind: "promo_ending",
      title: `${d.name}'s intro rate ends ${d.promoEnds}`,
      message: `The rate goes from ${d.promoApr ?? 0}% to ${d.apr}% on the remaining balance. Pay it down or plan for the higher rate.`,
      facts: [
        { label: "Balance", value: d.balance, kind: "money" },
        { label: "Rate after", value: d.apr, kind: "percent" },
      ],
    });
  }
  return out;
}

export function goalsWithPlan(db: Db): GoalView[] {
  const plan = buildPlan(db);
  const ctx = buildContext(db);
  return ctx.goals.map((g) => {
    const planned =
      g.kind === "emergency"
        ? plan.result.recommendations.filter((r) => r.step === "starter_emergency" || r.step === "full_emergency").reduce((s, r) => s + r.amount, 0)
        : plan.result.recommendations.filter((r) => r.subject?.kind === "goal" && r.subject.id === g.id).reduce((s, r) => s + r.amount, 0);
    return { ...g, plannedMonthly: planned };
  });
}

export function debtsView(db: Db, extraOverride?: number): DebtsResponse {
  const now = today(db);
  const plan = buildPlan(db);
  const debts = debtInputs(listAccounts(db).filter((a) => !a.isClosed));
  const toPay = debts.filter((d) => !d.paysInFull);
  const suggestedExtra = plan.result.recommendations
    .filter((r) => (r.step === "high_interest_debt" || r.step === "low_interest_debt") && r.subject?.kind === "debt")
    .reduce((s, r) => s + r.amount, 0);
  const extra = extraOverride ?? suggestedExtra;
  const start = firstDay(nextMonth(monthOf(now)));
  return {
    debts: debts.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      balance: d.balance,
      apr: d.apr,
      aprMissing: d.aprMissing,
      minPayment: d.minPayment,
      minimumEstimated: d.minimumEstimated,
      promoApr: d.promoApr ?? null,
      promoEnds: d.promoEnds ?? null,
      paysInFull: d.paysInFull,
    })),
    extra,
    suggestedExtra,
    start,
    comparison: toPay.length > 0 ? compareStrategies(toPay as Debt[], extra, start) : null,
  };
}

export function registerPlanRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/plan", async () => buildPlan(db));

  app.put("/api/plan/settings", async (request) => {
    const patch = parse(planSettingsSchema, request.body);
    const current = getPlanSettings(db);
    let steps = current.steps;
    if (patch.steps) {
      const ids = patch.steps.map((s) => s.id);
      if (ids.length !== STEP_IDS.length || new Set(ids).size !== ids.length || !ids.every((id) => (STEP_IDS as readonly string[]).includes(id))) {
        throw badRequest("Send every step exactly once, in the new order.");
      }
      steps = patch.steps as PlanSettings["steps"];
    }
    setSetting(db, "plan", {
      steps,
      starterAmount: patch.starterAmount ?? current.starterAmount,
      highInterestApr: patch.highInterestApr ?? current.highInterestApr,
      emergencyMonths: patch.emergencyMonths === undefined ? current.emergencyMonths : patch.emergencyMonths,
      availableOverride: patch.availableOverride === undefined ? current.availableOverride : patch.availableOverride,
    });
    return buildPlan(db);
  });

  app.get("/api/goals", async () => goalsWithPlan(db));

  app.post("/api/goals", async (request, reply) => {
    const input = parse(goalInputSchema, request.body);
    const { p } = db.prepare("SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM goals WHERE kind = 'custom'").get() as { p: number };
    db.prepare("INSERT INTO goals (name, kind, target_amount, target_date, priority) VALUES (?, 'custom', ?, ?, ?)").run(
      input.name,
      input.targetAmount,
      input.targetDate,
      p,
    );
    return reply.code(201).send(goalsWithPlan(db));
  });

  app.patch("/api/goals/:id", async (request) => {
    const id = idParam(request.params);
    const goal = loadGoals(db).find((g) => g.id === id);
    if (!goal) throw notFound("Goal");
    const patch = parse(goalPatchSchema, request.body);
    if (goal.kind === "custom" && patch.targetAmount === null) throw badRequest("A goal needs a target amount.");
    db.prepare("UPDATE goals SET name = ?, target_amount = ?, target_date = ? WHERE id = ?").run(
      patch.name ?? goal.name,
      patch.targetAmount === undefined ? goal.target_amount : patch.targetAmount,
      goal.kind === "emergency" ? null : patch.targetDate === undefined ? goal.target_date : patch.targetDate,
      id,
    );
    return goalsWithPlan(db);
  });

  app.delete("/api/goals/:id", async (request) => {
    const id = idParam(request.params);
    const goal = loadGoals(db).find((g) => g.id === id);
    if (!goal) throw notFound("Goal");
    if (goal.kind === "emergency") throw badRequest("The emergency fund is built in. Set its target instead.");
    db.prepare("DELETE FROM goals WHERE id = ?").run(id);
    return goalsWithPlan(db);
  });

  app.post("/api/goals/reorder", async (request) => {
    const { ids } = parse(goalReorderSchema, request.body);
    const custom = loadGoals(db).filter((g) => g.kind === "custom").map((g) => g.id);
    if (ids.length !== custom.length || new Set(ids).size !== ids.length || !ids.every((x) => custom.includes(x))) {
      throw badRequest("Send every goal id exactly once, in the new order.");
    }
    const stmt = db.prepare("UPDATE goals SET priority = ? WHERE id = ?");
    db.transaction(() => ids.forEach((x, i) => stmt.run(i + 1, x)))();
    return goalsWithPlan(db);
  });

  app.put("/api/goals/:id/allocations", async (request) => {
    const id = idParam(request.params);
    if (!loadGoals(db).some((g) => g.id === id)) throw notFound("Goal");
    const { items } = parse(goalAllocationsSchema, request.body);
    const accounts = new Set(listAccounts(db).map((a) => a.id));
    for (const item of items) if (!accounts.has(item.accountId)) throw badRequest("That account doesn't exist.");
    db.transaction(() => {
      db.prepare("DELETE FROM goal_allocations WHERE goal_id = ?").run(id);
      const insert = db.prepare("INSERT INTO goal_allocations (goal_id, account_id, amount) VALUES (?, ?, ?)");
      for (const item of items) if (item.amount > 0) insert.run(id, item.accountId, item.amount);
    })();
    return goalsWithPlan(db);
  });

  app.get("/api/debts", async (request) => {
    const { extra } = parse(debtQuerySchema, request.query);
    return debtsView(db, extra);
  });
}

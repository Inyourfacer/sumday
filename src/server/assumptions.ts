/**
 * Every assumption behind the recommendations, where it came from, and how
 * much the retirement answer depends on the ones that matter most.
 */
import type { FastifyInstance } from "fastify";
import { allocation } from "../engine/invest/portfolio.ts";
import { simulate } from "../engine/retire/montecarlo.ts";
import type { AssumptionRow, AssumptionsResponse } from "../shared/api.ts";
import { listAccounts } from "./accounts.ts";
import { getBudgetSettings, today } from "./budget.ts";
import { getSetting, type Db } from "./db.ts";
import { NO_CHANGE, withDials, type Dials } from "./explore.ts";
import { getTarget, loadHoldings, toPositions } from "./holdings.ts";
import { getHousehold, getPeople } from "./household.ts";
import { getPlanSettings, spendingBaseline } from "./plan.ts";
import { buildInput, getSettings } from "./retirement.ts";

// The sensitivity runs take a few seconds; the same inputs give the same answer, so remember it.
const sensitivityCache = new Map<string, AssumptionsResponse["sensitivity"]>();

const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

export function assumptions(db: Db): AssumptionsResponse {
  const now = today(db);
  const rows: AssumptionRow[] = [];
  const add = (r: AssumptionRow) => rows.push(r);
  const household = getHousehold(db);
  const people = getPeople(db);
  const budget = getBudgetSettings(db);
  const baseline = spendingBaseline(db, now);
  const plan = getPlanSettings(db);
  const storedPlan = getSetting<Record<string, unknown>>(db, "plan") ?? {};
  const storedRet = getSetting<Record<string, unknown>>(db, "retirement") ?? {};
  const retirement = getSettings(db);
  const set = (stored: Record<string, unknown>, key: string): "you" | "default" => (stored[key] !== undefined ? "you" : "default");

  // Cash flow
  add({
    area: "Cash flow",
    label: "Expected monthly income",
    value: budget.expectedIncome === null ? "Not set" : usd(budget.expectedIncome),
    source: budget.expectedIncome === null ? "missing" : "you",
    note: budget.expectedIncome === null ? "Without it there is no amount to allocate." : undefined,
    link: "/budget",
  });
  add({
    area: "Cash flow",
    label: "Spending baseline",
    value: baseline.months.length === 0 ? "No data" : `Average of ${baseline.months.length} complete month${baseline.months.length === 1 ? "" : "s"}`,
    source: baseline.months.length === 0 ? "missing" : "estimated",
    note:
      baseline.months.length < 3
        ? "Fewer than 3 months of data: the amount available to invest is a rough guess."
        : "A short average is sensitive to one trip or one annual bill. See the range on Next best moves.",
    link: "/transactions",
  });

  // Plan
  add({ area: "Plan", label: "Starter emergency fund", value: usd(plan.starterAmount), source: set(storedPlan, "starterAmount"), link: "/plan" });
  add({ area: "Plan", label: "High-interest debt starts at", value: `${plan.highInterestApr}% APR`, source: set(storedPlan, "highInterestApr"), link: "/plan" });
  add({
    area: "Plan",
    label: "Emergency fund size",
    value: plan.emergencyMonths === null ? "Automatic (3 months with two earners, 6 with one)" : `${plan.emergencyMonths} months of essentials`,
    source: plan.emergencyMonths === null ? "default" : "you",
    note: "Does not adjust for job stability, dependents or insurance.",
    link: "/plan",
  });
  add({
    area: "Plan",
    label: "Marginal tax rate",
    value: plan.marginalTaxPct === null ? "Not set: pre-tax 401(k) dollars are treated as take-home dollars" : `${plan.marginalTaxPct}%`,
    source: plan.marginalTaxPct === null ? "default" : "you",
    link: "/plan",
  });

  // Debt
  const accounts = listAccounts(db).filter((a) => !a.isClosed);
  for (const a of accounts.filter((x) => x.isLiability && x.balance < 0 && !x.paysInFull)) {
    if (a.interestRatePct === null) {
      add({ area: "Debt", label: `${a.name}: interest rate`, value: "Missing", source: "missing", note: "It can't be ranked for payoff without a rate.", link: `/accounts/${a.id}` });
    }
    if (a.minimumPayment === null) {
      add({ area: "Debt", label: `${a.name}: minimum payment`, value: "Assumed 2% of the balance (at least $25)", source: "estimated", link: `/accounts/${a.id}` });
    }
  }

  // Investments
  const { target, isDefault } = getTarget(db);
  add({
    area: "Investments",
    label: "Target allocation",
    value: Object.entries(target)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([k, v]) => `${Math.round((v ?? 0) * 100)}% ${k.replace("_", " ")}`)
      .join(", "),
    source: isDefault ? "default" : "you",
    note: "One mix for the whole household at every age. Retirement projections use this, not what you hold today.",
    link: "/investments",
  });
  const positions = toPositions(loadHoldings(db));
  if (positions.length > 0) {
    const alloc = allocation(positions);
    if (alloc.unclassified > 0) {
      add({ area: "Investments", label: "Funds without an asset class", value: usd(alloc.unclassified), source: "guess", note: "Left out of allocation checks until you set their mix.", link: "/investments" });
    }
    const unknownFees = positions.filter((p) => p.expenseRatio === null).reduce((s, p) => s + p.value, 0);
    if (unknownFees > 0) {
      add({ area: "Investments", label: "Funds with no expense ratio", value: usd(unknownFees), source: "missing", note: "Counted as free in the fee estimate.", link: "/investments" });
    }
  }

  // Retirement
  add({ area: "Retirement", label: "Chance of success to aim for", value: `${Math.round(retirement.successTarget * 100)}%`, source: set(storedRet, "successTarget"), link: "/retirement" });
  add({ area: "Retirement", label: "Tax on pre-tax withdrawals", value: `${retirement.ordinaryTaxPct}% flat`, source: set(storedRet, "ordinaryTaxPct"), note: "No brackets, no Social Security taxation, no state tax.", link: "/retirement" });
  add({ area: "Retirement", label: "Tax on investment gains", value: `${retirement.capitalGainsPct}% flat`, source: set(storedRet, "capitalGainsPct"), link: "/retirement" });
  add({
    area: "Retirement",
    label: "Returns",
    value: `US stocks, 10-year Treasuries and T-bills, 1928–2025${retirement.returnHaircutPct ? `, minus ${retirement.returnHaircutPct} point a year` : ""}`,
    source: "default",
    note: "International stocks use the US series. History is short and may not repeat.",
    link: "/retirement",
  });
  add({ area: "Retirement", label: "Planning horizon", value: `Age ${household.planningHorizonAge} for the youngest adult`, source: "you", note: "Fixed age; no survivor or longevity modeling.", link: "/settings/household" });
  for (const p of people) {
    add({ area: "Retirement", label: `${p.name}: retirement age`, value: String(p.retirementAge), source: "you", link: "/settings/household" });
    const ss = p.socialSecurity;
    const hasSs = ss.at62 !== null || ss.atFra !== null || ss.at70 !== null;
    add({
      area: "Retirement",
      label: `${p.name}: Social Security`,
      value: hasSs ? `Claim at ${p.ssClaimAge}` : "No estimate entered",
      source: hasSs ? "you" : "missing",
      note: hasSs ? "Paid in full for life; no spousal or survivor benefits modeled." : "Counted as zero.",
      link: "/settings/household",
    });
    if ((p.income ?? 0) > 0) add({ area: "Retirement", label: `${p.name}: pay raises`, value: `${p.raisePct}% a year`, source: "you", link: "/settings/household" });
  }

  // How much the answer depends on each lever.
  const { built } = buildInput(db, retirement);
  let sensitivity: AssumptionsResponse["sensitivity"] = [];
  const cacheKey = built ? JSON.stringify({ ...built.input, history: undefined, rmd: undefined }) : "";
  const cachedSensitivity = sensitivityCache.get(cacheKey);
  if (built && cachedSensitivity) sensitivity = cachedSensitivity;
  else if (built) {
    const dial = (o: Partial<Dials>) => withDials(built.input, { ...NO_CHANGE, ...o });
    const rate = (i: ReturnType<typeof dial>) => simulate(i, { bands: false }).successRate;
    const base = rate(dial({}));
    const variants: { label: string; input: ReturnType<typeof dial> }[] = [
      { label: "Retire 2 years later", input: dial({ retireShiftYears: 2 }) },
      { label: "Retire 2 years earlier", input: dial({ retireShiftYears: -2 }) },
      { label: "Spend 10% less in retirement", input: dial({ spendingPct: 90 }) },
      { label: "Spend 10% more in retirement", input: dial({ spendingPct: 110 }) },
      { label: "Save $500 a month more", input: dial({ extraMonthly: 50_000 }) },
      { label: "Returns 1 point a year lower", input: { ...dial({}), returnHaircutPct: (built.input.returnHaircutPct ?? 0) + 1 } },
      { label: "Tax on pre-tax withdrawals 5 points higher", input: { ...dial({}), taxes: { ...built.input.taxes, ordinaryPct: built.input.taxes.ordinaryPct + 5 } } },
    ];
    sensitivity = variants
      .map((v) => ({ label: v.label, successPoints: Math.round((rate(v.input) - base) * 1000) / 10 }))
      .sort((a, b) => Math.abs(b.successPoints) - Math.abs(a.successPoints));
    sensitivityCache.set(cacheKey, sensitivity);
    if (sensitivityCache.size > 4) sensitivityCache.delete(sensitivityCache.keys().next().value!);
  }
  return { rows, sensitivity };
}

export function registerAssumptionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/assumptions", async () => assumptions(db));
}

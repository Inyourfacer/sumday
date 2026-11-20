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
    note:
      retirement.allocationSource === "actual"
        ? "One mix for the whole household at every age. The retirement projection is using what you hold today instead."
        : "One mix for the whole household at every age. The retirement projection uses this, not what you hold today (you can switch that on the Retirement page).",
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
  if (retirement.taxMode === "brackets") {
    add({
      area: "Retirement",
      label: "Taxes in retirement",
      value: `Federal brackets for ${household.filingStatus.replace("_", " ")}, state ${retirement.stateTaxPct}%`,
      source: set(storedRet, "taxMode"),
      note: "Tax tables are for 2026 and treated as indexed to inflation. Medicare surcharges (IRMAA) are added from 65, set by income two years back; the tier amounts are not yet checked against cms.gov. No extra deduction at 65+, no tax on dividends while saving. State tax is one flat rate you set.",
      link: "/retirement",
    });
  } else {
    add({ area: "Retirement", label: "Tax on pre-tax withdrawals", value: `${retirement.ordinaryTaxPct}% flat`, source: set(storedRet, "ordinaryTaxPct"), note: "A flat rate over-taxes modest spending and under-taxes big spending. Switch to brackets for a closer answer.", link: "/retirement" });
    add({ area: "Retirement", label: "Tax on investment gains", value: `${retirement.capitalGainsPct}% flat`, source: set(storedRet, "capitalGainsPct"), link: "/retirement" });
  }
  add({
    area: "Retirement",
    label: "Returns",
    value: `US stocks, 10-year Treasuries and T-bills, 1928–2025${retirement.returnHaircutPct ? `, minus ${retirement.returnHaircutPct} point a year` : ""}`,
    source: "default",
    note: "International stocks use the US series. History is short and may not repeat.",
    link: "/retirement",
  });
  if (retirement.longevity === "modeled") {
    add({
      area: "Retirement",
      label: "How long you live",
      value: `Drawn at random: most common age at death ${retirement.lifeMode}, spread ${retirement.lifeSpread} years`,
      source: set(storedRet, "lifeMode"),
      note: "A smooth curve, not a life table, with no adjustment for health, sex or family history. The chart still ends at the planning age.",
      link: "/retirement",
    });
    if (people.length > 1) {
      add({
        area: "Retirement",
        label: "After one of you dies",
        value: `Spending ${retirement.survivorSpendingPct}% of plan; the survivor keeps the larger Social Security benefit and files single the next year`,
        source: set(storedRet, "survivorSpendingPct"),
        note: "Pensions stop and pre-tax money moves to the survivor. No life insurance.",
        link: "/retirement",
      });
    }
  } else {
    add({ area: "Retirement", label: "Planning horizon", value: `Age ${household.planningHorizonAge} for the youngest adult`, source: "you", note: "Fixed age; lifespans are not drawn at random.", link: "/settings/household" });
  }
  add({
    area: "Retirement",
    label: "Spending rule",
    value: retirement.guardrails.enabled
      ? `Guardrails: cut ${retirement.guardrails.adjustPct}% when the withdrawal rate rises ${retirement.guardrails.upperPct}%, floor ${retirement.guardrails.floorPct}% of plan`
      : "Same spending every year, whatever markets do",
    source: set(storedRet, "guardrails"),
    note: retirement.guardrails.enabled ? "The chance it lasts counts the cuts as acceptable. See how often they happen on Retirement." : "Real people cut back after bad years, so this is conservative.",
    link: "/retirement",
  });
  add({
    area: "Retirement",
    label: "Roth conversions",
    value: retirement.rothConversionRatePct > 0 ? `Fill the ${retirement.rothConversionRatePct}% bracket each year until required minimums start` : "None",
    source: set(storedRet, "rothConversionRatePct"),
    note: "Tax on conversions is paid from taxable savings. Not modeled: state-specific rules, ACA subsidy loss, converting while still working.",
    link: "/retirement",
  });
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
      ...(built.input.mortality ? [{ label: "Living 5 years longer", input: { ...dial({}), mortality: { ...built.input.mortality, mode: built.input.mortality.mode + 5 } } }] : []),
      built.input.taxes.brackets
        ? { label: "State income tax 3 points higher", input: { ...dial({}), taxes: { ...built.input.taxes, brackets: { ...built.input.taxes.brackets, statePct: built.input.taxes.brackets.statePct + 3 } } } }
        : { label: "Tax on pre-tax withdrawals 5 points higher", input: { ...dial({}), taxes: { ...built.input.taxes, ordinaryPct: built.input.taxes.ordinaryPct + 5 } } },
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

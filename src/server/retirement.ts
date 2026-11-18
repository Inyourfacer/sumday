import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { parseIsoDate } from "../engine/dates.ts";
import { fees } from "../engine/invest/portfolio.ts";
import { historicalReplay, simulate, whatIfs, type HistoricalYear, type SimInput, type SimResult, type WhatIfs } from "../engine/retire/montecarlo.ts";
import { benefitAtClaim, rmdStartAge, type RmdTable } from "../engine/retire/rules.ts";
import { spendingAtAge, type SpendingPlan } from "../engine/retire/spending.ts";
import { applyOverrides, describeOverride, type Override } from "../engine/retire/overrides.ts";
import type { ClaimingResponse, RetirementResponse } from "../shared/api.ts";
import { retirementSettingsSchema } from "../shared/schemas.ts";
import { listAccounts } from "./accounts.ts";
import { today } from "./budget.ts";
import { getSetting, setSetting, type Db } from "./db.ts";
import { PORTFOLIO_TYPES, getTarget, loadHoldings, toPositions } from "./holdings.ts";
import { getHousehold, getPeople } from "./household.ts";
import { parse } from "./http.ts";
import { buildPlan, spendingBaseline } from "./plan.ts";
import type { Recommendation } from "../engine/plan/waterfall.ts";

const RETURNS = JSON.parse(readFileSync(new URL("../../data/returns/us-annual.json", import.meta.url), "utf8")) as {
  source: string;
  years: HistoricalYear[];
};
const RMD = JSON.parse(readFileSync(new URL("../../data/rmd/uniform-lifetime.json", import.meta.url), "utf8")) as RmdTable & { source: string };

interface StoredSettings {
  successTarget: number;
  ordinaryTaxPct: number;
  capitalGainsPct: number;
  runs: number;
  blockLength: number;
  /** Percentage points taken off stock and bond returns, to test a worse future than history. */
  returnHaircutPct: number;
  includePlanSavings: boolean;
  spending: { categoryOverrides: Record<string, number | null>; items: SpendingPlan["items"]; oneOffs: SpendingPlan["oneOffs"] };
  /** Changes promoted from scenarios (extra savings, spending changes, one-time amounts, a home). */
  events: Override[];
}

const DEFAULTS: StoredSettings = {
  successTarget: 0.85,
  ordinaryTaxPct: 15,
  capitalGainsPct: 15,
  runs: 10_000,
  blockLength: 5,
  returnHaircutPct: 0,
  includePlanSavings: true,
  spending: { categoryOverrides: {}, items: [], oneOffs: [] },
  events: [],
};

export function getSettings(db: Db): StoredSettings {
  const stored = getSetting<Partial<StoredSettings>>(db, "retirement") ?? {};
  return { ...DEFAULTS, ...stored, spending: { ...DEFAULTS.spending, ...stored.spending } };
}

/** Share of the calendar year still to come, counting today (Jan 1 = 1, Dec 31 = 1/365). */
export function shareOfYearLeft(now: string): number {
  const { year, month, day } = parseIsoDate(now);
  const start = Date.UTC(year, 0, 1);
  const length = (Date.UTC(year + 1, 0, 1) - start) / 86_400_000;
  const elapsed = (Date.UTC(year, month - 1, day) - start) / 86_400_000;
  return (length - elapsed) / length;
}

export type ExtraSavings = SimInput["extraSavings"];

export function emptySavings(): ExtraSavings {
  return { taxable: 0, roth: 0, hsa: 0, traditional: {} };
}

/** Yearly money one recommendation puts into each kind of account. */
export function savingsOf(r: Recommendation): ExtraSavings {
  const out = emptySavings();
  if (r.amount <= 0) return out;
  // What lands in the account: a pre-tax payroll step costs less take-home pay than it deposits.
  const yearly = (r.contribution ?? r.amount) * 12;
  if (r.step === "ira") out.roth = yearly;
  else if (r.step === "taxable") out.taxable = yearly;
  else if (r.step === "hsa") out.hsa = yearly;
  else if ((r.step === "max_workplace" || r.step === "employer_match") && r.subject?.kind === "person") {
    out.traditional[r.subject.id] = yearly;
    // The employer match earned by raising the contribution is part of the plan's value too.
    if (r.step === "employer_match") {
      const match = r.facts.find((f) => f.label === "Extra employer money per year");
      if (match && typeof match.value === "number") out.traditional[r.subject.id]! += match.value;
    }
  }
  return out;
}

export function addSavings(into: ExtraSavings, add: ExtraSavings, sign = 1): void {
  into.taxable += sign * add.taxable;
  into.roth += sign * add.roth;
  into.hsa += sign * add.hsa;
  for (const [id, v] of Object.entries(add.traditional)) into.traditional[Number(id)] = (into.traditional[Number(id)] ?? 0) + sign * v;
}

export interface Built {
  input: SimInput;
  view: NonNullable<RetirementResponse["inputs"]>;
}

/** Gather everything the simulation needs from the household, accounts, budget and plan. */
export function buildInput(db: Db, settings: StoredSettings): { built: Built | null; missing: string[] } {
  const now = today(db);
  const startYear = parseIsoDate(now).year;
  const household = getHousehold(db);
  const people = getPeople(db);
  const missing: string[] = [];
  if (people.length === 0) missing.push("Add the adults in your household (Settings → Household).");
  for (const p of people) if (p.birthDate === null) missing.push(`Add ${p.name}'s birth date.`);
  const accounts = listAccounts(db).filter((a) => !a.isClosed && PORTFOLIO_TYPES.includes(a.type));
  if (missing.length > 0) return { built: null, missing };

  const simPeople = people.map((p) => {
    const birthYear = parseIsoDate(p.birthDate!).year;
    return {
      id: p.id,
      name: p.name,
      birthYear,
      retirementAge: p.retirementAge,
      income: p.income ?? 0,
      raisePct: p.raisePct,
      pretaxPct: p.employerPlan.type === "none" ? 0 : p.employerPlan.pretaxPct,
      rothPct: p.employerPlan.type === "none" ? 0 : p.employerPlan.rothPct,
      matchTiers: p.employerPlan.type === "none" ? [] : p.employerPlan.matchTiers,
      hsaPayroll: p.employerPlan.hsaPayrollAnnual,
      socialSecurity: benefitAtClaim(p.socialSecurity, p.ssClaimAge, birthYear),
      claimAge: p.ssClaimAge,
      pension: p.pension,
      rmdStartAge: rmdStartAge(RMD, birthYear),
    };
  });
  const primary = simPeople[0]!;

  // Starting money by tax treatment. Cash accounts (the emergency fund) are left out.
  const balances = { taxable: 0, taxableBasis: 0, roth: 0, hsa: 0, traditional: {} as Record<number, number> };
  const holdings = loadHoldings(db);
  for (const a of accounts) {
    const value = Math.max(0, a.balance);
    if (a.taxTreatment === "taxable") {
      balances.taxable += value;
      const hs = holdings.filter((h) => h.account_id === a.id);
      const known = hs.filter((h) => h.cost_basis !== null && h.price !== null);
      const knownValue = known.reduce((s, h) => s + Math.round(h.shares * h.price! * 100), 0);
      const knownBasis = known.reduce((s, h) => s + h.cost_basis!, 0);
      // Unknown basis counts as no gain.
      balances.taxableBasis += knownBasis + Math.max(0, value - knownValue);
    } else if (a.taxTreatment === "roth") balances.roth += value;
    else if (a.taxTreatment === "hsa") balances.hsa += value;
    else {
      const owner = a.ownerPersonId ?? primary.id;
      balances.traditional[owner] = (balances.traditional[owner] ?? 0) + value;
    }
  }

  const { target } = getTarget(db);
  const stocks = (target.us_stock ?? 0) + (target.intl_stock ?? 0) + (target.real_estate ?? 0) + (target.other ?? 0);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const allocation = { stocks: round(stocks), bonds: round(target.bonds ?? 0), cash: round(target.cash ?? 0) };
  const feePct = fees(toPositions(holdings)).weighted ?? 0;

  // Savings the plan recommends each month, while anyone is still working.
  const extraSavings = emptySavings();
  if (settings.includePlanSavings) {
    for (const r of buildPlan(db).result.recommendations) addSavings(extraSavings, savingsOf(r));
  }

  // Retirement spending from today's budget.
  const baseline = spendingBaseline(db, now);
  const names = new Map((db.prepare("SELECT id, name FROM categories").all() as { id: number; name: string }[]).map((c) => [c.id, c.name]));
  const plan: SpendingPlan = {
    categories: [...baseline.byCategory]
      .filter(([, monthly]) => monthly > 0)
      .map(([id, monthly]) => ({
        categoryId: id,
        name: names.get(id) ?? "",
        current: monthly * 12,
        retirement: settings.spending.categoryOverrides[String(id)] ?? null,
      }))
      .sort((a, b) => b.current - a.current),
    items: settings.spending.items,
    oneOffs: settings.spending.oneOffs,
  };
  const endYear = Math.max(...simPeople.map((p) => p.birthYear + household.planningHorizonAge));
  const spending = Array.from({ length: endYear - startYear + 1 }, (_, t) => spendingAtAge(plan, startYear + t - primary.birthYear));
  // Regular yearly spending when retirement starts, without one-off costs.
  const ongoingAtRetirement = (retireYear: number) => spendingAtAge({ ...plan, oneOffs: [] }, retireYear - primary.birthYear);

  const raw: SimInput = {
    startYear,
    yearFraction: shareOfYearLeft(now),
    endYear,
    people: simPeople,
    balances,
    allocation,
    feePct,
    extraSavings,
    spending,
    taxes: { ordinaryPct: settings.ordinaryTaxPct, capitalGainsPct: settings.capitalGainsPct },
    history: RETURNS.years,
    rmd: RMD,
    runs: settings.runs,
    blockLength: settings.blockLength,
    returnHaircutPct: settings.returnHaircutPct,
    seed: 20_260_101,
  };
  // Events promoted from scenarios apply on top of the plan.
  const input = applyOverrides(raw, settings.events);
  const ongoingInput = applyOverrides({ ...raw, spending: raw.spending.map((_, t) => ongoingAtRetirement(startYear + t)) }, settings.events);
  const workers = simPeople.filter((p) => p.income > 0);
  const retireYear = workers.length ? Math.max(startYear, ...workers.map((p) => p.birthYear + p.retirementAge)) : startYear;
  const traditional = Object.values(balances.traditional).reduce((s, v) => s + v, 0);
  return {
    missing: [],
    built: {
      input,
      view: {
        startYear,
        endYear,
        retireYear,
        people: simPeople.map((p) => ({
          id: p.id,
          name: p.name,
          birthYear: p.birthYear,
          retirementAge: p.retirementAge,
          claimAge: p.claimAge,
          socialSecurityMonthly: p.socialSecurity,
          pension: p.pension,
          rmdStartAge: p.rmdStartAge,
        })),
        balances: { taxable: balances.taxable, traditional, roth: balances.roth, hsa: balances.hsa, total: balances.taxable + traditional + balances.roth + balances.hsa },
        allocation,
        feePct,
        extraSavings: {
          total: extraSavings.taxable + extraSavings.roth + extraSavings.hsa + Object.values(extraSavings.traditional).reduce((s, v) => s + v, 0),
          fromPlan: settings.includePlanSavings,
        },
        spending: { ...plan, firstYear: ongoingInput.spending[Math.max(0, retireYear - startYear)] ?? 0 },
      },
    },
  };
}

/** Runs behind each what-if answer; fewer than the headline for speed, so they are labelled approximate. */
const WHAT_IF_RUNS = 3000;

// Results are cached by their exact inputs: the same question gets the same (seeded) answer.
interface Cached {
  result: SimResult;
  whatIfs: WhatIfs | null;
  checks: NonNullable<RetirementResponse["checks"]>;
}
const cache = new Map<string, Cached>();
function cached(key: string, run: () => Cached) {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = run();
  cache.set(key, value);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return value;
}

export function retirement(db: Db): RetirementResponse {
  const settings = getSettings(db);
  const { built, missing } = buildInput(db, settings);
  const sources = {
    returns: RETURNS.source,
    returnsYears: `${RETURNS.years[0]!.year}–${RETURNS.years.at(-1)!.year}`,
    rmd: RMD.source,
  };
  const publicSettings = {
    successTarget: settings.successTarget,
    ordinaryTaxPct: settings.ordinaryTaxPct,
    capitalGainsPct: settings.capitalGainsPct,
    runs: settings.runs,
    blockLength: settings.blockLength,
    returnHaircutPct: settings.returnHaircutPct,
    includePlanSavings: settings.includePlanSavings,
  };
  const who = new Map(getPeople(db).map((p) => [p.id, p.name]));
  const events = settings.events.map((o) => describeOverride(o, who));
  if (!built) return { ready: false, missing, settings: publicSettings, inputs: null, events, result: null, whatIfs: null, checks: null, sources };
  const key = JSON.stringify({ i: { ...built.input, history: undefined, rmd: undefined }, t: settings.successTarget, w: true });
  const { result, whatIfs: w, checks } = cached(key, () => {
    const result = simulate(built.input);
    // Two other ways to look at the same plan, so one method's quirks don't decide the answer.
    const stressPoints = 1;
    const stress = simulate({ ...built.input, returnHaircutPct: (built.input.returnHaircutPct ?? 0) + stressPoints }, { bands: false });
    const replay = historicalReplay(built.input);
    return {
      result,
      whatIfs: whatIfs(built.input, settings.successTarget, result, WHAT_IF_RUNS, built.view.spending.firstYear),
      checks: {
        stress: { haircutPct: stressPoints, successRate: stress.successRate },
        replay: { successRate: replay.successRate, startYears: replay.cohorts.length },
        whatIfRuns: WHAT_IF_RUNS,
      },
    };
  });
  return { ready: true, missing: [], settings: publicSettings, inputs: built.view, events, result, whatIfs: w, checks, sources };
}

/**
 * For each person with Social Security estimates: the chance the money lasts
 * if they claim at each age from 62 to 70, everything else unchanged. Same
 * seed for every age, so the differences come from the claim age alone.
 */
export function claiming(db: Db): ClaimingResponse {
  const settings = getSettings(db);
  const { built } = buildInput(db, settings);
  if (!built) return { ready: false, people: [] };
  const people = getPeople(db);
  const out: ClaimingResponse["people"] = [];
  built.input.people.forEach((sp, k) => {
    const person = people.find((p) => p.id === sp.id);
    if (!person || benefitAtClaim(person.socialSecurity, person.ssClaimAge, sp.birthYear) === null) return;
    const options = [];
    for (let age = 62; age <= 70; age++) {
      const monthly = benefitAtClaim(person.socialSecurity, age, sp.birthYear)!;
      const simPeople = built.input.people.map((x, i) => (i === k ? { ...x, socialSecurity: monthly, claimAge: age } : x));
      const r = simulate({ ...built.input, people: simPeople, runs: 3000 }, { bands: false });
      options.push({ age, monthly, successRate: r.successRate, medianAtEnd: r.medianAtEnd });
    }
    out.push({ id: sp.id, name: person.name, planned: person.ssClaimAge, options });
  });
  return { ready: true, people: out };
}

export function registerRetirementRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/retirement", async () => retirement(db));
  app.get("/api/retirement/claiming", async () => claiming(db));

  app.put("/api/retirement/settings", async (request) => {
    const patch = parse(retirementSettingsSchema, request.body);
    const current = getSettings(db);
    setSetting(db, "retirement", {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      spending: patch.spending ?? current.spending,
    });
    return retirement(db);
  });
}

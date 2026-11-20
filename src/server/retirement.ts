import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { parseIsoDate } from "../engine/dates.ts";
import { allocation as portfolioAllocation, fees } from "../engine/invest/portfolio.ts";
import { historicalReplay, simulate, whatIfs, type HistoricalYear, type SimInput, type SimResult, type WhatIfs } from "../engine/retire/montecarlo.ts";
import { DEFAULT_MORTALITY } from "../engine/retire/longevity.ts";
import type { TaxTable } from "../engine/retire/tax.ts";
import { benefitAtClaim, rmdStartAge, type RmdTable } from "../engine/retire/rules.ts";
import { spendingAtAge, type SpendingPlan } from "../engine/retire/spending.ts";
import { applyOverrides, describeOverride, type Override } from "../engine/retire/overrides.ts";
import type { ClaimingResponse, ConversionsResponse, RetirementResponse } from "../shared/api.ts";
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
const TAX = JSON.parse(readFileSync(new URL("../../data/tax/2026.json", import.meta.url), "utf8")) as TaxTable;
const RMD = JSON.parse(readFileSync(new URL("../../data/rmd/uniform-lifetime.json", import.meta.url), "utf8")) as RmdTable & { source: string };

interface StoredSettings {
  successTarget: number;
  /** brackets = the tax code (deduction, brackets, gains, Social Security); flat = the two rates below. */
  taxMode: "brackets" | "flat";
  /** Flat state income tax in the bracket model, percent. */
  stateTaxPct: number;
  ordinaryTaxPct: number;
  capitalGainsPct: number;
  runs: number;
  blockLength: number;
  /** Percentage points taken off stock and bond returns, to test a worse future than history. */
  returnHaircutPct: number;
  /** target = the mix you aim for, rebalanced yearly; actual = the mix of what you hold today, kept as is. */
  allocationSource: "target" | "actual";
  includePlanSavings: boolean;
  /** modeled = each person's death is drawn at random (Gompertz); fixed = plan to the household planning age. */
  longevity: "modeled" | "fixed";
  lifeMode: number;
  lifeSpread: number;
  survivorSpendingPct: number;
  guardrails: { enabled: boolean; upperPct: number; lowerPct: number; adjustPct: number; floorPct: number };
  /** Fill this tax bracket with Roth conversions before required minimums begin; 0 = no conversions. */
  rothConversionRatePct: number;
  spending: { categoryOverrides: Record<string, number | null>; items: SpendingPlan["items"]; oneOffs: SpendingPlan["oneOffs"] };
  /** Changes promoted from scenarios (extra savings, spending changes, one-time amounts, a home). */
  events: Override[];
}

const DEFAULTS: StoredSettings = {
  successTarget: 0.85,
  taxMode: "brackets",
  stateTaxPct: 0,
  ordinaryTaxPct: 15,
  capitalGainsPct: 15,
  runs: 10_000,
  blockLength: 5,
  returnHaircutPct: 0,
  allocationSource: "target",
  includePlanSavings: true,
  longevity: "modeled",
  lifeMode: DEFAULT_MORTALITY.mode,
  lifeSpread: DEFAULT_MORTALITY.dispersion,
  survivorSpendingPct: DEFAULT_MORTALITY.survivorSpendingPct,
  guardrails: { enabled: false, upperPct: 20, lowerPct: 20, adjustPct: 10, floorPct: 75 },
  rothConversionRatePct: 0,
  spending: { categoryOverrides: {}, items: [], oneOffs: [] },
  events: [],
};

export function getSettings(db: Db): StoredSettings {
  const stored = getSetting<Partial<StoredSettings>>(db, "retirement") ?? {};
  return { ...DEFAULTS, ...stored, guardrails: { ...DEFAULTS.guardrails, ...stored.guardrails }, spending: { ...DEFAULTS.spending, ...stored.spending } };
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

/** The plan to a fixed end year, with no lifespans drawn. */
function withoutLifespans(input: SimInput, endYear: number): SimInput {
  const copy: SimInput = { ...input, endYear };
  delete copy.mortality;
  delete copy.displayEndYear;
  return copy;
}

export interface Built {
  input: SimInput;
  /** The same plan to the fixed planning age, with no lifespans drawn: for the historical replay and a comparison. */
  fixed: SimInput;
  /** Years conversions are tried in, if any are chosen. */
  conversionWindow: { from: number; to: number } | null;
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
  let allocation = { stocks: round(stocks), bonds: round(target.bonds ?? 0), cash: round(target.cash ?? 0) };
  if (settings.allocationSource === "actual") {
    // What is held today in the accounts the projection covers; unclassified funds are left out of the shares.
    const held = portfolioAllocation(toPositions(holdings.filter((h) => accounts.some((a) => a.id === h.account_id))));
    if (held.classified > 0) {
      const share = (...classes: (keyof typeof held.byClass)[]) => classes.reduce((s, c) => s + held.byClass[c], 0) / held.classified;
      allocation = { stocks: round(share("us_stock", "intl_stock", "real_estate", "other")), bonds: round(share("bonds")), cash: round(share("cash")) };
    }
  }
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
  const horizonEnd = Math.max(...simPeople.map((p) => p.birthYear + household.planningHorizonAge));
  const modeled = settings.longevity === "modeled";
  // With lifespans drawn, the run goes as far as anyone could live; the chart and "at the end" stay at the planning age.
  const endYear = modeled ? Math.max(horizonEnd, Math.max(...simPeople.map((p) => p.birthYear)) + DEFAULT_MORTALITY.maxAge) : horizonEnd;
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
    taxes: {
      ordinaryPct: settings.ordinaryTaxPct,
      capitalGainsPct: settings.capitalGainsPct,
      ...(settings.taxMode === "brackets" ? { brackets: { table: TAX, filing: household.filingStatus, statePct: settings.stateTaxPct } } : {}),
    },
    history: RETURNS.years,
    rmd: RMD,
    runs: settings.runs,
    blockLength: settings.blockLength,
    returnHaircutPct: settings.returnHaircutPct,
    displayEndYear: horizonEnd,
    seed: 20_260_101,
  };
  const brackets = settings.taxMode === "brackets";
  if (modeled) raw.mortality = { mode: settings.lifeMode, dispersion: settings.lifeSpread, maxAge: DEFAULT_MORTALITY.maxAge, survivorSpendingPct: settings.survivorSpendingPct };
  if (settings.guardrails.enabled) {
    const { upperPct, lowerPct, adjustPct, floorPct } = settings.guardrails;
    raw.guardrails = { upperPct, lowerPct, adjustPct, floorPct };
  }
  if (brackets) raw.medicare = true;
  const retireYearPlanned = (() => {
    const w = simPeople.filter((p) => p.income > 0);
    return w.length ? Math.max(startYear, ...w.map((p) => p.birthYear + p.retirementAge)) : startYear;
  })();
  // Conversions run from retirement until required minimums begin for the oldest person.
  const oldest = simPeople.reduce((a, b) => (b.birthYear < a.birthYear ? b : a));
  const window = { from: retireYearPlanned, to: oldest.birthYear + oldest.rmdStartAge - 1 };
  const conversionWindow = brackets && settings.rothConversionRatePct > 0 && window.to >= window.from ? window : null;
  if (conversionWindow) raw.conversion = { targetRatePct: settings.rothConversionRatePct, startYear: conversionWindow.from, endYear: conversionWindow.to };
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
      fixed: withoutLifespans(input, horizonEnd),
      conversionWindow,
      view: {
        startYear,
        endYear: horizonEnd,
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
    tax: TAX.source,
    medicare: TAX.irmaa?.source ?? null,
  };
  const publicSettings = {
    successTarget: settings.successTarget,
    taxMode: settings.taxMode,
    stateTaxPct: settings.stateTaxPct,
    ordinaryTaxPct: settings.ordinaryTaxPct,
    capitalGainsPct: settings.capitalGainsPct,
    runs: settings.runs,
    blockLength: settings.blockLength,
    returnHaircutPct: settings.returnHaircutPct,
    allocationSource: settings.allocationSource,
    includePlanSavings: settings.includePlanSavings,
    longevity: settings.longevity,
    lifeMode: settings.lifeMode,
    lifeSpread: settings.lifeSpread,
    survivorSpendingPct: settings.survivorSpendingPct,
    guardrails: settings.guardrails,
    rothConversionRatePct: settings.rothConversionRatePct,
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
    // History replay and the "everyone lives to the planning age" check use the fixed horizon.
    const replay = historicalReplay(built.fixed);
    const fixedHorizon = built.input.mortality ? simulate({ ...built.fixed, runs: WHAT_IF_RUNS }, { bands: false }).successRate : null;
    const { guardrails: _g, ...noRails } = built.input;
    const withoutGuardrails = built.input.guardrails ? simulate({ ...noRails, runs: WHAT_IF_RUNS }, { bands: false }).successRate : null;
    return {
      result,
      whatIfs: whatIfs(built.input, settings.successTarget, result, WHAT_IF_RUNS, built.view.spending.firstYear),
      checks: {
        stress: { haircutPct: stressPoints, successRate: stress.successRate },
        replay: { successRate: replay.successRate, startYears: replay.cohorts.length },
        whatIfRuns: WHAT_IF_RUNS,
        fixedHorizon: fixedHorizon === null ? null : { age: built.view.endYear - built.input.people.reduce((a, b) => (b.birthYear > a ? b.birthYear : a), 0), successRate: fixedHorizon },
        withoutGuardrails: withoutGuardrails === null ? null : { successRate: withoutGuardrails },
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

/**
 * Roth conversions: the same plan with no conversions and with each tax bracket filled
 * before required minimums begin. Same seed everywhere, so differences come from the choice.
 */
export function conversions(db: Db): ConversionsResponse {
  const settings = getSettings(db);
  if (settings.taxMode !== "brackets") return { ready: false, reason: "Conversions need the tax bracket model. Switch Taxes to brackets first." };
  const base = buildInput(db, { ...settings, rothConversionRatePct: 12 });
  if (!base.built) return { ready: false, reason: "Finish the household setup first." };
  if (!base.built.conversionWindow) return { ready: false, reason: "There are no years between retiring and required minimums to convert in." };
  const traditional = Object.values(base.built.input.balances.traditional).reduce((s, v) => s + v, 0);
  if (traditional <= 0) return { ready: false, reason: "No pre-tax savings to convert." };
  const options = [0, 12, 22, 24].map((ratePct) => {
    const built = buildInput(db, { ...settings, rothConversionRatePct: ratePct }).built!;
    const r = simulate({ ...built.input, runs: WHAT_IF_RUNS }, { bands: false });
    return {
      ratePct,
      successRate: r.successRate,
      medianConverted: ratePct === 0 ? 0 : r.medianConverted,
      medianLifetimeTax: r.medianLifetimeTax,
      medianMedicareSurcharge: r.medianMedicareSurcharge,
      medianEndAfterTax: r.medianEndAfterTax,
    };
  });
  return { ready: true, window: base.built.conversionWindow, chosen: settings.rothConversionRatePct, options };
}

export function registerRetirementRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/retirement", async () => retirement(db));
  app.get("/api/retirement/conversions", async () => conversions(db));
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

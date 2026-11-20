/**
 * How the tax rate on your next dollar now compares with what an extra pre-tax dollar will cost in retirement.
 * Feeds the Roth-or-pre-tax advice in Next best moves (DESIGN §8). The retirement side comes from the same
 * simulation as the Retirement page, run without the plan's own recommended savings so the two don't depend on each other.
 */
import { leanFor, type TaxView } from "../engine/plan/rothChoice.ts";
import { simulate } from "../engine/retire/montecarlo.ts";
import { marginalOrdinaryPct, totalDeduction } from "../engine/retire/tax.ts";
import { parseIsoDate } from "../engine/dates.ts";
import { today } from "./budget.ts";
import type { Db } from "./db.ts";
import { getHousehold, getPeople } from "./household.ts";
import { TAX, buildInput, getSettings } from "./retirement.ts";

const RUNS = 2000;

const cache = new Map<string, { median: number; low: number; high: number } | null>();

/** Expected tax rate on an extra pre-tax dollar in retirement, from the retirement simulation. Null when it can't run. */
function retirementRate(db: Db): { median: number; low: number; high: number } | null {
  const settings = getSettings(db);
  if (settings.taxMode !== "brackets") return null;
  const { built } = buildInput(db, { ...settings, includePlanSavings: false });
  if (!built) return null;
  const key = JSON.stringify({ ...built.input, history: undefined, rmd: undefined });
  if (cache.has(key)) return cache.get(key)!;
  const marginal = simulate({ ...built.input, runs: RUNS, trackMarginal: true }, { bands: false }).marginal;
  cache.set(key, marginal);
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
  return marginal;
}

/** The rate on your next dollar of income now: the one you entered, or the bracket your income reaches. */
function currentRate(db: Db, manualPct: number | null): { pct: number; basis: "you" | "income" } | null {
  if (manualPct !== null) return { pct: manualPct, basis: "you" };
  const people = getPeople(db);
  const income = people.reduce((s, p) => s + (p.income ?? 0), 0);
  if (income <= 0) return null;
  const household = getHousehold(db);
  const preTax = people.reduce(
    (s, p) => s + (p.employerPlan.type === "none" ? 0 : ((p.income ?? 0) * p.employerPlan.pretaxPct) / 100) + p.employerPlan.hsaPayrollAnnual,
    0,
  );
  const year = parseIsoDate(today(db)).year;
  const seniors = people.filter((p) => p.birthDate !== null && year - parseIsoDate(p.birthDate).year >= 65).length;
  const setup = { table: TAX, filing: household.filingStatus, statePct: 0, seniors, year };
  const taxable = Math.max(0, income - preTax - totalDeduction(setup, income - preTax));
  return { pct: marginalOrdinaryPct(TAX, household.filingStatus, taxable) + getSettings(db).stateTaxPct, basis: "income" };
}

export function estimateTaxView(db: Db, manualPct: number | null): TaxView {
  try {
    const now = currentRate(db, manualPct);
    const later = retirementRate(db);
    return {
      nowPct: now?.pct ?? null,
      nowBasis: now?.basis ?? null,
      retirementPct: later?.median ?? null,
      retirementRange: later ? [later.low, later.high] : null,
      lean: leanFor(now?.pct ?? null, later?.median ?? null),
    };
  } catch {
    return { nowPct: null, nowBasis: null, retirementPct: null, retirementRange: null, lean: null };
  }
}

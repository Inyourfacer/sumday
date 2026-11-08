/**
 * Monte Carlo retirement simulation (DESIGN §11.2).
 *
 * Each run replays history in random blocks: a year's stock, bond and
 * T-bill returns and inflation are drawn together from one real historical
 * year, so crashes, bond slumps and inflation spikes keep their real
 * company; blocks of consecutive years keep bad stretches together.
 *
 * Everything is in today's dollars: returns are made real by removing that
 * year's inflation. Social Security keeps up with inflation; a pension
 * without a cost-of-living adjustment loses value to it. Before retirement,
 * paychecks cover spending and contributions are added. In retirement the
 * spending gap is withdrawn: required minimums first, then taxable, pre-tax,
 * Roth and HSA money. A run fails if the money runs out before the planning
 * horizon.
 */
import { matchValue } from "../plan/waterfall.ts";
import { requiredMinimum, seededRandom, type RmdTable } from "./rules.ts";

export interface HistoricalYear {
  year: number;
  stocks: number;
  bonds: number;
  bills: number;
  inflation: number;
}

export interface SimPerson {
  id: number;
  birthYear: number;
  retirementAge: number;
  /** Gross yearly pay in today's dollars (0 if not working). */
  income: number;
  /** Expected yearly raise, in percent (nominal, like a pay slip). */
  raisePct: number;
  pretaxPct: number;
  rothPct: number;
  matchTiers: { matchPct: number; upToPct: number }[];
  hsaPayroll: number;
  /** Monthly Social Security at the planned claim age, today's dollars. */
  socialSecurity: number | null;
  claimAge: number;
  pension: { monthly: number; startAge: number; cola: boolean } | null;
  rmdStartAge: number;
}

export interface SimInput {
  startYear: number;
  /** Last year simulated (inclusive). */
  endYear: number;
  people: SimPerson[];
  balances: {
    taxable: number;
    /** What taxable holdings cost (for tax on gains). */
    taxableBasis: number;
    roth: number;
    hsa: number;
    /** Pre-tax money, per owner (for required minimums). */
    traditional: Record<number, number>;
  };
  allocation: { stocks: number; bonds: number; cash: number };
  /** Yearly fund costs in percent. */
  feePct: number;
  /** Extra savings each year while anyone is still working (e.g. from Next best moves). */
  extraSavings: { taxable: number; roth: number; hsa: number; traditional: Record<number, number> };
  /** Retirement spending for each simulated year (index 0 = startYear), today's dollars. */
  spending: number[];
  taxes: { ordinaryPct: number; capitalGainsPct: number };
  history: readonly HistoricalYear[];
  rmd: RmdTable;
  runs: number;
  blockLength: number;
  seed: number;
}

export interface YearBand {
  year: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface SimResult {
  runs: number;
  successRate: number;
  /** Year withdrawals begin: when everyone with a paycheck has retired. */
  retireYear: number;
  bands: YearBand[];
  /** Median portfolio when retirement starts and at the end. */
  medianAtRetirement: number;
  medianAtEnd: number;
  /** Of failed runs, the median year the money ran out. */
  medianDepletionYear: number | null;
  failedRuns: number;
}

/** When spending starts: the year the last person with a paycheck retires (or this year if nobody works). */
export function retirementYear(input: Pick<SimInput, "people" | "startYear">): number {
  const workers = input.people.filter((p) => p.income > 0);
  if (workers.length === 0) return input.startYear;
  return Math.max(input.startYear, ...workers.map((p) => p.birthYear + p.retirementAge));
}

/** Indices into history for one run: circular blocks of consecutive years. */
function sequence(n: number, length: number, block: number, rand: () => number): number[] {
  const out: number[] = [];
  while (out.length < length) {
    const start = Math.floor(rand() * n);
    for (let k = 0; k < block && out.length < length; k++) out.push((start + k) % n);
  }
  return out;
}

interface PathOutcome {
  totals: Float64Array;
  depletedAt: number | null;
}

function runPath(input: SimInput, years: number[], retireYear: number): PathOutcome {
  const T = years.length;
  const totals = new Float64Array(T);
  const { allocation: a, taxes, people } = input;
  const n = people.length;
  const ord = taxes.ordinaryPct / 100;
  const cg = taxes.capitalGainsPct / 100;
  let taxable = input.balances.taxable;
  let basisNominal = input.balances.taxableBasis;
  let roth = input.balances.roth;
  let hsa = input.balances.hsa;
  // Pre-tax money per person (index-aligned with people); anyone not listed holds none.
  const trad = new Float64Array(n);
  const extraTrad = new Float64Array(n);
  people.forEach((p, k) => {
    trad[k] = input.balances.traditional[p.id] ?? 0;
    extraTrad[k] = input.extraSavings.traditional[p.id] ?? 0;
  });
  const pay = Float64Array.from(people, (p) => p.income);
  // The employer match is a fixed share of pay at a given contribution rate.
  const matchShare = people.map((p) => (p.income > 0 ? matchValue(1_000_000, p.matchTiers, p.pretaxPct + p.rothPct) / 1_000_000 : 0));
  const extra = input.extraSavings;
  let cumInfl = 1;
  let depletedAt: number | null = null;

  for (let t = 0; t < T; t++) {
    const year = input.startYear + t;
    const h = input.history[years[t]!]!;
    const infl1 = 1 + h.inflation;
    cumInfl *= infl1;
    if (depletedAt !== null) {
      totals[t] = 0;
      continue;
    }
    const growth =
      a.stocks * ((1 + h.stocks) / infl1 - 1) + a.bonds * ((1 + h.bonds) / infl1 - 1) + a.cash * ((1 + h.bills) / infl1 - 1) - input.feePct / 100;

    // Working years: contributions in.
    let anyoneWorking = false;
    for (let k = 0; k < n; k++) {
      const p = people[k]!;
      const income = pay[k]!;
      if (income > 0 && year - p.birthYear < p.retirementAge) {
        anyoneWorking = true;
        trad[k] = trad[k]! + income * (p.pretaxPct / 100) + income * matchShare[k]!;
        roth += income * (p.rothPct / 100);
        hsa += p.hsaPayroll;
        // Next year's pay: the raise, less this year's inflation.
        pay[k] = income * ((1 + p.raisePct / 100) / infl1);
      }
    }
    if (anyoneWorking) {
      taxable += extra.taxable;
      basisNominal += extra.taxable * cumInfl;
      roth += extra.roth;
      hsa += extra.hsa;
      for (let k = 0; k < n; k++) trad[k] = trad[k]! + extraTrad[k]!;
    }

    // Retirement: withdraw what income doesn't cover.
    if (year >= retireYear) {
      let need = input.spending[t] ?? 0;
      for (let k = 0; k < n; k++) {
        const p = people[k]!;
        const age = year - p.birthYear;
        if (p.socialSecurity !== null && age >= p.claimAge) need -= p.socialSecurity * 12;
        if (p.pension && age >= p.pension.startAge) need -= (p.pension.monthly * 12) / (p.pension.cola ? 1 : cumInfl);
      }

      // Required minimums come out whether needed or not; any extra is reinvested.
      for (let k = 0; k < n; k++) {
        const p = people[k]!;
        const age = year - p.birthYear;
        if (age < p.rmdStartAge || trad[k]! <= 0) continue;
        const rmd = Math.min(trad[k]!, requiredMinimum(input.rmd, age, Math.round(trad[k]!)));
        if (rmd <= 0) continue;
        trad[k] = trad[k]! - (rmd);
        const net = rmd * (1 - ord);
        if (net > need) {
          const surplus = net - Math.max(0, need);
          taxable += surplus;
          basisNominal += surplus * cumInfl;
          need = 0;
        } else need -= net;
      }

      if (need > 0 && taxable > 0) {
        const basisReal = Math.min(taxable, basisNominal / cumInfl);
        const gainShare = Math.max(0, 1 - basisReal / taxable);
        const gross = Math.min(taxable, need / (1 - gainShare * cg));
        basisNominal *= 1 - gross / taxable;
        taxable -= gross;
        need -= gross * (1 - gainShare * cg);
      }
      if (need > 0) {
        let tradTotal = 0;
        for (let k = 0; k < n; k++) tradTotal += trad[k]!;
        if (tradTotal > 0) {
          const gross = Math.min(tradTotal, need / (1 - ord));
          for (let k = 0; k < n; k++) trad[k] = trad[k]! - (gross * (trad[k]! / tradTotal));
          need -= gross * (1 - ord);
        }
      }
      if (need > 0) {
        const take = Math.min(roth, need);
        roth -= take;
        need -= take;
      }
      if (need > 0) {
        const take = Math.min(hsa, need);
        hsa -= take;
        need -= take;
      }
      if (need > 0.5) {
        depletedAt = year;
        totals[t] = 0;
        continue;
      }
    }

    // Growth for the year.
    const g = 1 + growth;
    taxable *= g;
    roth *= g;
    hsa *= g;
    let total = taxable + roth + hsa;
    for (let k = 0; k < n; k++) {
      trad[k] = trad[k]! * g;
      total += trad[k]!;
    }
    totals[t] = total;
  }
  return { totals, depletedAt };
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i]!;
}

export function simulate(input: SimInput, options: { bands?: boolean } = {}): SimResult {
  const T = Math.max(1, input.endYear - input.startYear + 1);
  const rand = seededRandom(input.seed);
  const retireYear = retirementYear(input);
  const wantBands = options.bands ?? true;
  const columns = wantBands ? Array.from({ length: T }, () => new Float64Array(input.runs)) : [];
  let successes = 0;
  const depletion: number[] = [];

  for (let r = 0; r < input.runs; r++) {
    const years = sequence(input.history.length, T, Math.max(1, input.blockLength), rand);
    const { totals, depletedAt } = runPath(input, years, retireYear);
    if (depletedAt === null) successes += 1;
    else depletion.push(depletedAt);
    if (wantBands) for (let t = 0; t < T; t++) columns[t]![r] = totals[t]!;
  }

  const bands: YearBand[] = columns.map((col, t) => {
    const sorted = col.slice().sort();
    return {
      year: input.startYear + t,
      p10: Math.round(percentile(sorted, 0.1)),
      p25: Math.round(percentile(sorted, 0.25)),
      p50: Math.round(percentile(sorted, 0.5)),
      p75: Math.round(percentile(sorted, 0.75)),
      p90: Math.round(percentile(sorted, 0.9)),
    };
  });
  depletion.sort((a, b) => a - b);
  const atRetire = bands.find((b) => b.year === retireYear) ?? bands[0];
  return {
    runs: input.runs,
    successRate: successes / input.runs,
    retireYear,
    bands,
    medianAtRetirement: atRetire?.p50 ?? 0,
    medianAtEnd: bands.at(-1)?.p50 ?? 0,
    medianDepletionYear: depletion.length ? depletion[Math.floor(depletion.length / 2)]! : null,
    failedRuns: depletion.length,
  };
}

/** Bisection on a monotonic "more is better" (or worse) knob. */
function solve(lo: number, hi: number, ok: (x: number) => boolean, steps: number, wantSmallestOk: boolean): number | null {
  if (wantSmallestOk) {
    if (!ok(hi)) return null;
    if (ok(lo)) return lo;
  } else {
    if (!ok(lo)) return null;
    if (ok(hi)) return hi;
  }
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid) === wantSmallestOk) hi = mid;
    else lo = mid;
  }
  return wantSmallestOk ? hi : lo;
}

export interface WhatIfs {
  /** Retirement spending (first retirement year, today's $) that meets the target. */
  sustainableSpending: number | null;
  /** Success by retirement age shift, −3…+3 years. */
  retireAt: { shift: number; ages: Record<number, number>; successRate: number }[];
  /** Smallest changes that reach the target (null when already there or out of reach). */
  toReachTarget: {
    extraMonthlySavings: number | null;
    retireLaterYears: number | null;
    spendLessPerYear: number | null;
  };
}

/**
 * The what-if questions, each answered with a smaller number of runs (same
 * seed, so comparisons are fair). `ongoingSpending` is the regular yearly
 * spending at retirement (without one-off costs), which the spending
 * answers are expressed in.
 */
export function whatIfs(input: SimInput, target: number, base: SimResult, runs = 1500, ongoingSpending?: number): WhatIfs {
  const quick = { ...input, runs };
  const rate = (i: SimInput) => simulate(i, { bands: false }).successRate;
  const retireYear = base.retireYear;
  const t0 = Math.max(0, retireYear - input.startYear);
  const firstSpend = ongoingSpending ?? input.spending[t0] ?? 0;

  const scaled = (m: number) => ({ ...quick, spending: input.spending.map((s, t) => (t >= t0 ? s * m : s)) });
  const m = solve(0, 3, (x) => rate(scaled(x)) >= target, 12, false);
  const sustainableSpending = m === null ? 0 : Math.round(firstSpend * m);

  const retireAt: WhatIfs["retireAt"] = [];
  for (let shift = -3; shift <= 3; shift++) {
    const people = input.people.map((p) => ({ ...p, retirementAge: p.retirementAge + shift }));
    if (people.some((p) => p.income > 0 && p.birthYear + p.retirementAge < input.startYear)) continue;
    retireAt.push({
      shift,
      ages: Object.fromEntries(people.map((p) => [p.id, p.retirementAge])),
      // Your plan as it stands uses the full run, so it matches the headline number.
      successRate: shift === 0 ? base.successRate : rate({ ...quick, people }),
    });
  }

  let toReach: WhatIfs["toReachTarget"] = { extraMonthlySavings: null, retireLaterYears: null, spendLessPerYear: null };
  if (base.successRate < target) {
    const working = input.people.some((p) => p.income > 0 && p.birthYear + p.retirementAge > input.startYear);
    const extra = working
      ? solve(0, 240_000_00, (x) => rate({ ...quick, extraSavings: { ...quick.extraSavings, taxable: quick.extraSavings.taxable + x } }) >= target, 14, true)
      : null;
    const later = retireAt.find((r) => r.shift > 0 && r.successRate >= target)?.shift ?? null;
    const spendLess = sustainableSpending !== null && sustainableSpending < firstSpend ? firstSpend - sustainableSpending : null;
    toReach = {
      extraMonthlySavings: extra === null ? null : Math.ceil(extra / 12 / 100) * 100,
      retireLaterYears: later,
      spendLessPerYear: spendLess === null ? null : Math.ceil(spendLess / 100) * 100,
    };
  }
  return { sustainableSpending, retireAt, toReachTarget: toReach };
}

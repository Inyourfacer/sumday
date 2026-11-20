/**
 * Monte Carlo retirement simulation (DESIGN §11.2).
 *
 * Each run replays history in random blocks (never wrapping 2025 back to 1928): a year's stock, bond and
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
import { deathAge, type Mortality } from "./longevity.ts";
import { bracketTop, incomeTax, irmaaSurcharge, ordinaryTaxableIncome, type TaxSetup } from "./tax.ts";

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
  /**
   * Share of `startYear` still to come (0–1, default 1). Balances already
   * include this year's activity so far, so the first simulated year only
   * adds the remaining contributions, spending and growth.
   */
  yearFraction?: number;
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
  /**
   * One-time amounts in any year, today's dollars: positive adds to taxable
   * savings (an inheritance, a sale); negative is paid out like spending
   * (a down payment, a wedding).
   */
  lumpSums?: { year: number; amount: number }[];
  /**
   * With `brackets`, withdrawals in retirement are taxed from the tax code (brackets,
   * standard deduction, gains stacked on ordinary income, Social Security taxation).
   * The flat percentages then only price lump-sum expenses.
   */
  taxes: { ordinaryPct: number; capitalGainsPct: number; brackets?: TaxSetup };
  history: readonly HistoricalYear[];
  rmd: RmdTable;
  runs: number;
  blockLength: number;
  /** Percentage points taken off every stock and bond return, to test a worse future than history (default 0). */
  returnHaircutPct?: number;
  /**
   * Draw when each person dies instead of planning to a fixed age. A run lasts until the last death;
   * after the first, the household spends `survivorSpendingPct` of the plan, the survivor keeps the
   * larger Social Security benefit, pensions stop, pre-tax money moves to the survivor and taxes
   * switch to single filing the next year. `endYear` is then the furthest anyone could live.
   */
  mortality?: Mortality;
  /**
   * Spending guardrails: once retired, the share of the portfolio spent each year (net of guaranteed
   * income) is compared with where it started. Above `upperPct` more than the start, spending is cut
   * by `adjustPct` (never below `floorPct` of the plan); below `lowerPct` less, and spending has been
   * cut, it is restored (never above the plan).
   */
  guardrails?: { upperPct: number; lowerPct: number; adjustPct: number; floorPct: number };
  /**
   * Convert pre-tax money to Roth each year in the window, as much as keeps taxable income inside the
   * `targetRatePct` bracket, paying the tax from taxable savings. Needs bracket taxes.
   */
  conversion?: { targetRatePct: number; startYear: number; endYear: number };
  /** Add Medicare income-related surcharges (IRMAA) from age 65, from the tax table's tiers. Bracket taxes only. */
  medicare?: boolean;
  /** Last year to show in `bands` and to measure `medianAtEnd` at (default `endYear`). */
  displayEndYear?: number;
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
  /** 95% interval for `successRate` from the number of runs (Wilson). */
  successInterval: [number, number];
  /** Of failed runs, the year by which the earliest tenth had run out. */
  earlyDepletionYear: number | null;
  /** Share of runs that last to the end but finish with under three years of spending left. */
  fragileRate: number;
  /** Income tax paid over the whole run (federal and state), median, today's dollars. Bracket taxes only. */
  medianLifetimeTax: number | null;
  /** Pre-tax money converted to Roth over the run, median. */
  medianConverted: number | null;
  /** Medicare surcharges paid over the run, median. */
  medianMedicareSurcharge: number | null;
  /** Median end value after tax a 22% heir would owe on pre-tax money. */
  medianEndAfterTax: number;
  /** With guardrails on: share of runs where spending was cut at least once, and the median lowest level in those runs (percent of plan). */
  guardrails: { cutShare: number; medianLowestPct: number | null } | null;
  /** With lifespans drawn: median year the last person dies. */
  medianLastDeathYear: number | null;
}

/** What a heir is assumed to owe on inherited pre-tax money. */
export const HEIR_TAX_RATE = 0.22;

/** 95% Wilson interval for a share seen in `n` runs. */
export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** When spending starts: the year the last person with a paycheck retires (or this year if nobody works). */
export function retirementYear(input: Pick<SimInput, "people" | "startYear">): number {
  const workers = input.people.filter((p) => p.income > 0);
  if (workers.length === 0) return input.startYear;
  return Math.max(input.startYear, ...workers.map((p) => p.birthYear + p.retirementAge));
}

/**
 * Indices into history for one run: blocks of consecutive years. A block that
 * reaches the last year of history ends there and a new one starts, so no run
 * joins 2025 to 1928, a sequence that never happened.
 */
function sequence(n: number, length: number, block: number, rand: () => number): number[] {
  const out: number[] = [];
  while (out.length < length) {
    const start = Math.floor(rand() * n);
    for (let k = 0; k < block && start + k < n && out.length < length; k++) out.push(start + k);
  }
  return out;
}

interface PathOutcome {
  totals: Float64Array;
  depletedAt: number | null;
  taxPaid: number;
  converted: number;
  medicare: number;
  /** Lowest spending level reached under guardrails, 1 = the plan. */
  lowestSpending: number;
  /** Pre-tax money left at the end. */
  endTraditional: number;
}

function runPath(input: SimInput, years: number[], retireYear: number, deaths: number[] | null = null): PathOutcome {
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

  // Lifespans: a year is lived by anyone whose death year is not yet past.
  const deathYear = people.map((_, k) => (deaths ? deaths[k]! : Infinity));
  const lastDeath = deaths ? Math.max(...deaths) : Infinity;
  const moved = people.map(() => false);
  const survivorPct = input.mortality?.survivorSpendingPct ?? 100;
  const alive = (k: number, year: number) => year <= deathYear[k]!;
  /** Household spending factor: lower once one of two has died. */
  const survivorFactor = (year: number) => {
    if (!deaths) return 1;
    const living = people.filter((_, k) => alive(k, year)).length;
    return living > 0 && living < n ? survivorPct / 100 : 1;
  };
  const guard = input.guardrails;
  let mult = 1;
  let lowest = 1;
  let startRate: number | null = null;
  const conv = input.conversion;
  const irmaa = input.medicare ? input.taxes.brackets?.table.irmaa : undefined;
  const magiHistory = new Float64Array(T).fill(Number.NaN);
  const startingMagi = people.reduce((s, p) => s + p.income, 0);
  let taxPaid = 0;
  let converted = 0;
  let medicare = 0;
  let lastTrad = 0;
  const totalNow = () => {
    let total = taxable + roth + hsa;
    for (let k = 0; k < n; k++) total += trad[k]!;
    return total;
  };
  const spendAt = (t: number) => (input.spending[t] ?? 0) * survivorFactor(input.startYear + t) * mult;

  /** Social Security and pension income this year, after the partial-year share `f`. */
  const incomeFor = (year: number, f: number): { ss: number; pension: number } => {
    let ss = 0;
    let pension = 0;
    const anyGone = deaths !== null && people.some((_, k) => !alive(k, year));
    for (let k = 0; k < n; k++) {
      if (!alive(k, year)) continue;
      const p = people[k]!;
      const age = year - p.birthYear;
      let benefit = p.socialSecurity !== null && age >= p.claimAge ? p.socialSecurity * 12 : 0;
      if (anyGone && age >= 60) {
        // A survivor receives the larger of the two benefits.
        for (let j = 0; j < n; j++) if (!alive(j, year) && people[j]!.socialSecurity !== null) benefit = Math.max(benefit, people[j]!.socialSecurity! * 12);
      }
      ss += f * benefit;
      if (p.pension && age >= p.pension.startAge) pension += (f * p.pension.monthly * 12) / (p.pension.cola ? 1 : cumInfl);
    }
    return { ss, pension };
  };

  /** Pay `need` (after tax) from savings in order: taxable, pre-tax, Roth, HSA. Returns what couldn't be paid. */
  const withdraw = (need: number): number => {
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
        for (let k = 0; k < n; k++) trad[k] = trad[k]! - gross * (trad[k]! / tradTotal);
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
    return need;
  };
  /** Flat-rate retirement year: spending minus income, grossed up at a flat rate. */
  const retireFlat = (t: number, f: number): boolean => {
    const year = input.startYear + t;
    const income = incomeFor(year, f);
    let need = f * spendAt(t) - income.ss - income.pension;

    // Required minimums come out whether needed or not; any extra is reinvested.
    for (let k = 0; k < n; k++) {
      const p = people[k]!;
      const age = year - p.birthYear;
      if (age < p.rmdStartAge || trad[k]! <= 0) continue;
      const rmd = Math.min(trad[k]!, f * requiredMinimum(input.rmd, age, Math.round(trad[k]!)));
      if (rmd <= 0) continue;
      trad[k] = trad[k]! - rmd;
      const net = rmd * (1 - ord);
      if (net > need) {
        const surplus = net - Math.max(0, need);
        taxable += surplus;
        basisNominal += surplus * cumInfl;
        need = 0;
      } else need -= net;
    }

    return withdraw(need) <= 0.5;
  };

  /**
   * Bracket-taxed retirement year. Income that is already coming (Social Security,
   * pensions, required minimums) is taxed first; then the extra needed is drawn
   * from taxable, pre-tax, Roth and HSA in that order, with the amount found so
   * that spending is met after the tax that draw itself causes.
   */
  const retireWithBrackets = (setup0: TaxSetup, t: number, f: number): boolean => {
    const year = input.startYear + t;
    // The year after the first death, the survivor files as a single person.
    const widowed = deaths !== null && people.some((_, k) => !alive(k, year));
    const setup: TaxSetup = widowed && setup0.filing === "married_joint" ? { ...setup0, filing: "single" } : setup0;
    // Medicare surcharge: set by the income of two years back, per person on Medicare.
    let medicareCost = 0;
    if (irmaa) {
      const back = magiHistory[Math.max(0, t - irmaa.lookbackYears)]!;
      const monthly = irmaaSurcharge(Number.isFinite(back) ? back : startingMagi, setup.filing, irmaa);
      const covered = people.filter((p, k) => alive(k, year) && year - p.birthYear >= 65).length;
      medicareCost = f * monthly * 12 * covered;
    }
    const spend = f * spendAt(t) + medicareCost;
    const { ss, pension } = incomeFor(year, f);
    let rmdGross = 0;
    for (let k = 0; k < n; k++) {
      const p = people[k]!;
      const age = year - p.birthYear;
      if (age < p.rmdStartAge || trad[k]! <= 0) continue;
      const rmd = Math.min(trad[k]!, f * requiredMinimum(input.rmd, age, Math.round(trad[k]!)));
      if (rmd <= 0) continue;
      trad[k] = trad[k]! - rmd;
      rmdGross += rmd;
    }
    // A partial first year is taxed as the whole year it would be, then scaled back.
    const taxOn = (ordinary: number, gains: number): number => {
      const full = incomeTax({ ordinary: ordinary / f, socialSecurity: ss / f, gains: gains / f }, setup, cumInfl).total;
      return full * f;
    };
    const cash = ss + pension + rmdGross;
    const basisReal = Math.min(taxable, basisNominal / cumInfl);
    const gainShare = taxable > 0 ? Math.max(0, 1 - basisReal / taxable) : 0;
    let tradTotal = 0;
    for (let k = 0; k < n; k++) tradTotal += trad[k]!;

    /** What drawing `g` in total (taxable, then pre-tax, Roth, HSA) leaves after tax, and the split. */
    const draw = (g: number) => {
      const fromTaxable = Math.min(g, taxable);
      let rest = g - fromTaxable;
      const fromTrad = Math.min(rest, tradTotal);
      rest -= fromTrad;
      const fromRoth = Math.min(rest, roth);
      rest -= fromRoth;
      const fromHsa = Math.min(rest, hsa);
      rest -= fromHsa;
      const tax = taxOn(pension + rmdGross + fromTrad, fromTaxable * gainShare);
      return { fromTaxable, fromTrad, fromRoth, fromHsa, unmet: rest, net: cash + g - rest - tax };
    };

    /** Roth conversion on top of this year's income: fill the chosen bracket, paying the tax from taxable savings. */
    const convert = (ordinaryNow: number, gainsNow: number): number => {
      if (!conv || year < conv.startYear || year > conv.endYear) return 0;
      let tradLeft = 0;
      for (let k = 0; k < n; k++) tradLeft += trad[k]!;
      const edge = bracketTop(setup, conv.targetRatePct);
      if (tradLeft <= 0 || edge === null) return 0;
      const fits = (extra: number) =>
        ordinaryTaxableIncome({ ordinary: (ordinaryNow + extra) / f, socialSecurity: ss / f, gains: gainsNow / f }, setup, cumInfl).taxableOrdinary <= edge;
      let amount: number;
      if (fits(tradLeft)) amount = tradLeft;
      else if (!fits(0)) return 0;
      else {
        let lo = 0;
        let hi = tradLeft;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
        amount = lo;
      }
      if (amount < 100) return 0;
      let owe = taxOn(ordinaryNow + amount, gainsNow) - taxOn(ordinaryNow, gainsNow);
      if (taxable > 0 && owe > 0) {
        const basisReal = Math.min(taxable, basisNominal / cumInfl);
        const share = Math.max(0, 1 - basisReal / taxable);
        const gross = Math.min(taxable, owe / (1 - share * cg));
        basisNominal *= 1 - gross / taxable;
        taxable -= gross;
        owe -= gross * (1 - share * cg);
      }
      const before = tradLeft;
      for (let k = 0; k < n; k++) trad[k] = trad[k]! - amount * (trad[k]! / before);
      roth += Math.max(0, amount - Math.max(0, owe));
      converted += amount;
      return amount;
    };

    /** Remember this year's income for the Medicare lookback, and the tax paid. */
    const record = (ordinary: number, gains: number) => {
      const r = incomeTax({ ordinary: ordinary / f, socialSecurity: ss / f, gains: gains / f }, setup, cumInfl);
      taxPaid += r.total * f;
      medicare += medicareCost;
      magiHistory[t] = ordinary / f + gains / f + r.taxableSocialSecurity;
    };

    const none = draw(0);
    if (none.net >= spend) {
      // Required minimums and income already cover spending: reinvest the surplus.
      const surplus = none.net - spend;
      taxable += surplus;
      basisNominal += surplus * cumInfl;
      const c = convert(pension + rmdGross, 0);
      record(pension + rmdGross + c, 0);
      return true;
    }
    const all = taxable + tradTotal + roth + hsa;
    if (draw(all).net < spend - 0.5) return false;
    // After-tax cash rises steadily with the draw, in straight segments between bracket edges, so a
    // few Newton steps find it; bisection is the fallback if a bracket edge makes it hop.
    let g = Math.min(all, Math.max(0, spend - cash));
    let d = draw(g);
    for (let i = 0; i < 8 && Math.abs(d.net - spend) > 0.5; i++) {
      const step = Math.max(100, 1e-6 * all);
      const slope = Math.max(0.3, (draw(Math.min(all, g + step)).net - d.net) / step);
      g = Math.min(all, Math.max(0, g + (spend - d.net) / slope));
      d = draw(g);
    }
    if (d.net < spend - 0.5 || d.net > spend + 50) {
      let lo = 0;
      let hi = all;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (draw(mid).net >= spend) hi = mid;
        else lo = mid;
      }
      g = hi;
      d = draw(g);
    }
    if (d.fromTaxable > 0) {
      basisNominal *= 1 - d.fromTaxable / taxable;
      taxable -= d.fromTaxable;
    }
    if (d.fromTrad > 0) for (let k = 0; k < n; k++) trad[k] = trad[k]! - d.fromTrad * (trad[k]! / tradTotal);
    roth -= d.fromRoth;
    hsa -= d.fromHsa;
    const ordinaryNow = pension + rmdGross + d.fromTrad;
    const gainsNow = d.fromTaxable * gainShare;
    const c = convert(ordinaryNow, gainsNow);
    record(ordinaryNow + c, gainsNow);
    return true;
  };

  const lumps = new Map<number, number>();
  for (const l of input.lumpSums ?? []) lumps.set(l.year, (lumps.get(l.year) ?? 0) + l.amount);

  for (let t = 0; t < T; t++) {
    const year = input.startYear + t;
    const h = input.history[years[t]!]!;
    const infl1 = 1 + h.inflation;
    cumInfl *= infl1;
    // Only the rest of the current year is simulated in year 0.
    const f = t === 0 ? Math.min(1, Math.max(0, input.yearFraction ?? 1)) : 1;
    if (depletedAt !== null) {
      totals[t] = 0;
      continue;
    }
    // Everyone has died: the plan is complete and what is left is what is left.
    if (year > lastDeath) {
      totals[t] = totals[t - 1] ?? 0;
      continue;
    }
    if (deaths) {
      for (let k = 0; k < n; k++) {
        if (moved[k] || alive(k, year)) continue;
        moved[k] = true;
        pay[k] = 0;
        // Pre-tax money moves to the surviving spouse.
        const heir = people.findIndex((_, i) => alive(i, year));
        if (heir >= 0) {
          trad[heir] = trad[heir]! + trad[k]!;
          trad[k] = 0;
        }
      }
    }
    const growth =
      a.stocks * ((1 + h.stocks) / infl1 - 1) + a.bonds * ((1 + h.bonds) / infl1 - 1) + a.cash * ((1 + h.bills) / infl1 - 1) - input.feePct / 100 - ((a.stocks + a.bonds) * (input.returnHaircutPct ?? 0)) / 100;

    // Working years: contributions in.
    let anyoneWorking = false;
    for (let k = 0; k < n; k++) {
      const p = people[k]!;
      const income = pay[k]!;
      if (income > 0 && year - p.birthYear < p.retirementAge && alive(k, year)) {
        anyoneWorking = true;
        trad[k] = trad[k]! + f * (income * (p.pretaxPct / 100) + income * matchShare[k]!);
        roth += f * income * (p.rothPct / 100);
        hsa += f * p.hsaPayroll;
        // Next year's pay: the raise, less this year's inflation.
        pay[k] = income * ((1 + p.raisePct / 100) / infl1);
      }
    }
    if (anyoneWorking) {
      taxable += f * extra.taxable;
      basisNominal += f * extra.taxable * cumInfl;
      roth += f * extra.roth;
      hsa += f * extra.hsa;
      for (let k = 0; k < n; k++) trad[k] = trad[k]! + f * extraTrad[k]!;
    }

    // One-time amounts this year.
    const lump = lumps.get(year) ?? 0;
    if (lump > 0) {
      taxable += lump;
      basisNominal += lump * cumInfl;
    } else if (lump < 0 && withdraw(-lump) > 0.5) {
      depletedAt = year;
      totals[t] = 0;
      continue;
    }

    if (year < retireYear) magiHistory[t] = pay.reduce((s, v) => s + v, 0);

    // Retirement: withdraw what income doesn't cover.
    if (year >= retireYear) {
      if (guard) {
        const income = incomeFor(year, 1);
        const base = (input.spending[t] ?? 0) * survivorFactor(year);
        const port = totalNow();
        const rate = port > 0 ? Math.max(0, base * mult - income.ss - income.pension) / port : Infinity;
        if (startRate === null) {
          if (rate >= 0.01 && Number.isFinite(rate)) startRate = rate;
        } else {
          if (rate > startRate * (1 + guard.upperPct / 100)) mult = Math.max(guard.floorPct / 100, mult * (1 - guard.adjustPct / 100));
          else if (rate < startRate * (1 - guard.lowerPct / 100) && mult < 1) mult = Math.min(1, mult * (1 + guard.adjustPct / 100));
          lowest = Math.min(lowest, mult);
        }
      }
      const funded = input.taxes.brackets ? retireWithBrackets(input.taxes.brackets, t, f) : retireFlat(t, f);
      if (!funded) {
        depletedAt = year;
        totals[t] = 0;
        continue;
      }
    }

    // Growth for the year.
    const g = f === 1 ? 1 + growth : (1 + growth) ** f;
    taxable *= g;
    roth *= g;
    hsa *= g;
    let total = taxable + roth + hsa;
    for (let k = 0; k < n; k++) {
      trad[k] = trad[k]! * g;
      total += trad[k]!;
    }
    totals[t] = total;
    lastTrad = 0;
    for (let k = 0; k < n; k++) lastTrad += trad[k]!;
  }
  return { totals, depletedAt, taxPaid, converted, medicare, lowestSpending: lowest, endTraditional: lastTrad };
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i]!;
}

/** Each person's death year for run `run`: the same draws for the same people and seed, so paired comparisons stay paired. */
function drawDeathYears(input: SimInput, run: number): number[] {
  const m = input.mortality!;
  return input.people.map((p, k) => {
    const rand = seededRandom((input.seed ^ Math.imul(run + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0);
    rand();
    rand();
    const age = Math.max(0, input.startYear - p.birthYear);
    return p.birthYear + Math.floor(deathAge(age, rand(), m));
  });
}

const medianOf = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = Float64Array.from(xs).sort();
  return sorted[Math.floor(sorted.length / 2)]!;
};

export function simulate(input: SimInput, options: { bands?: boolean } = {}): SimResult {
  const T = Math.max(1, input.endYear - input.startYear + 1);
  const rand = seededRandom(input.seed);
  const retireYear = retirementYear(input);
  const wantBands = options.bands ?? true;
  const columns = wantBands ? Array.from({ length: T }, () => new Float64Array(input.runs)) : [];
  let successes = 0;
  let fragile = 0;
  const lastSpend = input.spending.at(-1) ?? 0;
  const depletion: number[] = [];
  const taxes: number[] = [];
  const conversions: number[] = [];
  const surcharges: number[] = [];
  const endsAfterTax: number[] = [];
  const lowests: number[] = [];
  const lastDeaths: number[] = [];

  for (let r = 0; r < input.runs; r++) {
    const years = sequence(input.history.length, T, Math.max(1, input.blockLength), rand);
    const deaths = input.mortality ? drawDeathYears(input, r) : null;
    if (deaths) lastDeaths.push(Math.max(...deaths));
    const { totals, depletedAt, taxPaid, converted, medicare, lowestSpending, endTraditional } = runPath(input, years, retireYear, deaths);
    taxes.push(taxPaid);
    conversions.push(converted);
    surcharges.push(medicare);
    lowests.push(lowestSpending);
    endsAfterTax.push(depletedAt === null ? Math.max(0, totals[T - 1]! - endTraditional * HEIR_TAX_RATE) : 0);
    if (depletedAt === null) {
      successes += 1;
      if (totals[T - 1]! < 3 * lastSpend) fragile += 1;
    } else depletion.push(depletedAt);
    if (wantBands) for (let t = 0; t < T; t++) columns[t]![r] = totals[t]!;
  }

  const shown = input.displayEndYear ?? input.endYear;
  const allBands: YearBand[] = columns.map((col, t) => {
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
  const bands = allBands.filter((b) => b.year <= shown);
  depletion.sort((a, b) => a - b);
  const cuts = lowests.filter((x) => x < 1);
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
    successInterval: wilson(successes, input.runs),
    earlyDepletionYear: depletion.length ? depletion[Math.floor(depletion.length / 10)]! : null,
    fragileRate: fragile / input.runs,
    medianLifetimeTax: input.taxes.brackets ? Math.round(medianOf(taxes)) : null,
    medianConverted: input.conversion && input.taxes.brackets ? Math.round(medianOf(conversions)) : null,
    medianMedicareSurcharge: input.medicare && input.taxes.brackets?.table.irmaa ? Math.round(medianOf(surcharges)) : null,
    medianEndAfterTax: Math.round(medianOf(endsAfterTax)),
    guardrails: input.guardrails ? { cutShare: cuts.length / input.runs, medianLowestPct: cuts.length ? Math.round(medianOf(cuts) * 100) : null } : null,
    medianLastDeathYear: lastDeaths.length ? medianOf(lastDeaths) : null,
  };
}

/**
 * Replay every real historical start year in order (no randomness): the same
 * plan lived through 1928, 1929, 1930 and so on, as long as history lasts.
 * The classic way safe-withdrawal studies are run, so results can be checked
 * against published numbers.
 */
export function historicalReplay(input: SimInput): { successRate: number; cohorts: { startYear: number; success: boolean }[] } {
  const T = Math.max(1, input.endYear - input.startYear + 1);
  const retireYear = retirementYear(input);
  const cohorts: { startYear: number; success: boolean }[] = [];
  for (let s = 0; s + T <= input.history.length; s++) {
    const years = Array.from({ length: T }, (_, k) => s + k);
    cohorts.push({ startYear: input.history[s]!.year, success: runPath(input, years, retireYear).depletedAt === null });
  }
  return { successRate: cohorts.length ? cohorts.filter((c) => c.success).length / cohorts.length : 0, cohorts };
}

/**
 * Yearly retirement spending (scaling the whole plan) that still meets the
 * target, in the same units as `reference` (the plan's ongoing spending).
 */
export function affordableSpending(input: SimInput, target: number, retireYear: number, reference: number, runs = 1500): number {
  const t0 = Math.max(0, retireYear - input.startYear);
  const rate = (m: number) =>
    simulate({ ...input, runs, spending: input.spending.map((s, t) => (t >= t0 ? s * m : s)) }, { bands: false }).successRate;
  const m = solve(0, 3, (x) => rate(x) >= target, 12, false);
  return m === null ? 0 : Math.round(reference * m);
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

  const sustainableSpending = affordableSpending(input, target, retireYear, firstSpend, runs);

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

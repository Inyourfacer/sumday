/**
 * The recommendation waterfall (DESIGN §8). Each month's available money is
 * poured through an ordered list of steps. A step takes what it needs, up to
 * its target, and the rest spills to the next step. Every recommendation
 * carries the rule that produced it and the numbers it used.
 */
import { monthsBetween, parseIsoDate, type IsoDate } from "../dates.ts";
import { multiplyCents, type Cents } from "../money.ts";
import { payoffPlan, type Debt } from "./debt.ts";
import { hsaLimit, iraLimit, workplaceLimit, type ContributionLimits, type FilingStatus } from "./limits.ts";

export const STEP_IDS = [
  "starter_emergency",
  "employer_match",
  "high_interest_debt",
  "full_emergency",
  "near_goals",
  "hsa",
  "ira",
  "max_workplace",
  "goals",
  "taxable",
  "low_interest_debt",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_TITLES: Record<StepId, string> = {
  starter_emergency: "Starter emergency fund",
  employer_match: "Employer 401(k) match",
  high_interest_debt: "High-interest debt",
  full_emergency: "Full emergency fund",
  near_goals: "Goals due within 5 years",
  hsa: "Health savings account",
  ira: "IRA",
  max_workplace: "Max out workplace plan",
  goals: "Savings goals",
  taxable: "Taxable investing",
  low_interest_debt: "Pay down low-interest debt",
};

export const DEFAULT_STEPS: { id: StepId; enabled: boolean }[] = STEP_IDS.map((id) => ({ id, enabled: id !== "low_interest_debt" && id !== "near_goals" }));

/** Goals due within this many months count as near-term when that step is on. */
export const NEAR_GOAL_MONTHS = 60;

/**
 * Ready-made step orders. "standard" is the default. The others change the
 * trade-off between money you can reach soon and money locked in retirement accounts.
 */
export const STEP_TEMPLATES: Record<"standard" | "liquidity_first" | "max_tax_advantage", { label: string; summary: string; steps: { id: StepId; enabled: boolean }[] }> = {
  standard: {
    label: "Standard",
    summary: "Safety first, then tax-advantaged retirement saving, then goals, then taxable investing.",
    steps: DEFAULT_STEPS,
  },
  liquidity_first: {
    label: "Liquidity first",
    summary: "Goals due within 5 years are funded before HSA, IRA and extra workplace saving. The employer match still comes first.",
    steps: [
      "starter_emergency",
      "employer_match",
      "high_interest_debt",
      "full_emergency",
      "near_goals",
      "hsa",
      "ira",
      "max_workplace",
      "goals",
      "taxable",
      "low_interest_debt",
    ].map((id) => ({ id: id as StepId, enabled: id !== "low_interest_debt" })),
  },
  max_tax_advantage: {
    label: "Max tax advantage",
    summary: "Fills HSA, IRA and the workplace plan before any goal. Best when goals are far off or flexible.",
    steps: [
      "starter_emergency",
      "employer_match",
      "high_interest_debt",
      "hsa",
      "ira",
      "max_workplace",
      "full_emergency",
      "near_goals",
      "goals",
      "taxable",
      "low_interest_debt",
    ].map((id) => ({ id: id as StepId, enabled: id !== "low_interest_debt" && id !== "near_goals" })),
  },
};

export interface PlanPerson {
  id: number;
  name: string;
  ageAtYearEnd: number | null;
  /** Gross yearly income; null if not entered. */
  income: Cents | null;
  plan: {
    type: "none" | "401k" | "403b" | "457";
    /** Each tier: employer adds matchPct% on the next upToPct% of pay. */
    matchTiers: { matchPct: number; upToPct: number }[];
    pretaxPct: number;
    rothPct: number;
  };
  /** Contributions to this person's IRAs so far this calendar year. */
  iraYtd: Cents;
}

export interface PlanDebt extends Debt {
  /** Paid in full every month (a card used for convenience): not debt to pay down. */
  paysInFull: boolean;
}

export interface PlanGoal {
  id: number;
  name: string;
  remaining: Cents;
  requiredMonthly: Cents | null;
  targetDate: IsoDate | null;
}

export interface WaterfallInput {
  today: IsoDate;
  limits: ContributionLimits;
  /** False when this year's limits aren't published yet and last year's are used. */
  limitsExact: boolean;
  steps: readonly { id: StepId; enabled: boolean }[];
  params: {
    starterAmount: Cents;
    /** APR (%) at or above which debt counts as high-interest. */
    highInterestApr: number;
    emergencyMonths: number;
    /**
     * Marginal income-tax rate (%) used to turn a pre-tax payroll contribution
     * into the smaller drop in take-home pay. 0 / absent = treat gross as net.
     */
    marginalTaxPct?: number;
  };
  /** Money available to allocate each month; null when it can't be worked out yet. */
  available: Cents | null;
  essentialMonthly: Cents;
  emergencySaved: Cents;
  filingStatus: FilingStatus;
  hsaCoverage: "none" | "self" | "family";
  /** HSA money for this year: deposits so far plus payroll still to come. */
  hsaProjected: Cents;
  people: readonly PlanPerson[];
  debts: readonly PlanDebt[];
  /** In priority order. The emergency fund is not one of these. */
  goals: readonly PlanGoal[];
  hasTaxableAccount: boolean;
}

export type StepStatus = "act" | "partial" | "done" | "waiting" | "not_applicable" | "disabled";

export interface Fact {
  label: string;
  value: number | string;
  kind: "money" | "percent" | "months" | "text" | "date";
}

export interface Recommendation {
  step: StepId;
  /** 1-based position in the waterfall. */
  order: number;
  title: string;
  status: StepStatus;
  /** What to do, in plain words. Empty when there's nothing to do. */
  action: string;
  /** Monthly take-home cash this step takes. */
  amount: Cents;
  /**
   * Monthly amount that lands in the account when that differs from `amount`
   * (a pre-tax payroll contribution is bigger than the pay it costs).
   */
  contribution?: Cents;
  /** Monthly amount already moving to this destination (recent average), when known. */
  alreadyMoving?: Cents;
  /** Stable id of this move, for remembering what the user did with it. */
  key: string;
  /** The date by which acting still counts (filing deadline, promo end, goal date), when there is one. */
  deadline?: { date: IsoDate; label: string };
  /** What the user did with this move, if anything. Set by the server; never read by the engine. */
  userState?: { state: "done" | "snoozed" | "dismissed"; until: IsoDate | null };
  /** Which person or debt or goal this is about, if any. */
  subject?: { kind: "person" | "debt" | "goal"; id: number; name: string };
  why: string;
  facts: Fact[];
}

export interface WaterfallResult {
  available: Cents | null;
  allocated: Cents;
  leftover: Cents;
  monthsLeftInYear: number;
  recommendations: Recommendation[];
}

const money = (label: string, value: Cents): Fact => ({ label, value, kind: "money" });
const percent = (label: string, value: number): Fact => ({ label, value, kind: "percent" });
const text = (label: string, value: string): Fact => ({ label, value, kind: "text" });
const months = (label: string, value: number): Fact => ({ label, value, kind: "months" });

/** "$1,234" without cents, for sentences. */
function usd(c: Cents): string {
  return `$${Math.round(c / 100).toLocaleString("en-US")}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100) / 100}%`;
}

/** Employer match per year for contributing `contribPct` of pay. */
export function matchValue(income: Cents, tiers: PlanPerson["plan"]["matchTiers"], contribPct: number): Cents {
  let from = 0;
  let total = 0;
  for (const t of tiers) {
    const covered = Math.max(0, Math.min(contribPct - from, t.upToPct));
    total += multiplyCents(income, (covered / 100) * (t.matchPct / 100));
    from += t.upToPct;
  }
  return total;
}

/** Contribution % at which the full match is reached. */
export function fullMatchPct(tiers: PlanPerson["plan"]["matchTiers"]): number {
  return tiers.reduce((s, t) => s + t.upToPct, 0);
}

/** Round a contribution % down to the nearest half percent (what payroll systems accept). */
/** IRA and HSA money for a year can be added until the filing deadline (mid-April of the next year). */
export const CONTRIBUTION_GRACE_MONTHS = 3;

/** Months over which to spread a yearly room: the rest of the year plus the filing-deadline grace. */
export function pacingMonths(monthsLeftInYear: number): number {
  return monthsLeftInYear + CONTRIBUTION_GRACE_MONTHS;
}

/** Share of a pre-tax payroll dollar that comes out of take-home pay (Roth-only plans: all of it). */
export function takeHomeFactor(p: Pick<PlanPerson, "plan">, marginalTaxPct: number): number {
  if (p.plan.rothPct > 0 && p.plan.pretaxPct === 0) return 1;
  return 1 - Math.min(60, Math.max(0, marginalTaxPct)) / 100;
}

/** A move's identity: its step plus the person, debt or goal it is about. */
export function moveKey(r: Pick<Recommendation, "step" | "subject">): string {
  return r.subject ? `${r.step}:${r.subject.kind}:${r.subject.id}` : r.step;
}

/** The date after which a move stops counting (or gets more expensive), when there is one. */
function deadlineFor(r: Recommendation, year: number, input: WaterfallInput): Recommendation["deadline"] {
  if (r.status === "done" || r.status === "disabled" || r.status === "not_applicable") return undefined;
  switch (r.step) {
    case "ira":
    case "hsa":
      // This year's IRA and HSA money can be added until the filing deadline.
      return { date: `${year + 1}-04-15`, label: "Counts for this year until Apr 15" };
    case "employer_match":
    case "max_workplace":
      return { date: `${year}-12-31`, label: "Payroll changes must start before year end" };
    case "high_interest_debt":
    case "low_interest_debt": {
      const d = input.debts.find((x) => x.id === r.subject?.id);
      return d?.promoEnds && d.promoEnds >= input.today ? { date: d.promoEnds, label: "Intro rate ends" } : undefined;
    }
    case "goals":
    case "near_goals": {
      const g = input.goals.find((x) => x.id === r.subject?.id);
      return g?.targetDate ? { date: g.targetDate, label: "Goal date" } : undefined;
    }
    default:
      return undefined;
  }
}

function halfPctDown(p: number): number {
  return Math.floor(p * 2 + 1e-9) / 2;
}

export function runWaterfall(input: WaterfallInput): WaterfallResult {
  const { today, limits, params } = input;
  const monthIndex = parseIsoDate(today).month - 1;
  const monthsLeft = 12 - monthIndex;
  const recs: Recommendation[] = [];
  let remaining = Math.max(0, input.available ?? 0);
  const unknownAvailable = input.available === null;

  // Contribution % per person after this month's recommendations (match step can raise it).
  const contribPct = new Map(input.people.map((p) => [p.id, p.plan.pretaxPct + p.plan.rothPct]));
  // Emergency fund money given out by the starter step, so the full step doesn't count it twice.
  let emergencyThisMonth = 0;

  const push = (order: number, step: StepId, rec: Omit<Recommendation, "order" | "step" | "title" | "key"> & { title?: string }) => {
    recs.push({ order, step, title: rec.title ?? STEP_TITLES[step], key: "", ...rec });
  };
  /** Take up to `need` from what's left; returns what was taken and the status. */
  const take = (need: Cents): { amount: Cents; status: StepStatus } => {
    if (need <= 0) return { amount: 0, status: "done" };
    const amount = Math.min(need, remaining);
    remaining -= amount;
    return { amount, status: amount === 0 ? "waiting" : amount < need ? "partial" : "act" };
  };

  input.steps.forEach((s, i) => {
    const order = i + 1;
    if (!s.enabled) {
      push(order, s.id, { status: "disabled", action: "", amount: 0, why: "Turned off in your plan settings.", facts: [] });
      return;
    }

    switch (s.id) {
      case "starter_emergency":
      case "full_emergency": {
        const starter = s.id === "starter_emergency";
        const target = starter ? params.starterAmount : multiplyCents(input.essentialMonthly, params.emergencyMonths);
        const gap = Math.max(0, target - input.emergencySaved - (starter ? 0 : emergencyThisMonth));
        const t = take(gap);
        if (starter) emergencyThisMonth += t.amount;
        const why = starter
          ? "A small cushion first, so a surprise bill doesn't end up on a credit card."
          : `${params.emergencyMonths} months of essential spending (housing, utilities, insurance, groceries and other categories marked essential), so a job loss or big repair doesn't force you into debt.`;
        push(order, s.id, {
          status: t.status,
          action:
            t.status === "done"
              ? ""
              : t.amount > 0
                ? `Put ${usd(t.amount)}/mo into your emergency fund${gap > t.amount ? ` (${usd(gap)} to go)` : ""}.`
                : `Your emergency fund still needs ${usd(gap)}.`,
          amount: t.amount,
          why,
          facts: [
            money("Target", target),
            money("Saved", input.emergencySaved),
            money("Still needed", gap),
            ...(starter ? [] : [money("Essential spending per month", input.essentialMonthly), months("Months covered", params.emergencyMonths)]),
            ...(t.amount > 0 ? [months("Months to fill at this rate", Math.ceil(gap / t.amount))] : []),
          ],
        });
        return;
      }

      case "employer_match": {
        const eligible = input.people.filter((p) => p.plan.type !== "none" && p.plan.matchTiers.length > 0);
        if (eligible.length === 0) {
          push(order, s.id, {
            status: "not_applicable",
            action: "",
            amount: 0,
            why: "Nobody has an employer match entered. Add it under Settings → Household if your employer offers one.",
            facts: [],
          });
          return;
        }
        for (const p of eligible) {
          const income = p.income ?? 0;
          const current = contribPct.get(p.id)!;
          const full = fullMatchPct(p.plan.matchTiers);
          const subject = { kind: "person" as const, id: p.id, name: p.name };
          if (income <= 0) {
            push(order, s.id, { subject, status: "not_applicable", action: "", amount: 0, why: `Add ${p.name}'s income to work out the match.`, facts: [] });
            continue;
          }
          const factor = takeHomeFactor(p, params.marginalTaxPct ?? 0);
          // Contribution needed (gross, into the plan) and what it costs in take-home pay.
          const grossCost = multiplyCents(income, Math.max(0, full - current) / 1200);
          const t = take(Math.round(grossCost * factor));
          const grossPut = Math.round(t.amount / factor);
          const newPct = t.status === "act" ? full : current + halfPctDown((grossPut * 1200) / income);
          if (t.amount > 0) contribPct.set(p.id, newPct);
          const gained = matchValue(income, p.plan.matchTiers, newPct) - matchValue(income, p.plan.matchTiers, current);
          push(order, s.id, {
            subject,
            title: `${STEP_TITLES.employer_match}: ${p.name}`,
            status: t.status,
            action:
              t.status === "done"
                ? ""
                : t.amount > 0
                  ? `Raise ${p.name}'s ${p.plan.type} contribution from ${pct(current)} to ${pct(newPct)} of pay.`
                  : `${p.name} is ${pct(full - current)} short of the full match.`,
            amount: t.amount,
            contribution: grossPut,
            why:
              t.status === "done"
                ? `${p.name} already contributes ${pct(current)}, enough for the full match (${pct(full)}).`
                : "An employer match is an instant return on every dollar, more than any investment reliably pays.",
            facts: [
              percent("Contributing now", current),
              percent("Full match at", full),
              money("Match per year now", matchValue(income, p.plan.matchTiers, current)),
              ...(gained > 0 ? [money("Extra employer money per year", gained)] : []),
              money("Gross income", income),
            ],
          });
        }
        return;
      }

      case "high_interest_debt":
      case "low_interest_debt": {
        const high = s.id === "high_interest_debt";
        const debts = input.debts
          .filter((d) => !d.paysInFull && d.balance > 0 && (high ? d.apr >= params.highInterestApr : d.apr < params.highInterestApr))
          .sort((a, b) => b.apr - a.apr || a.balance - b.balance);
        if (debts.length === 0) {
          push(order, s.id, {
            status: "done",
            action: "",
            amount: 0,
            why: high
              ? `No debt at or above ${pct(params.highInterestApr)} APR. (Cards you pay in full each month don't count.)`
              : `No debt below ${pct(params.highInterestApr)} APR to pay down.`,
            facts: [],
          });
          return;
        }
        const total = debts.reduce((s2, d) => s2 + d.balance, 0);
        const t = take(total);
        // Highest rate first (avalanche); show where the money goes and what it saves.
        let left = t.amount;
        for (const d of debts) {
          const extra = Math.min(left, d.balance);
          left -= extra;
          const withExtra = payoffPlan([d], extra, "avalanche", today);
          const minimumOnly = payoffPlan([d], 0, "avalanche", today);
          push(order, s.id, {
            subject: { kind: "debt", id: d.id, name: d.name },
            title: `${STEP_TITLES[s.id]}: ${d.name}`,
            status: extra > 0 ? "act" : "waiting",
            action:
              extra > 0
                ? `Pay ${usd(extra)}/mo on top of the minimum on ${d.name} (${pct(d.apr)} APR).`
                : `${d.name} (${pct(d.apr)} APR) is next once the debts above it are paid.`,
            amount: extra,
            why: high
              ? `Paying off a ${pct(d.apr)} debt is a guaranteed ${pct(d.apr)} return. Highest rate first (avalanche) costs the least interest.`
              : "Optional: low-rate debt costs less than investing usually earns, but being debt-free has its own value.",
            facts: [
              money("Balance", d.balance),
              percent("APR", d.apr),
              money("Minimum payment", d.minPayment),
              ...(withExtra.months !== null ? [months("Paid off in", withExtra.months)] : []),
              ...(minimumOnly.months !== null
                ? [months("Minimums only", minimumOnly.months), money("Interest saved", minimumOnly.totalInterest - withExtra.totalInterest)]
                : [text("Minimums only", "never paid off: the minimum doesn't cover the interest")]),
            ],
          });
        }
        return;
      }

      case "hsa": {
        if (input.hsaCoverage === "none") {
          push(order, s.id, {
            status: "not_applicable",
            action: "",
            amount: 0,
            why: "Only for HSA-eligible health plans. Set your coverage under Settings → Household if you have one.",
            facts: [],
          });
          return;
        }
        const oldest = Math.max(...input.people.map((p) => p.ageAtYearEnd ?? 0));
        const limit = hsaLimit(limits, input.hsaCoverage, oldest || null);
        const room = Math.max(0, limit - input.hsaProjected);
        const t = take(Math.ceil(room / pacingMonths(monthsLeft)));
        push(order, s.id, {
          status: t.status,
          action: t.status === "done" ? "" : t.amount > 0 ? `Add ${usd(t.amount)}/mo to your HSA.` : `There's ${usd(room)} of HSA room left this year.`,
          amount: t.amount,
          why:
            t.status === "done"
              ? `You're on track to put the full ${usd(limit)} into your HSA this year.`
              : "HSA money goes in tax-free, grows tax-free and comes out tax-free for medical costs: the only triple tax break.",
          facts: [
            money(`${limits.year} limit (${input.hsaCoverage})`, limit),
            money("This year so far + payroll", input.hsaProjected),
            money("Room left", room),
            months("Months to spread it over (to the April deadline)", pacingMonths(monthsLeft)),
          ],
        });
        return;
      }

      case "ira": {
        const household = input.people.reduce((sum, p) => sum + (p.income ?? 0), 0);
        if (household <= 0) {
          push(order, s.id, { status: "not_applicable", action: "", amount: 0, why: "IRA contributions need earned income. Add incomes under Settings → Household.", facts: [] });
          return;
        }
        for (const p of input.people) {
          const limit = iraLimit(limits, p.ageAtYearEnd);
          const room = Math.max(0, limit - p.iraYtd);
          const t = take(Math.ceil(room / pacingMonths(monthsLeft)));
          const magi = input.filingStatus === "married_joint" ? household : (p.income ?? 0);
          const [lo, hi] = limits.rothIraPhaseOut[input.filingStatus];
          const kind = magi < lo ? "Roth IRA" : magi < hi ? "Roth IRA (partly: your income is in the phase-out range)" : "backdoor Roth IRA";
          push(order, s.id, {
            subject: { kind: "person", id: p.id, name: p.name },
            title: `IRA: ${p.name}`,
            status: t.status,
            action:
              t.status === "done"
                ? ""
                : t.amount > 0
                  ? `Put ${usd(t.amount)}/mo into ${p.name}'s ${kind}.`
                  : `${p.name} has ${usd(room)} of IRA room left this year.`,
            amount: t.amount,
            why:
              t.status === "done"
                ? `${p.name} has contributed the full ${usd(limit)} for ${limits.year}.`
                : magi >= hi
                  ? "Income is above the Roth limit, so contribute to a traditional IRA and convert it (a backdoor Roth). Check the pro-rata rule if you have other pre-tax IRA money."
                  : "Retirement money that grows tax-free. Roth suits most people below the income limit.",
            facts: [
              money(`${limits.year} limit`, limit),
              money("Contributed this year", p.iraYtd),
              money("Room left", room),
              months("Months to spread it over (to the April deadline)", pacingMonths(monthsLeft)),
              money("Income used for the Roth check", magi),
              text("Roth phase-out", `${usd(lo)}–${usd(hi)}`),
            ],
          });
        }
        return;
      }

      case "max_workplace": {
        const eligible = input.people.filter((p) => p.plan.type !== "none");
        if (eligible.length === 0) {
          push(order, s.id, { status: "not_applicable", action: "", amount: 0, why: "Nobody has a workplace retirement plan entered.", facts: [] });
          return;
        }
        for (const p of eligible) {
          const income = p.income ?? 0;
          const subject = { kind: "person" as const, id: p.id, name: p.name };
          if (income <= 0) {
            push(order, s.id, { subject, status: "not_applicable", action: "", amount: 0, why: `Add ${p.name}'s income to work this out.`, facts: [] });
            continue;
          }
          const limit = workplaceLimit(limits, p.ageAtYearEnd);
          const current = contribPct.get(p.id)!;
          const projected = multiplyCents(income, current / 100);
          const room = Math.max(0, limit - projected);
          const factor = takeHomeFactor(p, params.marginalTaxPct ?? 0);
          const t = take(Math.ceil((room / 12) * factor));
          const grossPut = Math.round(t.amount / factor);
          const newPct = Math.min((limit / income) * 100, current + halfPctDown((grossPut * 1200) / income));
          if (t.amount > 0) contribPct.set(p.id, newPct);
          push(order, s.id, {
            subject,
            title: `${STEP_TITLES.max_workplace}: ${p.name}`,
            status: t.status,
            action:
              t.status === "done"
                ? ""
                : t.amount > 0
                  ? `Raise ${p.name}'s ${p.plan.type} to ${pct(newPct)} of pay (about ${usd(grossPut)}/mo more into the plan).`
                  : `${p.name}'s ${p.plan.type} has ${usd(room)} of yearly room left.`,
            amount: t.amount,
            contribution: grossPut,
            why:
              t.status === "done"
                ? `${p.name}'s contributions reach the ${usd(limit)} limit.`
                : "Pre-tax or Roth contributions at work lower taxes now or later, and come straight out of pay so they actually happen.",
            facts: [
              money(`${limits.year} limit`, limit),
              percent("Contributing", current),
              money("Projected for a full year", projected),
              money("Room left", room),
            ],
          });
        }
        return;
      }

      case "near_goals":
      case "goals": {
        const nearOn = input.steps.some((x) => x.id === "near_goals" && x.enabled);
        const isNear = (g: PlanGoal) => g.targetDate !== null && monthsBetween(today, g.targetDate) <= NEAR_GOAL_MONTHS;
        // With the near-term step on, it takes goals due soon and this step keeps the rest.
        const list = s.id === "near_goals" ? input.goals.filter(isNear) : nearOn ? input.goals.filter((g) => !isNear(g)) : input.goals;
        if (list.length === 0) {
          push(order, s.id, {
            status: "not_applicable",
            action: "",
            amount: 0,
            why: s.id === "near_goals" ? "No goal is due within 5 years." : input.goals.length === 0 ? "No savings goals yet. Add one on the Goals page." : "Every goal is due within 5 years and handled by the step above.",
            facts: [],
          });
          return;
        }
        for (const g of list) {
          const subject = { kind: "goal" as const, id: g.id, name: g.name };
          if (g.remaining <= 0) {
            push(order, s.id, { subject, title: `Goal: ${g.name}`, status: "done", action: "", amount: 0, why: "Fully funded.", facts: [] });
            continue;
          }
          if (g.requiredMonthly === null) {
            push(order, s.id, {
              subject,
              title: `Goal: ${g.name}`,
              status: "not_applicable",
              action: "",
              amount: 0,
              why: "Add a target date to get a monthly amount.",
              facts: [money("Still needed", g.remaining)],
            });
            continue;
          }
          const t = take(g.requiredMonthly);
          push(order, s.id, {
            subject,
            title: `Goal: ${g.name}`,
            status: t.status,
            action: t.amount > 0 ? `Put ${usd(t.amount)}/mo toward ${g.name}.` : `${g.name} needs ${usd(g.requiredMonthly)}/mo to stay on schedule.`,
            amount: t.amount,
            why:
              t.status === "partial"
                ? `Needs ${usd(g.requiredMonthly)}/mo to reach the target by the date; this is what's left after the steps above.`
                : "The monthly amount that reaches the target by its date.",
            facts: [
              money("Still needed", g.remaining),
              money("Needed per month", g.requiredMonthly),
              ...(g.targetDate ? [{ label: "Target date", value: g.targetDate, kind: "date" as const }] : []),
            ],
          });
        }
        return;
      }

      case "taxable": {
        const amount = remaining;
        remaining = 0;
        push(order, s.id, {
          status: amount > 0 ? "act" : "waiting",
          action:
            amount > 0
              ? input.hasTaxableAccount
                ? `Invest ${usd(amount)}/mo in your brokerage account.`
                : `Invest ${usd(amount)}/mo in a brokerage account (add one under Accounts when you open it).`
              : "",
          amount,
          why:
            amount > 0
              ? "Everything above is covered; long-term money left over grows best invested at your target mix."
              : "Gets whatever is left after the steps above. Nothing left this month.",
          facts: [money("Left after the steps above", amount)],
        });
        return;
      }
    }
  });

  const year = parseIsoDate(today).year;
  for (const r of recs) {
    r.key = moveKey(r);
    const dl = deadlineFor(r, year, input);
    if (dl) r.deadline = dl;
  }

  const available = unknownAvailable ? null : (input.available as Cents);
  const allocated = recs.reduce((s, r) => s + r.amount, 0);
  return {
    available,
    allocated,
    leftover: available === null ? 0 : Math.max(0, available) - allocated,
    monthsLeftInYear: monthsLeft,
    recommendations: recs,
  };
}

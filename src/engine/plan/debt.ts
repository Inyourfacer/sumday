/**
 * Debt payoff (DESIGN §7): month-by-month simulation of avalanche (highest
 * rate first) or snowball (smallest balance first). Every month each debt
 * accrues interest and gets its minimum; the extra amount, plus the minimums
 * freed up by debts already paid off, goes to the current target.
 */
import { addMonths, type IsoDate } from "../dates.ts";
import { multiplyCents, type Cents } from "../money.ts";

export type Strategy = "avalanche" | "snowball";

export interface Debt {
  id: number;
  name: string;
  /** Amount owed, as a positive number. */
  balance: Cents;
  /** Regular APR in percent. */
  apr: number;
  minPayment: Cents;
  /** An intro rate that applies until `promoEnds` (exclusive). */
  promoApr?: number | null;
  promoEnds?: IsoDate | null;
}

export interface DebtResult {
  id: number;
  name: string;
  /** Months from now until paid off (1 = paid this month); null if never within the horizon. */
  months: number | null;
  payoffDate: IsoDate | null;
  interest: Cents;
}

export interface PayoffPlan {
  strategy: Strategy;
  extra: Cents;
  /** Months until every debt is paid; null if that never happens within 50 years. */
  months: number | null;
  debtFreeDate: IsoDate | null;
  totalInterest: Cents;
  totalPaid: Cents;
  debts: DebtResult[];
  /** Total owed at the end of each month. */
  balances: Cents[];
  /** Debts whose minimum doesn't cover the interest, so they would grow without extra payments. */
  growing: number[];
}

const HORIZON = 600;

function aprOn(debt: Debt, date: IsoDate): number {
  if (debt.promoApr != null && debt.promoEnds != null && date < debt.promoEnds) return debt.promoApr;
  return debt.apr;
}

function order(debts: readonly { id: number; balance: Cents; apr: number }[], strategy: Strategy): number[] {
  return [...debts]
    .sort((a, b) => (strategy === "avalanche" ? b.apr - a.apr || a.balance - b.balance : a.balance - b.balance || b.apr - a.apr) || a.id - b.id)
    .map((d) => d.id);
}

export function payoffPlan(debts: readonly Debt[], extra: Cents, strategy: Strategy, start: IsoDate): PayoffPlan {
  const live = debts.filter((d) => d.balance > 0).map((d) => ({ ...d }));
  const owed = new Map(live.map((d) => [d.id, d.balance]));
  const interest = new Map(live.map((d) => [d.id, 0]));
  const paidOff = new Map<number, number>();
  // Target order is fixed at the start: by rate for avalanche, by starting balance for snowball.
  const targets = order(
    live.map((d) => ({ id: d.id, balance: d.balance, apr: d.apr })),
    strategy,
  );
  const growing = live
    .filter((d) => multiplyCents(d.balance, aprOn(d, start) / 1200) >= d.minPayment)
    .map((d) => d.id);
  const balances: Cents[] = [];
  let totalPaid = 0;
  let month = 0;

  while ([...owed.values()].some((b) => b > 0) && month < HORIZON) {
    month += 1;
    const date = addMonths(start, month - 1);
    let budget = extra;
    // Interest, then minimums.
    for (const d of live) {
      const balance = owed.get(d.id)!;
      if (balance <= 0) {
        budget += d.minPayment; // a paid-off debt's minimum rolls over
        continue;
      }
      const charge = multiplyCents(balance, aprOn(d, date) / 1200);
      interest.set(d.id, interest.get(d.id)! + charge);
      const withInterest = balance + charge;
      const pay = Math.min(d.minPayment, withInterest);
      owed.set(d.id, withInterest - pay);
      totalPaid += pay;
      budget += d.minPayment - pay; // a minimum bigger than what's left frees the difference
    }
    // Extra to the targets in order.
    for (const id of targets) {
      if (budget <= 0) break;
      const balance = owed.get(id)!;
      if (balance <= 0) continue;
      const pay = Math.min(budget, balance);
      owed.set(id, balance - pay);
      budget -= pay;
      totalPaid += pay;
    }
    for (const d of live) {
      if (owed.get(d.id)! <= 0 && !paidOff.has(d.id)) paidOff.set(d.id, month);
    }
    balances.push([...owed.values()].reduce((s, b) => s + Math.max(0, b), 0));
  }

  const done = [...owed.values()].every((b) => b <= 0);
  const months = done ? month : null;
  return {
    strategy,
    extra,
    months,
    debtFreeDate: months === null || months === 0 ? (months === 0 ? start : null) : addMonths(start, months - 1),
    totalInterest: [...interest.values()].reduce((s, v) => s + v, 0),
    totalPaid,
    debts: live.map((d) => {
      const m = paidOff.get(d.id) ?? null;
      return { id: d.id, name: d.name, months: m, payoffDate: m === null ? null : addMonths(start, m - 1), interest: interest.get(d.id)! };
    }),
    balances,
    growing,
  };
}

export interface StrategyComparison {
  avalanche: PayoffPlan;
  snowball: PayoffPlan;
  /** How much less interest avalanche pays (≥ 0 in almost every case). */
  interestSaved: Cents;
  /** How many months sooner avalanche finishes (can be 0 or negative). */
  monthsSaved: number | null;
}

export function compareStrategies(debts: readonly Debt[], extra: Cents, start: IsoDate): StrategyComparison {
  const avalanche = payoffPlan(debts, extra, "avalanche", start);
  const snowball = payoffPlan(debts, extra, "snowball", start);
  return {
    avalanche,
    snowball,
    interestSaved: snowball.totalInterest - avalanche.totalInterest,
    monthsSaved: avalanche.months !== null && snowball.months !== null ? snowball.months - avalanche.months : null,
  };
}

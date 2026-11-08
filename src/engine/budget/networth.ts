/**
 * Account balances on past dates, and net worth over time (DESIGN §5.2).
 *
 * A balance on a date comes from the nearest balance snapshot:
 * - the latest snapshot on or before the date, plus transactions after it;
 * - otherwise the earliest snapshot after the date, minus transactions in
 *   between (so a statement balance also fixes earlier months);
 * - otherwise the running sum of transactions.
 * Before an account's first data point its balance is unknown (null).
 */
import type { IsoDate, MonthKey } from "../dates.ts";
import type { Cents } from "../money.ts";

export interface DatedAmount {
  date: IsoDate;
  amount: Cents;
}

export interface Snapshot {
  date: IsoDate;
  balance: Cents;
}

export interface AccountHistory {
  id: number;
  isLiability: boolean;
  snapshots: readonly Snapshot[];
  transactions: readonly DatedAmount[];
}

function sumBetween(txns: readonly DatedAmount[], afterExclusive: IsoDate | null, throughInclusive: IsoDate): Cents {
  let total = 0;
  for (const t of txns) {
    if ((afterExclusive === null || t.date > afterExclusive) && t.date <= throughInclusive) total += t.amount;
  }
  return total;
}

export function balanceOn(account: Pick<AccountHistory, "snapshots" | "transactions">, date: IsoDate): Cents | null {
  const snapshots = [...account.snapshots].sort((a, b) => (a.date < b.date ? -1 : 1));
  const firstDates = [snapshots[0]?.date, account.transactions.reduce<IsoDate | undefined>((m, t) => (m === undefined || t.date < m ? t.date : m), undefined)].filter(
    (d): d is IsoDate => d !== undefined,
  );
  if (firstDates.length === 0) return null;
  const earliest = firstDates.sort()[0]!;
  if (date < earliest) return null;

  const before = snapshots.filter((s) => s.date <= date).at(-1);
  if (before) return before.balance + sumBetween(account.transactions, before.date, date);
  const after = snapshots.find((s) => s.date > date);
  if (after) return after.balance - sumBetween(account.transactions, date, after.date);
  return sumBetween(account.transactions, null, date);
}

export interface NetWorthPoint {
  month: MonthKey;
  /** The date the balances are taken on (the month's last day). */
  date: IsoDate;
  assets: Cents;
  /** Debts, as a negative number. */
  liabilities: Cents;
  netWorth: Cents;
}

/**
 * Net worth at the end of each month.
 * Months before any account has data are left out.
 */
export function netWorthHistory(accounts: readonly AccountHistory[], monthEnds: readonly { month: MonthKey; date: IsoDate }[]): NetWorthPoint[] {
  const points: NetWorthPoint[] = [];
  for (const { month, date } of monthEnds) {
    let assets = 0;
    let liabilities = 0;
    let known = false;
    for (const account of accounts) {
      const balance = balanceOn(account, date);
      if (balance === null) continue;
      known = true;
      if (account.isLiability) liabilities += balance;
      else assets += balance;
    }
    if (known) points.push({ month, date, assets, liabilities, netWorth: assets + liabilities });
  }
  return points;
}

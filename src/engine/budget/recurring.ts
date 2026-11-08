/**
 * Finds recurring charges and deposits (bills, subscriptions, paychecks)
 * from transaction history (DESIGN §5.2): the same payee, at a regular
 * interval, for a similar amount.
 */
import { payeeKey } from "../categorize/payee.ts";
import { addDays, addMonths, addYears, daysBetween, type IsoDate } from "../dates.ts";
import type { Cents } from "../money.ts";

export type Frequency = "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "yearly";

export interface RecurringInput {
  id: number;
  accountId: number;
  date: IsoDate;
  amount: Cents;
  payee: string;
  categoryId: number | null;
}

export interface RecurringSeries {
  /** Stable id for this series: account, payee, direction and frequency. */
  key: string;
  payee: string;
  accountId: number;
  categoryId: number | null;
  frequency: Frequency;
  direction: "out" | "in";
  /** Median amount (signed). */
  amount: Cents;
  /** True when amounts swing more than 10% (utilities, card bills). */
  amountVaries: boolean;
  occurrences: number;
  firstDate: IsoDate;
  /** The occurrence before the last one (twice-monthly series repeat it a month later). */
  previousDate: IsoDate;
  lastDate: IsoDate;
  nextDate: IsoDate;
  /** Still happening: the next expected date isn't long overdue. */
  active: boolean;
  transactionIds: number[];
}

// Allowed gap between consecutive occurrences, in days. Banks post a day or
// two late around weekends, so each band has some slack.
const BANDS: { frequency: Frequency; min: number; max: number; days: number; minCount: number }[] = [
  { frequency: "weekly", min: 5, max: 9, days: 7, minCount: 3 },
  { frequency: "biweekly", min: 12, max: 16, days: 14, minCount: 3 },
  // Twice a month on fixed days (the 1st and 15th): gaps alternate 13–17 days.
  { frequency: "semimonthly", min: 12, max: 19, days: 15, minCount: 4 },
  { frequency: "monthly", min: 26, max: 35, days: 30, minCount: 3 },
  { frequency: "quarterly", min: 84, max: 98, days: 91, minCount: 3 },
  // A yearly charge is worth flagging after it happens twice.
  { frequency: "yearly", min: 355, max: 375, days: 365, minCount: 2 },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function within10(amounts: readonly Cents[], center: Cents): boolean {
  return amounts.every((a) => Math.abs(a - center) <= Math.abs(center) * 0.1);
}

/** The occurrence after `last`. Twice-monthly series repeat `previous` one month on. */
function nextAfter(last: IsoDate, frequency: Frequency, previous: IsoDate = last): IsoDate {
  const date = last;
  switch (frequency) {
    case "semimonthly":
      return addMonths(previous, 1);
    case "weekly":
      return addDays(date, 7);
    case "biweekly":
      return addDays(date, 14);
    case "monthly":
      return addMonths(date, 1);
    case "quarterly":
      return addMonths(date, 3);
    case "yearly":
      return addYears(date, 1);
  }
}

/** The frequency every gap fits, if any. */
function regularity(dates: readonly IsoDate[]): (typeof BANDS)[number] | undefined {
  if (dates.length < 2) return undefined;
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
  return BANDS.find((b) => dates.length >= b.minCount && gaps.every((g) => g >= b.min && g <= b.max));
}

/** Split one payee's transactions into groups of similar amounts (within 10%). */
function amountClusters(rows: readonly RecurringInput[]): RecurringInput[][] {
  const sorted = [...rows].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
  const clusters: RecurringInput[][] = [];
  for (const row of sorted) {
    const current = clusters.at(-1);
    const base = current?.[0];
    if (current && base && Math.abs(row.amount) <= Math.abs(base.amount) * 1.1) current.push(row);
    else clusters.push([row]);
  }
  return clusters;
}

function mostCommon<T>(values: readonly T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Detect recurring series as of `today`. Each transaction belongs to at most
 * one series. A payee with many irregular charges (a coffee shop) is not
 * recurring; a regular charge hidden among them (a monthly subscription from
 * a store you also shop at) still is.
 */
export function detectRecurring(rows: readonly RecurringInput[], today: IsoDate): RecurringSeries[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const row of rows) {
    if (row.amount === 0) continue;
    const key = `${row.accountId}|${payeeKey(row.payee)}|${row.amount < 0 ? "out" : "in"}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const series: RecurringSeries[] = [];
  for (const [groupKey, group] of groups) {
    const byDate = (list: RecurringInput[]) => [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

    // The whole group first (covers bills whose amount varies), then
    // similar-amount clusters inside it.
    const candidates: RecurringInput[][] = [byDate(group), ...amountClusters(group).map(byDate)];
    for (const candidate of candidates) {
      const band = regularity(candidate.map((r) => r.date));
      if (!band) continue;
      const amounts = candidate.map((r) => r.amount);
      const amount = median(amounts);
      const last = candidate.at(-1)!;
      const previousDate = candidate.at(-2)?.date ?? last.date;
      const nextDate = nextAfter(last.date, band.frequency, previousDate);
      series.push({
        key: `${groupKey}|${band.frequency}`,
        payee: mostCommon(candidate.map((r) => r.payee)),
        accountId: last.accountId,
        categoryId: mostCommon(candidate.map((r) => r.categoryId)),
        frequency: band.frequency,
        direction: amount < 0 ? "out" : "in",
        amount,
        amountVaries: !within10(amounts, amount),
        occurrences: candidate.length,
        firstDate: candidate[0]!.date,
        previousDate,
        lastDate: last.date,
        nextDate,
        // Overdue by more than half a period means it probably stopped.
        active: daysBetween(nextDate, today) <= band.days / 2 + 3,
        transactionIds: candidate.map((r) => r.id),
      });
      break; // one series per payee group: the whole group, or its first regular cluster
    }
  }
  return series.sort((a, b) => (a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : a.payee.localeCompare(b.payee)));
}

export interface UpcomingItem {
  key: string;
  date: IsoDate;
  payee: string;
  amount: Cents;
  amountVaries: boolean;
  accountId: number;
  categoryId: number | null;
  frequency: Frequency;
}

/** Expected occurrences of active series between `from` and `to` (inclusive). */
export function upcoming(series: readonly RecurringSeries[], from: IsoDate, to: IsoDate): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const s of series) {
    if (!s.active) continue;
    let previous = s.lastDate;
    for (let date = s.nextDate, n = 0; date <= to && n < 60; n++) {
      if (date >= from) {
      items.push({
        key: s.key,
        date,
        payee: s.payee,
        amount: s.amount,
        amountVaries: s.amountVaries,
        accountId: s.accountId,
        categoryId: s.categoryId,
        frequency: s.frequency,
      });
      }
      const next = nextAfter(date, s.frequency, previous);
      previous = date;
      date = next;
    }
  }
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.payee.localeCompare(b.payee)));
}

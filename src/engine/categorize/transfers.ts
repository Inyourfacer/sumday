import { daysBetween, type IsoDate } from "../dates.ts";
import type { Cents } from "../money.ts";

export interface TransferCandidate {
  id: number;
  accountId: number;
  date: IsoDate;
  amount: Cents;
}

export interface TransferOptions {
  /** Maximum days between the two sides (default 5). */
  windowDays?: number;
}

/**
 * Pair money leaving one household account with the same amount arriving in
 * another within a few days: a card payment, a move to savings, a brokerage
 * deposit. Each transaction is used at most once. Closest dates pair first;
 * ties go to the lower id, so the result is deterministic.
 *
 * Returns [outflowId, inflowId] pairs.
 */
export function findTransferPairs(
  candidates: readonly TransferCandidate[],
  { windowDays = 5 }: TransferOptions = {},
): [number, number][] {
  const outs = candidates.filter((c) => c.amount < 0);
  const ins = candidates.filter((c) => c.amount > 0);

  const options: { out: TransferCandidate; in: TransferCandidate; gap: number }[] = [];
  for (const out of outs) {
    for (const inn of ins) {
      if (inn.accountId === out.accountId || inn.amount !== -out.amount) continue;
      const gap = Math.abs(daysBetween(out.date, inn.date));
      if (gap <= windowDays) options.push({ out, in: inn, gap });
    }
  }
  options.sort((a, b) => a.gap - b.gap || a.out.id - b.out.id || a.in.id - b.in.id);

  const used = new Set<number>();
  const pairs: [number, number][] = [];
  for (const option of options) {
    if (used.has(option.out.id) || used.has(option.in.id)) continue;
    used.add(option.out.id);
    used.add(option.in.id);
    pairs.push([option.out.id, option.in.id]);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

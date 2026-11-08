/**
 * Money-weighted return (XIRR): the yearly rate at which the cash flows
 * net to zero. Flows are from your side: money in (contributions, and the
 * starting value) is negative; money out (withdrawals, and today's value) is
 * positive.
 */
import { daysBetween, type IsoDate } from "../dates.ts";

export interface Flow {
  date: IsoDate;
  amount: number;
}

function npv(flows: readonly Flow[], rate: number): number {
  const t0 = flows[0]!.date;
  return flows.reduce((s, f) => s + f.amount / (1 + rate) ** (daysBetween(t0, f.date) / 365), 0);
}

/** The annual rate, or null when it can't be found (no sign change, or too short a period). */
export function xirr(input: readonly Flow[]): number | null {
  const flows = [...input].filter((f) => f.amount !== 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  if (daysBetween(flows[0]!.date, flows.at(-1)!.date) < 30) return null;
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(flows, lo);
  const fHi = npv(flows, hi);
  if (Math.sign(fLo) === Math.sign(fHi)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(flows, mid);
    if (Math.abs(fMid) < 1e-6 || hi - lo < 1e-9) return mid;
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

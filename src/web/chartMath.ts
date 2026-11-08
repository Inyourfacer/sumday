/** Scale and label helpers for the hand-drawn SVG charts. */

/** Round tick values covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 100;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/** Compact dollars for axes and tiles, from cents: 123456789 → "$1.2M". */
export function compactMoney(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? "-" : "";
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}$${trim(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

function trim(n: number): string {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11" → "Nov"; add the year for January or when asked. */
export function monthLabel(month: string, withYear = false): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const name = MONTHS[m - 1]!;
  return withYear || m === 1 ? `${name} ${String(y).slice(2)}` : name;
}

/** "2026-11" → "November 2026". */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const long = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${long[m - 1]} ${y}`;
}

/** Show every n-th x label so they don't collide. */
export function labelStride(count: number, width: number, labelWidth = 44): number {
  return Math.max(1, Math.ceil((count * labelWidth) / Math.max(1, width)));
}

export function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

import { parseIsoDate } from "../engine/dates.ts";

export { formatMoney } from "../engine/money.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-05" → "Nov 5, 2026". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const { year, month, day } = parseIsoDate(iso.slice(0, 10));
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Today in the browser's local time zone, as YYYY-MM-DD. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

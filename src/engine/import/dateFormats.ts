import { isIsoDate, toIsoDate, type IsoDate } from "../dates.ts";

/** Order of the parts in a bank's date column. */
export type DateOrder = "MDY" | "DMY" | "YMD";

export const DATE_ORDERS: readonly DateOrder[] = ["MDY", "YMD", "DMY"];

/**
 * Parse a date written in a known order. Accepts "/", "-", "." or "" as
 * separators, 1- or 2-digit month and day, 2- or 4-digit years (2-digit years
 * are 2000–2069 or 1970–1999), and ignores a trailing time
 * ("2026-11-05 13:45:00", "11/05/2026 1:45 PM", "2026-11-05T00:00:00Z").
 * Returns undefined if the text isn't a real date in that order.
 */
export function parseDateWithOrder(input: string, order: DateOrder): IsoDate | undefined {
  const text = input.trim().split(/[T ]/, 1)[0] ?? "";
  let parts: string[];
  if (/^\d{8}$/.test(text)) {
    parts = order === "YMD" ? [text.slice(0, 4), text.slice(4, 6), text.slice(6)] : [text.slice(0, 2), text.slice(2, 4), text.slice(4)];
  } else {
    parts = text.split(/[/.-]/);
  }
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return undefined;

  const [a, b, c] = parts as [string, string, string];
  const [yearText, monthText, dayText] =
    order === "YMD" ? [a, b, c] : order === "MDY" ? [c, a, b] : [c, b, a];
  if (yearText.length !== 2 && yearText.length !== 4) return undefined;
  if (monthText.length > 2 || dayText.length > 2) return undefined;

  let year = Number(yearText);
  if (yearText.length === 2) year += year < 70 ? 2000 : 1900;
  const month = Number(monthText);
  const day = Number(dayText);
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoDate(iso) ? toIsoDate({ year, month, day }) : undefined;
}

/**
 * Pick the date order under which every sample parses. Prefers US order
 * (MDY), then YMD, then DMY, when more than one fits.
 */
export function guessDateOrder(samples: readonly string[]): DateOrder | undefined {
  const nonEmpty = samples.map((s) => s.trim()).filter((s) => s !== "");
  if (nonEmpty.length === 0) return undefined;
  return DATE_ORDERS.find((order) => nonEmpty.every((s) => parseDateWithOrder(s, order) !== undefined));
}

/**
 * Like guessDateOrder, but tolerates a few unreadable values (a footer line,
 * a "Pending" row): picks the order that reads the most samples, as long as
 * it reads at least 80% of them.
 */
export function bestDateOrder(samples: readonly string[]): DateOrder | undefined {
  const nonEmpty = samples.map((s) => s.trim()).filter((s) => s !== "");
  if (nonEmpty.length === 0) return undefined;
  let best: { order: DateOrder; hits: number } | undefined;
  for (const order of DATE_ORDERS) {
    const hits = nonEmpty.filter((s) => parseDateWithOrder(s, order) !== undefined).length;
    if (best === undefined || hits > best.hits) best = { order, hits };
  }
  return best && best.hits >= Math.ceil(nonEmpty.length * 0.8) ? best.order : undefined;
}

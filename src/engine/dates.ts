/**
 * Sumday works in calendar dates ("2026-11-08"), not instants. A transaction
 * happens on a day, a goal is due on a day, a birthday is a day. Dates are
 * stored and passed around as ISO strings (YYYY-MM-DD), which sort correctly
 * as plain strings. Arithmetic is done in UTC so time zones and daylight
 * saving can never shift a date.
 */
export type IsoDate = string;

/** A calendar month as "YYYY-MM". */
export type MonthKey = string;

export interface DateParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
}

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new RangeError(`month must be 1–12, got ${month}`);
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function parseIsoDate(value: IsoDate): DateParts {
  if (!isIsoDate(value)) throw new SyntaxError(`not a valid YYYY-MM-DD date: "${value}"`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

export function toIsoDate({ year, month, day }: DateParts): IsoDate {
  const result = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isIsoDate(result)) throw new RangeError(`not a real date: ${result}`);
  return result;
}

const MS_PER_DAY = 86_400_000;

function toUtcMs(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return toIsoDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new RangeError(`days must be a whole number, got ${days}`);
  return fromUtcMs(toUtcMs(date) + days * MS_PER_DAY);
}

/**
 * Add calendar months. The day is clamped to the end of a shorter month:
 * Jan 31 + 1 month → Feb 28 (or 29), and Mar 31 − 1 month → Feb 28.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  if (!Number.isInteger(months)) throw new RangeError(`months must be a whole number, got ${months}`);
  const { year, month, day } = parseIsoDate(date);
  const index = year * 12 + (month - 1) + months;
  const newYear = Math.floor(index / 12);
  const newMonth = (index % 12) + 1;
  return toIsoDate({ year: newYear, month: newMonth, day: Math.min(day, daysInMonth(newYear, newMonth)) });
}

export function addYears(date: IsoDate, years: number): IsoDate {
  return addMonths(date, years * 12);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function monthKey(date: IsoDate): MonthKey {
  parseIsoDate(date);
  return date.slice(0, 7);
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${monthKey(date)}-01`;
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(date);
  return toIsoDate({ year, month, day: daysInMonth(year, month) });
}

/** Whole calendar months from `from` to `to`, ignoring the day of month. */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** Age in whole years on a date. A Feb 29 birthday ages up on Mar 1 in non-leap years. */
export function ageOn(birthDate: IsoDate, onDate: IsoDate): number {
  const b = parseIsoDate(birthDate);
  const d = parseIsoDate(onDate);
  let age = d.year - b.year;
  if (d.month < b.month || (d.month === b.month && d.day < b.day)) age -= 1;
  return age;
}

/** Today's calendar date in an IANA time zone, e.g. todayIn("America/Chicago"). */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  // en-CA formats dates as YYYY-MM-DD.
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return toIsoDate(parseIsoDate(formatted));
}

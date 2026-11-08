/**
 * Money is always an integer number of cents. Never store or add dollars as
 * floats; convert at the edges (parsing input, formatting output).
 *
 * Integers are exact in a JS number up to 2^53 cents (about $90 trillion).
 */
export type Cents = number;

export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function assertCents(value: number, label = "amount"): Cents {
  if (!isCents(value)) throw new RangeError(`${label} must be a whole number of cents, got ${value}`);
  return value;
}

/**
 * Round a fractional cent amount to whole cents, half away from zero
 * (2.5 → 3, -2.5 → -3). A tiny tolerance absorbs float error such as
 * 1.005 * 100 = 100.49999999999999.
 */
export function roundCents(value: number): Cents {
  if (!Number.isFinite(value)) throw new RangeError(`cannot round ${value} to cents`);
  const magnitude = Math.floor(Math.abs(value) + 0.5 + 1e-9);
  return magnitude === 0 ? 0 : Math.sign(value) * magnitude;
}

/** Convert a dollar amount (e.g. from a calculation or JSON) to cents. */
export function dollarsToCents(dollars: number): Cents {
  return roundCents(dollars * 100);
}

/** Cents → dollars, for charts and math that needs a float. Not for storage. */
export function centsToDollars(cents: Cents): number {
  return cents / 100;
}

/** Multiply an amount by a rate or factor, rounding to whole cents. */
export function multiplyCents(cents: Cents, factor: number): Cents {
  return roundCents(cents * factor);
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return assertCents(total, "sum");
}

const MONEY_PATTERN = /^([+-])?\$?([+-])?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/;

/**
 * Parse a money string from a bank export or a form into cents, without going
 * through floats. Accepts "$1,234.56", "-12.30", "+5", "(45.00)" (accounting
 * negative), "$-3.10", ".99" and surrounding whitespace. More than two decimal
 * places round half away from zero. Throws on anything else.
 */
export function parseMoney(input: string): Cents {
  let text = input.trim();
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  const match = MONEY_PATTERN.exec(text);
  if (!match) throw new SyntaxError(`not a money amount: "${input}"`);
  const [, sign1, sign2, wholeRaw = "", fracRaw = ""] = match;
  if (sign1 && sign2) throw new SyntaxError(`not a money amount: "${input}"`);
  if (wholeRaw === "" && fracRaw === "") throw new SyntaxError(`not a money amount: "${input}"`);
  if ((sign1 ?? sign2) === "-") negative = !negative;

  const whole = Number(wholeRaw.replaceAll(",", "") || "0");
  const fracPadded = (fracRaw + "00").slice(0, 2);
  let cents = whole * 100 + Number(fracPadded);
  // Round on the third decimal digit; any further digits only matter for ties.
  const rest = fracRaw.slice(2);
  if (rest !== "" && Number(rest[0]) >= 5) cents += 1;

  assertCents(cents, "parsed amount");
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * Split an amount across weights so the parts add up exactly to the total
 * (largest-remainder method). Ties go to the earliest weight.
 * allocateCents(100, [1, 1, 1]) → [34, 33, 33].
 */
export function allocateCents(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total, "total");
  if (weights.length === 0) throw new RangeError("need at least one weight");
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError("weights must be finite and ≥ 0");
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) throw new RangeError("weights must not all be zero");

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);
  const exact = weights.map((w) => (magnitude * w) / weightSum);
  const parts = exact.map((x) => Math.floor(x));
  let leftover = magnitude - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, remainder: x - Math.floor(x) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of order) {
    if (leftover === 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    leftover -= 1;
  }
  return parts.map((p) => (p === 0 ? 0 : sign * p));
}

export interface FormatMoneyOptions {
  /** Show cents (default true). When false, rounds to whole dollars. */
  cents?: boolean;
  /** Prefix positive amounts with "+" (default false). */
  signed?: boolean;
}

/** Format cents as US dollars: 123456 → "$1,234.56", -500 → "-$5.00". */
export function formatMoney(amount: Cents, options: FormatMoneyOptions = {}): string {
  const { cents = true, signed = false } = options;
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
    signDisplay: signed ? "exceptZero" : "auto",
  });
  return formatter.format(centsToDollars(amount));
}

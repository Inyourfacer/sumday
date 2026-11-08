import { describe, expect, it } from "vitest";
import {
  allocateCents,
  assertCents,
  dollarsToCents,
  formatMoney,
  multiplyCents,
  parseMoney,
  roundCents,
  sumCents,
} from "./money.ts";

describe("roundCents", () => {
  it("rounds half away from zero", () => {
    expect(roundCents(2.5)).toBe(3);
    expect(roundCents(-2.5)).toBe(-3);
    expect(roundCents(2.4999)).toBe(2);
    expect(roundCents(-0.4)).toBe(0);
  });

  it("never returns negative zero", () => {
    expect(Object.is(roundCents(-0.2), 0)).toBe(true);
  });

  it("absorbs float error", () => {
    expect(dollarsToCents(1.005)).toBe(101);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });

  it("rejects non-finite values", () => {
    expect(() => roundCents(Number.NaN)).toThrow(RangeError);
    expect(() => roundCents(Infinity)).toThrow(RangeError);
  });
});

describe("parseMoney", () => {
  it.each([
    ["0", 0],
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    [".99", 99],
    ["5.", 500],
    ["$1,234.56", 123456],
    ["1,234,567.89", 123456789],
    ["  42.00  ", 4200],
    ["+5", 500],
    ["-12.30", -1230],
    ["-$5.00", -500],
    ["$-5.00", -500],
    ["(45.00)", -4500],
    ["($1,000)", -100000],
    ["-0.00", 0],
  ])("parses %j as %i cents", (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it("rounds extra decimal places half away from zero", () => {
    expect(parseMoney("1.005")).toBe(101);
    expect(parseMoney("1.0049")).toBe(100);
    expect(parseMoney("-1.005")).toBe(-101);
    expect(parseMoney("0.995")).toBe(100);
  });

  it.each(["", "abc", "$", ".", "1,23.00", "12,3456", "--5", "-$-5", "1.2.3", "5 USD", "1e5"])(
    "rejects %j",
    (input) => {
      expect(() => parseMoney(input)).toThrow(SyntaxError);
    },
  );
});

describe("multiplyCents and sumCents", () => {
  it("applies a rate with rounding", () => {
    // 1% monthly interest on $123.45
    expect(multiplyCents(12345, 0.01)).toBe(123);
    // 7.5% of $10.10 = 75.75 cents → 76
    expect(multiplyCents(1010, 0.075)).toBe(76);
  });

  it("sums exactly", () => {
    expect(sumCents([10, 20, -5])).toBe(25);
    expect(sumCents([])).toBe(0);
  });

  it("assertCents rejects fractions", () => {
    expect(() => assertCents(1.5)).toThrow(RangeError);
    expect(assertCents(150)).toBe(150);
  });
});

describe("allocateCents", () => {
  it("splits evenly with the remainder going first", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("always adds up to the total", () => {
    const parts = allocateCents(1_000_001, [0.6, 0.3, 0.1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_000_001);
    expect(parts).toEqual([600_001, 300_000, 100_000]);
  });

  it("gives the largest remainder the extra cent", () => {
    // exact: 33.33, 66.67 → 33, 67
    expect(allocateCents(100, [1, 2])).toEqual([33, 67]);
  });

  it("handles negative totals and zero weights", () => {
    expect(allocateCents(-100, [1, 0, 1])).toEqual([-50, 0, -50]);
  });

  it("rejects bad weights", () => {
    expect(() => allocateCents(100, [])).toThrow(RangeError);
    expect(() => allocateCents(100, [0, 0])).toThrow(RangeError);
    expect(() => allocateCents(100, [-1, 2])).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("formats US dollars", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(-500)).toBe("-$5.00");
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("supports whole dollars and explicit signs", () => {
    expect(formatMoney(123456, { cents: false })).toBe("$1,235");
    expect(formatMoney(2500, { signed: true })).toBe("+$25.00");
    expect(formatMoney(-2500, { signed: true })).toBe("-$25.00");
    expect(formatMoney(0, { signed: true })).toBe("$0.00");
  });
});

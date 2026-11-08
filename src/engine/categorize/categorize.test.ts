import { describe, expect, it } from "vitest";
import { cleanPayee, payeeKey } from "./payee.ts";
import { applyRules, ruleMatches, suggestRule, validateRule, type Rule, type RuleSubject } from "./rules.ts";
import { findTransferPairs } from "./transfers.ts";

describe("cleanPayee", () => {
  it.each([
    ["SQ *BLUE BOTTLE COFFEE", "Blue Bottle Coffee"],
    ["TST* JOE'S PIZZA", "Joe's Pizza"],
    ["POS PURCHASE TST* JOE'S PIZZA 11/04", "Joe's Pizza"],
    ["TRADER JOE'S #552", "Trader Joe's"],
    ["SAFEWAY #1234 OAKLAND CA", "Safeway"],
    ["SHELL OIL 57444283401", "Shell Oil"],
    ["AMAZON.COM*AB12CD3EF", "Amazon.com"],
    ["PAYPAL *SPOTIFY", "Spotify"],
    ["CHECKCARD PURCHASE TARGET STORE 1234", "Target"],
    ["NETFLIX.COM XXXX1234", "Netflix.com"],
    ["ACH DEBIT CITY WATER UTIL", "City Water Util"],
    ["COMCAST CABLE 800-266-2278", "Comcast Cable"],
    ["Already Nice Name", "Already Nice Name"],
    ["  lots   of   space  ", "lots of space"],
  ])("%s → %s", (raw, cleaned) => {
    expect(cleanPayee(raw)).toBe(cleaned);
  });

  it("never returns an empty string", () => {
    expect(cleanPayee("#1234")).toBe("#1234");
    expect(cleanPayee("SQ *")).toBe("Sq");
  });

  it("makes comparison keys ignoring case and punctuation", () => {
    expect(payeeKey("Trader Joe's")).toBe("TRADER JOE S");
    expect(payeeKey("trader-joe's!")).toBe("TRADER JOE S");
  });
});

const subject = (over: Partial<RuleSubject> = {}): RuleSubject => ({
  accountId: 1,
  amount: -4217,
  payee: "Safeway",
  payeeRaw: "SAFEWAY #1234 OAKLAND CA",
  ...over,
});

describe("rules", () => {
  it("matches payee text in different ways, ignoring case", () => {
    expect(ruleMatches({ payee: { op: "contains", value: "safeway" } }, subject())).toBe(true);
    expect(ruleMatches({ payee: { op: "contains", value: "oakland" } }, subject())).toBe(true);
    expect(ruleMatches({ payee: { op: "equals", value: "SAFEWAY" } }, subject())).toBe(true);
    expect(ruleMatches({ payee: { op: "equals", value: "safe" } }, subject())).toBe(false);
    expect(ruleMatches({ payee: { op: "startsWith", value: "safe" } }, subject())).toBe(true);
    expect(ruleMatches({ payee: { op: "regex", value: "^safeway #\\d+" } }, subject())).toBe(true);
    expect(ruleMatches({ payee: { op: "regex", value: "(" } }, subject())).toBe(false);
  });

  it("checks amount size, direction and account", () => {
    expect(ruleMatches({ amountMin: 4000, amountMax: 5000 }, subject())).toBe(true);
    expect(ruleMatches({ amountMin: 5000 }, subject())).toBe(false);
    expect(ruleMatches({ direction: "debit" }, subject())).toBe(true);
    expect(ruleMatches({ direction: "credit" }, subject())).toBe(false);
    expect(ruleMatches({ accountId: 2 }, subject())).toBe(false);
  });

  it("first match by priority wins", () => {
    const rules: Rule[] = [
      { id: 1, priority: 20, match: { payee: { op: "contains", value: "safeway" } }, actions: { categoryId: 10 } },
      {
        id: 2,
        priority: 10,
        match: { payee: { op: "contains", value: "safeway" }, amountMin: 10000 },
        actions: { categoryId: 11, renamePayee: "Safeway (big shop)" },
      },
      { id: 3, priority: 20, match: { direction: "debit" }, actions: { categoryId: 99 } },
    ];
    expect(applyRules(rules, subject())).toEqual({ ruleId: 1, categoryId: 10 });
    expect(applyRules(rules, subject({ amount: -15000 }))).toEqual({
      ruleId: 2,
      categoryId: 11,
      payee: "Safeway (big shop)",
    });
    expect(applyRules(rules, subject({ payee: "Shell", payeeRaw: "SHELL" }))).toEqual({ ruleId: 3, categoryId: 99 });
    expect(applyRules([], subject())).toBeUndefined();
  });

  it("suggests a rule from a correction", () => {
    expect(suggestRule(subject(), 7)).toEqual({
      match: { payee: { op: "contains", value: "Safeway" }, direction: "debit" },
      actions: { categoryId: 7 },
    });
  });

  it("validates rules", () => {
    expect(() => validateRule({}, { categoryId: 1 })).toThrow(/condition/);
    expect(() => validateRule({ payee: { op: "regex", value: "(" } }, { categoryId: 1 })).toThrow(/regular expression/);
    expect(() => validateRule({ amountMin: 10, amountMax: 5 }, { categoryId: 1 })).toThrow(/Minimum/);
    expect(() => validateRule({ direction: "debit" }, {})).toThrow(/action/);
    expect(() => validateRule({ payee: { op: "contains", value: " " } }, { categoryId: 1 })).toThrow(/blank/);
    expect(() => validateRule({ direction: "debit" }, { renamePayee: "X" })).not.toThrow();
  });
});

describe("findTransferPairs", () => {
  it("pairs opposite amounts across accounts within the window", () => {
    const pairs = findTransferPairs([
      { id: 1, accountId: 1, date: "2026-11-01", amount: -50000 }, // checking → card payment
      { id: 2, accountId: 2, date: "2026-11-03", amount: 50000 },
      { id: 3, accountId: 1, date: "2026-11-01", amount: -1000 }, // no partner
      { id: 4, accountId: 1, date: "2026-11-10", amount: 1000 }, // same account: never a transfer
    ]);
    expect(pairs).toEqual([[1, 2]]);
  });

  it("respects the window", () => {
    const rows = [
      { id: 1, accountId: 1, date: "2026-11-01", amount: -2500 },
      { id: 2, accountId: 2, date: "2026-11-07", amount: 2500 },
    ];
    expect(findTransferPairs(rows)).toEqual([]);
    expect(findTransferPairs(rows, { windowDays: 6 })).toEqual([[1, 2]]);
  });

  it("uses each transaction once and prefers the closest date", () => {
    const pairs = findTransferPairs([
      { id: 1, accountId: 1, date: "2026-11-01", amount: -10000 },
      { id: 2, accountId: 1, date: "2026-11-05", amount: -10000 },
      { id: 3, accountId: 2, date: "2026-11-04", amount: 10000 },
      { id: 4, accountId: 3, date: "2026-11-02", amount: 10000 },
    ]);
    expect(pairs).toEqual([
      [1, 4],
      [2, 3],
    ]);
  });
});

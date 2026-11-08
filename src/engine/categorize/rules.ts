import type { Cents } from "../money.ts";
import { cleanPayee, payeeKey } from "./payee.ts";

export type PayeeOp = "contains" | "equals" | "startsWith" | "regex";

export interface RuleMatch {
  payee?: { op: PayeeOp; value: string };
  /** Applies to the size of the amount, ignoring its sign. */
  amountMin?: Cents;
  amountMax?: Cents;
  direction?: "debit" | "credit";
  accountId?: number;
}

export interface RuleActions {
  categoryId?: number;
  renamePayee?: string;
}

export interface Rule {
  id: number;
  /** Lower runs first. The first matching rule wins. */
  priority: number;
  match: RuleMatch;
  actions: RuleActions;
}

export interface RuleSubject {
  accountId: number;
  amount: Cents;
  /** Cleaned payee as displayed. */
  payee: string;
  /** Payee text exactly as the bank sent it. */
  payeeRaw: string;
}

export interface RuleOutcome {
  ruleId: number;
  categoryId?: number;
  payee?: string;
}

/** Throws if a rule can't be used (bad regex, empty match, min > max). */
export function validateRule(match: RuleMatch, actions: RuleActions): void {
  const hasCondition =
    match.payee !== undefined ||
    match.amountMin !== undefined ||
    match.amountMax !== undefined ||
    match.direction !== undefined ||
    match.accountId !== undefined;
  if (!hasCondition) throw new Error("A rule needs at least one condition.");
  if (match.payee !== undefined && match.payee.value.trim() === "") throw new Error("Payee text can't be blank.");
  if (match.payee?.op === "regex") {
    try {
      new RegExp(match.payee.value, "i");
    } catch {
      throw new Error(`"${match.payee.value}" isn't a valid regular expression.`);
    }
  }
  if (match.amountMin !== undefined && match.amountMax !== undefined && match.amountMin > match.amountMax) {
    throw new Error("Minimum amount is more than the maximum.");
  }
  if (actions.categoryId === undefined && (actions.renamePayee ?? "").trim() === "") {
    throw new Error("A rule needs an action: set a category or rename the payee.");
  }
}

function payeeMatches(cond: NonNullable<RuleMatch["payee"]>, subject: RuleSubject): boolean {
  const candidates = [subject.payee, subject.payeeRaw];
  if (cond.op === "regex") {
    let re: RegExp;
    try {
      re = new RegExp(cond.value, "i");
    } catch {
      return false;
    }
    return candidates.some((c) => re.test(c));
  }
  const needle = payeeKey(cond.value);
  if (needle === "") return false;
  return candidates.some((c) => {
    const hay = payeeKey(c);
    if (cond.op === "equals") return hay === needle;
    if (cond.op === "startsWith") return hay.startsWith(needle);
    return hay.includes(needle);
  });
}

export function ruleMatches(match: RuleMatch, subject: RuleSubject): boolean {
  if (match.accountId !== undefined && match.accountId !== subject.accountId) return false;
  if (match.direction === "debit" && subject.amount >= 0) return false;
  if (match.direction === "credit" && subject.amount <= 0) return false;
  const size = Math.abs(subject.amount);
  if (match.amountMin !== undefined && size < match.amountMin) return false;
  if (match.amountMax !== undefined && size > match.amountMax) return false;
  if (match.payee !== undefined && !payeeMatches(match.payee, subject)) return false;
  return true;
}

/** Run rules in priority order (then id). The first match decides. */
export function applyRules(rules: readonly Rule[], subject: RuleSubject): RuleOutcome | undefined {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const rule of ordered) {
    if (!ruleMatches(rule.match, subject)) continue;
    const outcome: RuleOutcome = { ruleId: rule.id };
    if (rule.actions.categoryId !== undefined) outcome.categoryId = rule.actions.categoryId;
    const rename = rule.actions.renamePayee?.trim();
    if (rename) outcome.payee = rename;
    return outcome;
  }
  return undefined;
}

/**
 * After the user recategorizes a transaction, propose a rule that would have
 * done it: "payee contains <cleaned payee>", limited to the same direction.
 */
export function suggestRule(subject: RuleSubject, categoryId: number): { match: RuleMatch; actions: RuleActions } {
  return {
    match: {
      payee: { op: "contains", value: subject.payee.trim() || cleanPayee(subject.payeeRaw) },
      direction: subject.amount < 0 ? "debit" : "credit",
    },
    actions: { categoryId },
  };
}

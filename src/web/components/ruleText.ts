import type { AccountView, CategoryView, RuleActions, RuleMatch } from "../../shared/api.ts";
import { formatMoney } from "../format.ts";

export const OP_LABELS = { contains: "contains", equals: "is exactly", startsWith: "starts with", regex: "matches pattern" } as const;

export function describeRule(
  match: RuleMatch,
  actions: RuleActions,
  categories: readonly CategoryView[],
  accounts: readonly AccountView[] = [],
): { when: string; then: string } {
  const parts: string[] = [];
  if (match.payee) parts.push(`payee ${OP_LABELS[match.payee.op]} “${match.payee.value}”`);
  if (match.direction) parts.push(match.direction === "debit" ? "money out" : "money in");
  if (match.amountMin !== undefined && match.amountMax !== undefined) {
    parts.push(`amount ${formatMoney(match.amountMin)}–${formatMoney(match.amountMax)}`);
  } else if (match.amountMin !== undefined) parts.push(`amount ≥ ${formatMoney(match.amountMin)}`);
  else if (match.amountMax !== undefined) parts.push(`amount ≤ ${formatMoney(match.amountMax)}`);
  if (match.accountId !== undefined) parts.push(`in ${accounts.find((a) => a.id === match.accountId)?.name ?? "an account"}`);

  const then: string[] = [];
  if (actions.categoryId !== undefined) then.push(`categorize as ${categories.find((c) => c.id === actions.categoryId)?.name ?? "?"}`);
  if (actions.renamePayee) then.push(`rename to “${actions.renamePayee}”`);
  return { when: parts.join(", ") || "any transaction", then: then.join(" and ") };
}

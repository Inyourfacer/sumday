import { addDays } from "../engine/dates.ts";
import { cleanPayee } from "../engine/categorize/payee.ts";
import { applyRules, ruleMatches, type Rule, type RuleMatch } from "../engine/categorize/rules.ts";
import { findTransferPairs, type TransferCandidate } from "../engine/categorize/transfers.ts";
import { transferCategoryId } from "./categories.ts";
import type { Db } from "./db.ts";

export function loadRules(db: Db): Rule[] {
  const rows = db.prepare("SELECT id, priority, match, actions FROM rules ORDER BY priority, id").all() as {
    id: number;
    priority: number;
    match: string;
    actions: string;
  }[];
  return rows.map((r) => ({ id: r.id, priority: r.priority, match: JSON.parse(r.match), actions: JSON.parse(r.actions) }));
}

export interface Categorized {
  payee: string;
  categoryId: number | null;
  ruleId: number | null;
  source: "rule" | null;
}

/** Clean the payee and run the rules on one transaction. */
export function categorize(rules: readonly Rule[], row: { accountId: number; amount: number; payeeRaw: string }): Categorized {
  const cleaned = cleanPayee(row.payeeRaw);
  const outcome = applyRules(rules, { accountId: row.accountId, amount: row.amount, payee: cleaned, payeeRaw: row.payeeRaw });
  return {
    payee: outcome?.payee ?? cleaned,
    categoryId: outcome?.categoryId ?? null,
    ruleId: outcome?.ruleId ?? null,
    source: outcome?.categoryId !== undefined ? "rule" : null,
  };
}

interface RecatRow {
  id: number;
  account_id: number;
  amount: number;
  payee: string;
  payee_raw: string;
  payee_edited: number;
  category_id: number | null;
  category_source: string | null;
  rule_id: number | null;
}

/**
 * Re-run the rules on transactions whose category came from a rule or is
 * empty. Categories set by hand and linked transfers are never touched.
 * Returns how many transactions changed.
 */
export function recategorize(db: Db, ids?: readonly number[]): number {
  const rules = loadRules(db);
  const base = `SELECT id, account_id, amount, payee, payee_raw, payee_edited, category_id, category_source, rule_id
                FROM transactions WHERE (category_source IS NULL OR category_source = 'rule')`;
  const rows =
    ids === undefined
      ? (db.prepare(base).all() as RecatRow[])
      : ids.length === 0
        ? []
        : (db.prepare(`${base} AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) as RecatRow[]);

  const update = db.prepare("UPDATE transactions SET payee = ?, category_id = ?, category_source = ?, rule_id = ? WHERE id = ?");
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const result = categorize(rules, { accountId: row.account_id, amount: row.amount, payeeRaw: row.payee_raw });
      const payee = row.payee_edited === 1 ? row.payee : result.payee;
      if (
        payee !== row.payee ||
        result.categoryId !== row.category_id ||
        result.source !== row.category_source ||
        result.ruleId !== row.rule_id
      ) {
        update.run(payee, result.categoryId, result.source, result.ruleId, row.id);
        changed += 1;
      }
    }
  })();
  return changed;
}

/** Link two transactions as a transfer pair and categorize both as Transfer. */
export function linkTransfer(db: Db, a: number, b: number): void {
  const transferId = transferCategoryId(db);
  const link = db.prepare(
    "UPDATE transactions SET transfer_id = ?, category_id = ?, category_source = 'transfer', rule_id = NULL, not_transfer = 0 WHERE id = ?",
  );
  db.transaction(() => {
    link.run(b, transferId, a);
    link.run(a, transferId, b);
  })();
}

/**
 * Unlink a transfer pair. Both sides go back to their rule-based category,
 * and are remembered as "not a transfer" so detection won't pair them again.
 */
export function unlinkTransfer(db: Db, id: number): number[] {
  const row = db.prepare("SELECT transfer_id FROM transactions WHERE id = ?").get(id) as { transfer_id: number | null } | undefined;
  const ids = [id, ...(row?.transfer_id != null ? [row.transfer_id] : [])];
  db.transaction(() => {
    const stmt = db.prepare(
      `UPDATE transactions SET transfer_id = NULL, not_transfer = 1,
         category_id = CASE WHEN category_source = 'transfer' THEN NULL ELSE category_id END,
         category_source = CASE WHEN category_source = 'transfer' THEN NULL ELSE category_source END
       WHERE id = ?`,
    );
    for (const x of ids) stmt.run(x);
  })();
  recategorize(db, ids);
  return ids;
}

/**
 * When transactions are about to disappear (undo, discard, delete), their
 * transfer partners that stay behind go back to rule-based categories.
 */
export function releasePartners(db: Db, removedIds: readonly number[]): void {
  if (removedIds.length === 0) return;
  const placeholders = removedIds.map(() => "?").join(",");
  const partners = (
    db
      .prepare(`SELECT id FROM transactions WHERE transfer_id IN (${placeholders}) AND id NOT IN (${placeholders})`)
      .all(...removedIds, ...removedIds) as { id: number }[]
  ).map((r) => r.id);
  if (partners.length === 0) return;
  const reset = db.prepare(
    `UPDATE transactions SET transfer_id = NULL,
       category_id = CASE WHEN category_source = 'transfer' THEN NULL ELSE category_id END,
       category_source = CASE WHEN category_source = 'transfer' THEN NULL ELSE category_source END
     WHERE id = ?`,
  );
  db.transaction(() => {
    for (const id of partners) reset.run(id);
  })();
  recategorize(db, partners);
}

/**
 * Find transfer pairs involving the given transactions. Partners can be any
 * posted transaction in another account within the date window, or another
 * transaction in the same set.
 */
export function detectTransfers(db: Db, ids: readonly number[], windowDays = 5): [number, number][] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const eligible = `transfer_id IS NULL AND not_transfer = 0 AND (category_source IS NULL OR category_source = 'rule')`;
  const scope = db
    .prepare(`SELECT id, account_id AS accountId, date, amount FROM transactions WHERE id IN (${placeholders}) AND ${eligible}`)
    .all(...ids) as TransferCandidate[];
  if (scope.length === 0) return [];

  const dates = scope.map((s) => s.date).sort();
  const from = addDays(dates[0]!, -windowDays);
  const to = addDays(dates.at(-1)!, windowDays);
  const others = db
    .prepare(
      `SELECT id, account_id AS accountId, date, amount FROM transactions
       WHERE status = 'posted' AND date BETWEEN ? AND ? AND id NOT IN (${placeholders}) AND ${eligible}`,
    )
    .all(from, to, ...ids) as TransferCandidate[];

  const inScope = new Set(scope.map((s) => s.id));
  const pairs = findTransferPairs([...scope, ...others], { windowDays }).filter(([a, b]) => inScope.has(a) || inScope.has(b));
  for (const [a, b] of pairs) linkTransfer(db, a, b);
  return pairs;
}

/** Posted transactions a rule's conditions would match. */
export function transactionsMatching(db: Db, match: RuleMatch): { id: number; categoryId: number | null; categorySource: string | null }[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, amount, payee, payee_raw, category_id, category_source
       FROM transactions WHERE status = 'posted' ORDER BY date DESC, id DESC`,
    )
    .all() as {
    id: number;
    account_id: number;
    amount: number;
    payee: string;
    payee_raw: string;
    category_id: number | null;
    category_source: string | null;
  }[];
  return rows
    .filter((r) => ruleMatches(match, { accountId: r.account_id, amount: r.amount, payee: r.payee, payeeRaw: r.payee_raw }))
    .map((r) => ({ id: r.id, categoryId: r.category_id, categorySource: r.category_source }));
}

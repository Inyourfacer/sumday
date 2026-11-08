import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { applyRules, suggestRule } from "../engine/categorize/rules.ts";
import type { RuleSuggestion, TransactionList, TransactionUpdateResult, TransactionView } from "../shared/api.ts";
import {
  linkTransferSchema,
  transactionInputSchema,
  transactionPatchSchema,
  transactionQuerySchema,
} from "../shared/schemas.ts";
import { getAccount } from "./accounts.ts";
import { assertCategoryExists, transferCategoryId } from "./categories.ts";
import {
  categorize,
  detectTransfers,
  linkTransfer,
  loadRules,
  recategorize,
  releasePartners,
  transactionsMatching,
  unlinkTransfer,
} from "./categorize.ts";
import type { Db } from "./db.ts";
import { badRequest, idParam, notFound, parse } from "./http.ts";

interface TxnRow {
  id: number;
  account_id: number;
  account_name: string;
  date: string;
  amount: number;
  payee: string;
  payee_raw: string;
  memo: string;
  notes: string;
  category_id: number | null;
  category_name: string | null;
  category_source: TransactionView["categorySource"];
  rule_id: number | null;
  transfer_id: number | null;
  transfer_account_name: string | null;
  status: TransactionView["status"];
  import_batch_id: number | null;
  dedupe_key: string;
}

const SELECT = `
  SELECT t.*, a.name AS account_name, c.name AS category_name, ta.name AS transfer_account_name
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN transactions tt ON tt.id = t.transfer_id
  LEFT JOIN accounts ta ON ta.id = tt.account_id`;

const ORDER = "ORDER BY t.date DESC, t.id DESC";

function toView(r: TxnRow): TransactionView {
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    date: r.date,
    amount: r.amount,
    payee: r.payee,
    payeeRaw: r.payee_raw,
    memo: r.memo,
    notes: r.notes,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categorySource: r.category_source,
    ruleId: r.rule_id,
    transferId: r.transfer_id,
    transferAccountName: r.transfer_account_name,
    status: r.status,
    importBatchId: r.import_batch_id,
    isManual: r.dedupe_key.startsWith("manual:"),
  };
}

export function getTransaction(db: Db, id: number): TransactionView {
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as TxnRow | undefined;
  if (!row) throw notFound("Transaction");
  return toView(row);
}

export function batchTransactions(db: Db, batchId: number): TransactionView[] {
  return (db.prepare(`${SELECT} WHERE t.import_batch_id = ? ${ORDER}`).all(batchId) as TxnRow[]).map(toView);
}

function listTransactions(db: Db, query: ReturnType<typeof transactionQuerySchema.parse>): TransactionList {
  const where = ["t.status = 'posted'"];
  const args: (string | number)[] = [];
  if (query.accountId !== undefined) {
    where.push("t.account_id = ?");
    args.push(query.accountId);
  }
  if (query.categoryId !== undefined) {
    where.push("t.category_id = ?");
    args.push(query.categoryId);
  }
  if (query.uncategorized) where.push("t.category_id IS NULL");
  if (query.search) {
    const fields = ["t.payee", "t.payee_raw", "t.memo", "t.notes"];
    where.push(`(${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    const like = `%${query.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    args.push(...fields.map(() => like));
  }
  if (query.from) {
    where.push("t.date >= ?");
    args.push(query.from);
  }
  if (query.to) {
    where.push("t.date <= ?");
    args.push(query.to);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${clause}`).get(...args) as { n: number }).n;
  const items = (
    db.prepare(`${SELECT} ${clause} ${ORDER} LIMIT ? OFFSET ?`).all(...args, query.limit, query.offset) as TxnRow[]
  ).map(toView);
  return { total, items };
}

/** After a manual recategorization, propose a rule unless an existing rule already does this. */
function buildSuggestion(db: Db, txn: TransactionView, categoryId: number): RuleSuggestion | null {
  if (categoryId === transferCategoryId(db)) return null;
  const subject = { accountId: txn.accountId, amount: txn.amount, payee: txn.payee, payeeRaw: txn.payeeRaw };
  const existing = applyRules(loadRules(db), subject);
  if (existing?.categoryId === categoryId) return null;
  const { match, actions } = suggestRule(subject, categoryId);
  const otherMatches = transactionsMatching(db, match).filter(
    (m) => m.id !== txn.id && m.categorySource !== "manual" && m.categorySource !== "transfer" && m.categoryId !== categoryId,
  ).length;
  return { match, actions, otherMatches };
}

export function registerTransactionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/transactions", async (request) => listTransactions(db, parse(transactionQuerySchema, request.query)));

  app.get("/api/transactions/:id", async (request) => getTransaction(db, idParam(request.params)));

  app.post("/api/transactions", async (request, reply) => {
    const input = parse(transactionInputSchema, request.body);
    getAccount(db, input.accountId);
    assertCategoryExists(db, input.categoryId);
    const auto = categorize(loadRules(db), { accountId: input.accountId, amount: input.amount, payeeRaw: input.payee });
    const manualCategory = input.categoryId !== undefined;
    const result = db
      .prepare(
        `INSERT INTO transactions (account_id, date, amount, payee, payee_raw, payee_edited, memo, notes,
           category_id, category_source, rule_id, status, dedupe_key)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'posted', ?)`,
      )
      .run(
        input.accountId,
        input.date,
        input.amount,
        input.payee,
        input.payee,
        input.memo,
        input.notes,
        manualCategory ? input.categoryId : auto.categoryId,
        manualCategory ? (input.categoryId === null ? null : "manual") : auto.source,
        manualCategory ? null : auto.ruleId,
        `manual:${randomUUID()}`,
      );
    const id = Number(result.lastInsertRowid);
    if (!manualCategory) detectTransfers(db, [id]);
    return reply.code(201).send(getTransaction(db, id));
  });

  app.patch("/api/transactions/:id", async (request): Promise<TransactionUpdateResult> => {
    const id = idParam(request.params);
    const current = getTransaction(db, id);
    const patch = parse(transactionPatchSchema, request.body);
    if ((patch.date !== undefined || patch.amount !== undefined) && !current.isManual) {
      throw badRequest("Date and amount come from the bank file and can only be changed on transactions you entered by hand.");
    }
    assertCategoryExists(db, patch.categoryId);

    let suggestion: RuleSuggestion | null = null;
    db.transaction(() => {
      if (patch.categoryId !== undefined && patch.categoryId !== current.categoryId) {
        if (current.transferId !== null && patch.categoryId !== transferCategoryId(db)) unlinkTransfer(db, id);
        db.prepare("UPDATE transactions SET category_id = ?, category_source = ?, rule_id = NULL WHERE id = ?").run(
          patch.categoryId,
          patch.categoryId === null ? null : "manual",
          id,
        );
        if (patch.categoryId === null) recategorize(db, [id]);
      }
      if (patch.payee !== undefined && patch.payee !== current.payee) {
        db.prepare("UPDATE transactions SET payee = ?, payee_edited = 1 WHERE id = ?").run(patch.payee, id);
      }
      if (patch.notes !== undefined) db.prepare("UPDATE transactions SET notes = ? WHERE id = ?").run(patch.notes, id);
      if (patch.date !== undefined) db.prepare("UPDATE transactions SET date = ? WHERE id = ?").run(patch.date, id);
      if (patch.amount !== undefined) db.prepare("UPDATE transactions SET amount = ? WHERE id = ?").run(patch.amount, id);
    })();

    const updated = getTransaction(db, id);
    if (patch.categoryId != null && patch.categoryId !== current.categoryId) {
      suggestion = buildSuggestion(db, updated, patch.categoryId);
    }
    return { transaction: updated, suggestion };
  });

  app.delete("/api/transactions/:id", async (request, reply) => {
    const id = idParam(request.params);
    const current = getTransaction(db, id);
    if (!current.isManual) {
      throw badRequest("Imported transactions are removed by undoing their import (Import → History).");
    }
    db.transaction(() => {
      releasePartners(db, [id]);
      db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    })();
    return reply.code(204).send();
  });

  app.post("/api/transactions/:id/unlink-transfer", async (request) => {
    const id = idParam(request.params);
    const current = getTransaction(db, id);
    if (current.transferId === null) throw badRequest("This transaction isn't linked as a transfer.");
    const ids = unlinkTransfer(db, id);
    return ids.map((x) => getTransaction(db, x));
  });

  app.post("/api/transactions/link-transfer", async (request) => {
    const { ids } = parse(linkTransferSchema, request.body);
    const [a, b] = ids.map((x) => getTransaction(db, x)) as [TransactionView, TransactionView];
    if (a.accountId === b.accountId) throw badRequest("A transfer needs two different accounts.");
    if (Math.sign(a.amount) === Math.sign(b.amount)) throw badRequest("One side must be money out and the other money in.");
    for (const t of [a, b]) if (t.transferId !== null) unlinkTransfer(db, t.id);
    linkTransfer(db, a.id, b.id);
    return [getTransaction(db, a.id), getTransaction(db, b.id)];
  });
}

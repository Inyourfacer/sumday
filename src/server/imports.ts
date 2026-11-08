import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseCsv } from "../engine/import/csv.ts";
import { dedupeKeys } from "../engine/import/dedupe.ts";
import { applyMapping, suggestMapping, type CsvMapping } from "../engine/import/mapping.ts";
import { looksLikeOfx, parseOfx } from "../engine/import/ofx.ts";
import type { ParseResult } from "../engine/import/types.ts";
import type { ImportBatchDetail, ImportBatchView, ImportInspectResult, ImportStatus } from "../shared/api.ts";
import { importInspectSchema, importStageSchema } from "../shared/schemas.ts";
import { getAccount, getCsvMapping, saveCsvMapping, upsertBalance } from "./accounts.ts";
import { categorize, detectTransfers, loadRules, releasePartners } from "./categorize.ts";
import type { Db } from "./db.ts";
import { badRequest, idParam, notFound, parse } from "./http.ts";
import { batchTransactions } from "./transactions.ts";

interface BatchRow {
  id: number;
  account_id: number;
  account_name: string;
  format: "csv" | "ofx";
  file_name: string;
  file_hash: string;
  status: ImportStatus;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  errors: string;
  ledger_balance: string | null;
  created_at: string;
  committed_at: string | null;
  same_file: number;
}

const SELECT = `
  SELECT b.*, a.name AS account_name,
    EXISTS (SELECT 1 FROM import_batches o WHERE o.file_hash = b.file_hash AND o.account_id = b.account_id
            AND o.id <> b.id AND o.status = 'committed') AS same_file
  FROM import_batches b JOIN accounts a ON a.id = b.account_id`;

function toView(r: BatchRow): ImportBatchView {
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    format: r.format,
    fileName: r.file_name,
    status: r.status,
    rowCount: r.row_count,
    newCount: r.new_count,
    duplicateCount: r.duplicate_count,
    errors: JSON.parse(r.errors),
    ledgerBalance: r.ledger_balance === null ? null : JSON.parse(r.ledger_balance),
    sameFileImportedBefore: r.same_file === 1,
    createdAt: r.created_at,
    committedAt: r.committed_at,
  };
}

function getBatch(db: Db, id: number): ImportBatchView {
  const row = db.prepare(`${SELECT} WHERE b.id = ?`).get(id) as BatchRow | undefined;
  if (!row) throw notFound("Import");
  return toView(row);
}

function getBatchDetail(db: Db, id: number): ImportBatchDetail {
  return { ...getBatch(db, id), transactions: batchTransactions(db, id) };
}

function detectFormat(fileName: string, content: string): "csv" | "ofx" {
  return looksLikeOfx(content) || /\.(ofx|qfx)$/i.test(fileName) ? "ofx" : "csv";
}

/** A saved mapping only applies if the file still has the columns it points at. */
function mappingFits(mapping: CsvMapping, width: number): boolean {
  const cols = [mapping.dateColumn, mapping.payeeColumn, mapping.memoColumn ?? 0];
  if (mapping.amount.mode === "single") cols.push(mapping.amount.column);
  else cols.push(mapping.amount.debitColumn, mapping.amount.creditColumn);
  return Math.max(...cols) < width;
}

function inspect(db: Db, accountId: number, fileName: string, content: string): ImportInspectResult {
  const account = getAccount(db, accountId);
  if (detectFormat(fileName, content) === "ofx") {
    const ofx = parseOfx(content);
    return {
      format: "ofx",
      ofx: {
        transactionCount: ofx.rows.length,
        accountIdLast4: ofx.account ? ofx.account.id.slice(-4) : null,
        ledgerBalance: ofx.ledgerBalance ?? null,
      },
      notes: ofx.errors.slice(0, 5).map((e) => e.message),
    };
  }
  const rows = parseCsv(content);
  if (rows.length === 0) throw badRequest("The file has no rows.");
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  const suggestion = suggestMapping(rows, account.type);
  const saved = getCsvMapping(db, accountId);
  const useSaved = saved !== undefined && mappingFits(saved, width);
  const mapping = useSaved ? saved : suggestion.mapping;
  const hasHeader = mapping?.hasHeader ?? false;
  const columns = hasHeader
    ? rows[0]!.map((h, i) => h.trim() || `Column ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  return {
    format: "csv",
    columns,
    sampleRows: rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 8),
    ...(mapping === undefined ? {} : { mapping }),
    mappingSource: useSaved ? "saved" : mapping ? "suggested" : "none",
    notes: useSaved ? [] : suggestion.notes,
  };
}

/** Throw away an unfinished import: its rows go, and any transfer partners are released. */
function removeBatchRows(db: Db, batchId: number): void {
  const ids = (db.prepare("SELECT id FROM transactions WHERE import_batch_id = ?").all(batchId) as { id: number }[]).map((r) => r.id);
  releasePartners(db, ids);
  db.prepare("DELETE FROM transactions WHERE import_batch_id = ?").run(batchId);
}

function stage(db: Db, input: ReturnType<typeof importStageSchema.parse>): ImportBatchDetail {
  const account = getAccount(db, input.accountId);
  const format = detectFormat(input.fileName, input.content);

  let parsed: ParseResult;
  let ledgerBalance: { date: string; amount: number } | null = null;
  let mappingToSave: CsvMapping | undefined;
  if (format === "ofx") {
    const ofx = parseOfx(input.content);
    parsed = ofx;
    ledgerBalance = ofx.ledgerBalance ?? null;
  } else {
    const rows = parseCsv(input.content);
    const mapping = input.mapping ?? getCsvMapping(db, account.id) ?? suggestMapping(rows, account.type).mapping;
    if (mapping === undefined) throw badRequest("Tell Sumday which columns hold the date, amount and description.");
    parsed = applyMapping(rows, mapping);
    mappingToSave = mapping;
  }
  if (parsed.rows.length === 0) {
    const first = parsed.errors[0];
    throw badRequest(
      first ? `No transactions could be read. Line ${first.line}: ${first.message}.` : "No transactions found in this file.",
    );
  }

  const rules = loadRules(db);
  const keys = dedupeKeys(parsed.rows);
  const hash = createHash("sha256").update(input.content).digest("hex");

  return db.transaction(() => {
    // One pending import per account: replace any earlier unfinished one.
    const stale = db.prepare("SELECT id FROM import_batches WHERE account_id = ? AND status = 'staged'").all(account.id) as { id: number }[];
    for (const { id } of stale) {
      removeBatchRows(db, id);
      db.prepare("UPDATE import_batches SET status = 'discarded' WHERE id = ?").run(id);
    }
    if (mappingToSave) saveCsvMapping(db, account.id, mappingToSave);

    const existing = new Set(
      (db.prepare("SELECT dedupe_key FROM transactions WHERE account_id = ?").all(account.id) as { dedupe_key: string }[]).map(
        (r) => r.dedupe_key,
      ),
    );
    const batchId = Number(
      db
        .prepare(
          `INSERT INTO import_batches (account_id, format, file_name, file_hash, status, row_count, new_count, duplicate_count, errors, ledger_balance)
           VALUES (?, ?, ?, ?, 'staged', ?, 0, 0, ?, ?)`,
        )
        .run(
          account.id,
          format,
          input.fileName,
          hash,
          parsed.rows.length,
          JSON.stringify(parsed.errors),
          ledgerBalance === null ? null : JSON.stringify(ledgerBalance),
        ).lastInsertRowid,
    );

    const insert = db.prepare(
      `INSERT INTO transactions (account_id, date, amount, payee, payee_raw, memo, category_id, category_source, rule_id,
         import_batch_id, status, dedupe_key, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)`,
    );
    const newIds: number[] = [];
    let duplicates = 0;
    parsed.rows.forEach((row, i) => {
      const key = keys[i]!;
      if (existing.has(key)) {
        duplicates += 1;
        return;
      }
      existing.add(key);
      const c = categorize(rules, { accountId: account.id, amount: row.amount, payeeRaw: row.payee });
      const result = insert.run(
        account.id,
        row.date,
        row.amount,
        c.payee,
        row.payee,
        row.memo ?? "",
        c.categoryId,
        c.source,
        c.ruleId,
        batchId,
        key,
        row.externalId ?? null,
      );
      newIds.push(Number(result.lastInsertRowid));
    });
    db.prepare("UPDATE import_batches SET new_count = ?, duplicate_count = ? WHERE id = ?").run(newIds.length, duplicates, batchId);
    detectTransfers(db, newIds);
    return getBatchDetail(db, batchId);
  })();
}

export function registerImportRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/imports/inspect", async (request) => {
    const input = parse(importInspectSchema, request.body);
    return inspect(db, input.accountId, input.fileName, input.content);
  });

  app.post("/api/imports", async (request, reply) => {
    const input = parse(importStageSchema, request.body);
    return reply.code(201).send(stage(db, input));
  });

  app.get("/api/imports", async () =>
    (db.prepare(`${SELECT} WHERE b.status <> 'discarded' ORDER BY b.id DESC LIMIT 100`).all() as BatchRow[]).map(toView),
  );

  app.get("/api/imports/:id", async (request) => getBatchDetail(db, idParam(request.params)));

  app.post("/api/imports/:id/commit", async (request) => {
    const id = idParam(request.params);
    const batch = getBatch(db, id);
    if (batch.status !== "staged") throw badRequest(`This import is already ${batch.status}.`);
    db.transaction(() => {
      db.prepare("UPDATE transactions SET status = 'posted' WHERE import_batch_id = ?").run(id);
      db.prepare("UPDATE import_batches SET status = 'committed', committed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
      if (batch.ledgerBalance) upsertBalance(db, batch.accountId, batch.ledgerBalance.date, batch.ledgerBalance.amount, "import", id);
    })();
    return getBatch(db, id);
  });

  app.post("/api/imports/:id/discard", async (request) => {
    const id = idParam(request.params);
    const batch = getBatch(db, id);
    if (batch.status !== "staged") throw badRequest("Only an import that hasn't been committed can be discarded. Use undo instead.");
    db.transaction(() => {
      removeBatchRows(db, id);
      db.prepare("UPDATE import_batches SET status = 'discarded' WHERE id = ?").run(id);
    })();
    return getBatch(db, id);
  });

  app.post("/api/imports/:id/undo", async (request) => {
    const id = idParam(request.params);
    const batch = getBatch(db, id);
    if (batch.status !== "committed") throw badRequest("Only a committed import can be undone.");
    db.transaction(() => {
      removeBatchRows(db, id);
      db.prepare("DELETE FROM balance_snapshots WHERE import_batch_id = ? AND source = 'import'").run(id);
      db.prepare("UPDATE import_batches SET status = 'undone' WHERE id = ?").run(id);
    })();
    return getBatch(db, id);
  });
}

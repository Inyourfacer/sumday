import type { FastifyInstance } from "fastify";
import type { AccountView, BalanceSnapshotView } from "../shared/api.ts";
import {
  LIABILITY_TYPES,
  accountInputSchema,
  accountPatchSchema,
  balanceInputSchema,
  defaultTaxTreatment,
  type AccountType,
  type TaxTreatment,
} from "../shared/schemas.ts";
import type { CsvMapping } from "../engine/import/mapping.ts";
import type { Db } from "./db.ts";
import { badRequest, idParam, notFound, parse } from "./http.ts";

interface AccountRow {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  tax_treatment: TaxTreatment;
  owner_person_id: number | null;
  interest_rate_pct: number | null;
  is_closed: number;
  csv_mapping: string | null;
  minimum_payment: number | null;
  promo_rate_pct: number | null;
  promo_ends: string | null;
  pays_in_full: number | null;
  snap_date: string | null;
  snap_balance: number | null;
  after_sum: number;
  last_txn_date: string | null;
  txn_count: number;
}

// Balance = latest snapshot + posted transactions dated after it
// (or the sum of all posted transactions if there's no snapshot).
const ACCOUNT_SELECT = `
  SELECT a.*,
    s.date AS snap_date,
    s.balance AS snap_balance,
    COALESCE((SELECT SUM(t.amount) FROM transactions t
              WHERE t.account_id = a.id AND t.status = 'posted'
                AND (s.date IS NULL OR t.date > s.date)), 0) AS after_sum,
    (SELECT MAX(t.date) FROM transactions t WHERE t.account_id = a.id AND t.status = 'posted') AS last_txn_date,
    (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.status = 'posted') AS txn_count
  FROM accounts a
  LEFT JOIN balance_snapshots s ON s.id = (
    SELECT id FROM balance_snapshots WHERE account_id = a.id ORDER BY date DESC LIMIT 1
  )`;

function toView(r: AccountRow): AccountView {
  const asOf = [r.snap_date, r.last_txn_date].filter((d): d is string => d !== null).sort().at(-1) ?? null;
  return {
    id: r.id,
    name: r.name,
    institution: r.institution,
    type: r.type,
    taxTreatment: r.tax_treatment,
    ownerPersonId: r.owner_person_id,
    interestRatePct: r.interest_rate_pct,
    isClosed: r.is_closed === 1,
    isLiability: LIABILITY_TYPES.includes(r.type),
    minimumPayment: r.minimum_payment,
    promoRatePct: r.promo_rate_pct,
    promoEnds: r.promo_ends,
    paysInFull: r.pays_in_full === null ? r.type === "credit_card" : r.pays_in_full === 1,
    balance: (r.snap_balance ?? 0) + r.after_sum,
    balanceAsOf: asOf,
    transactionCount: r.txn_count,
    hasCsvMapping: r.csv_mapping !== null,
  };
}

export function listAccounts(db: Db): AccountView[] {
  const rows = db.prepare(`${ACCOUNT_SELECT} ORDER BY a.is_closed, a.name COLLATE NOCASE`).all() as AccountRow[];
  return rows.map(toView);
}

export function getAccount(db: Db, id: number): AccountView {
  const row = db.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?`).get(id) as AccountRow | undefined;
  if (!row) throw notFound("Account");
  return toView(row);
}

export function getCsvMapping(db: Db, accountId: number): CsvMapping | undefined {
  const row = db.prepare("SELECT csv_mapping FROM accounts WHERE id = ?").get(accountId) as
    | { csv_mapping: string | null }
    | undefined;
  if (!row) throw notFound("Account");
  return row.csv_mapping === null ? undefined : (JSON.parse(row.csv_mapping) as CsvMapping);
}

export function saveCsvMapping(db: Db, accountId: number, mapping: CsvMapping): void {
  db.prepare("UPDATE accounts SET csv_mapping = ? WHERE id = ?").run(JSON.stringify(mapping), accountId);
}

function checkOwner(db: Db, ownerPersonId: number | null | undefined): void {
  if (ownerPersonId == null) return;
  if (!db.prepare("SELECT 1 FROM people WHERE id = ?").get(ownerPersonId)) throw badRequest("That person doesn't exist.");
}

function listBalances(db: Db, accountId: number): BalanceSnapshotView[] {
  return db
    .prepare("SELECT id, date, balance, source FROM balance_snapshots WHERE account_id = ? ORDER BY date DESC")
    .all(accountId) as BalanceSnapshotView[];
}

export function upsertBalance(
  db: Db,
  accountId: number,
  date: string,
  balance: number,
  source: "manual" | "import",
  importBatchId: number | null = null,
): void {
  db.prepare(
    `INSERT INTO balance_snapshots (account_id, date, balance, source, import_batch_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, date) DO UPDATE SET balance = excluded.balance, source = excluded.source,
       import_batch_id = excluded.import_batch_id`,
  ).run(accountId, date, balance, source, importBatchId);
}

export function registerAccountRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/accounts", async () => listAccounts(db));

  app.get("/api/accounts/:id", async (request) => getAccount(db, idParam(request.params)));

  app.post("/api/accounts", async (request, reply) => {
    const input = parse(accountInputSchema, request.body);
    checkOwner(db, input.ownerPersonId);
    const result = db
      .prepare(
        `INSERT INTO accounts (name, institution, type, tax_treatment, owner_person_id, interest_rate_pct, is_closed,
           minimum_payment, promo_rate_pct, promo_ends, pays_in_full)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.institution,
        input.type,
        input.taxTreatment ?? defaultTaxTreatment(input.type),
        input.ownerPersonId,
        input.interestRatePct,
        input.isClosed ? 1 : 0,
        input.minimumPayment,
        input.promoRatePct,
        input.promoEnds,
        input.paysInFull === null ? null : input.paysInFull ? 1 : 0,
      );
    return reply.code(201).send(getAccount(db, Number(result.lastInsertRowid)));
  });

  app.patch("/api/accounts/:id", async (request) => {
    const id = idParam(request.params);
    const current = getAccount(db, id);
    const patch = parse(accountPatchSchema, request.body);
    checkOwner(db, patch.ownerPersonId);
    const type = patch.type ?? current.type;
    const taxTreatment =
      patch.taxTreatment ?? (patch.type !== undefined && patch.type !== current.type ? defaultTaxTreatment(type) : current.taxTreatment);
    db.prepare(
      `UPDATE accounts SET name = ?, institution = ?, type = ?, tax_treatment = ?, owner_person_id = ?,
         interest_rate_pct = ?, is_closed = ?, minimum_payment = ?, promo_rate_pct = ?, promo_ends = ?,
         pays_in_full = COALESCE(?, pays_in_full) WHERE id = ?`,
    ).run(
      patch.name ?? current.name,
      patch.institution ?? current.institution,
      type,
      taxTreatment,
      patch.ownerPersonId === undefined ? current.ownerPersonId : patch.ownerPersonId,
      patch.interestRatePct === undefined ? current.interestRatePct : patch.interestRatePct,
      (patch.isClosed ?? current.isClosed) ? 1 : 0,
      patch.minimumPayment === undefined ? current.minimumPayment : patch.minimumPayment,
      patch.promoRatePct === undefined ? current.promoRatePct : patch.promoRatePct,
      patch.promoEnds === undefined ? current.promoEnds : patch.promoEnds,
      patch.paysInFull === undefined || patch.paysInFull === null ? null : patch.paysInFull ? 1 : 0,
      id,
    );
    return getAccount(db, id);
  });

  app.delete("/api/accounts/:id", async (request, reply) => {
    const id = idParam(request.params);
    getAccount(db, id);
    db.transaction(() => {
      // Transfers pointing into this account lose their partner; put them back to uncategorized.
      db.prepare(
        `UPDATE transactions SET category_id = NULL, category_source = NULL
         WHERE category_source = 'transfer' AND transfer_id IN (SELECT id FROM transactions WHERE account_id = ?)`,
      ).run(id);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    })();
    return reply.code(204).send();
  });

  app.delete("/api/accounts/:id/csv-mapping", async (request) => {
    const id = idParam(request.params);
    db.prepare("UPDATE accounts SET csv_mapping = NULL WHERE id = ?").run(id);
    return getAccount(db, id);
  });

  app.get("/api/accounts/:id/balances", async (request) => {
    const id = idParam(request.params);
    getAccount(db, id);
    return listBalances(db, id);
  });

  app.post("/api/accounts/:id/balances", async (request, reply) => {
    const id = idParam(request.params);
    getAccount(db, id);
    const { date, balance } = parse(balanceInputSchema, request.body);
    upsertBalance(db, id, date, balance, "manual");
    return reply.code(201).send(listBalances(db, id));
  });

  app.delete("/api/balances/:id", async (request, reply) => {
    const result = db.prepare("DELETE FROM balance_snapshots WHERE id = ?").run(idParam(request.params));
    if (result.changes === 0) throw notFound("Balance");
    return reply.code(204).send();
  });
}

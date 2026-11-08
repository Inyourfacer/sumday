/**
 * Backups and export. A backup is a full copy of the database made with
 * SQLite's online backup (safe while the app is running). Sumday keeps the
 * newest 30. Export gives your data in open formats: everything as JSON, and
 * transactions as CSV.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { BackupView } from "../shared/api.ts";
import { today } from "./budget.ts";
import { schemaVersion, type Db } from "./db.ts";
import { badRequest } from "./http.ts";

export const KEEP_BACKUPS = 30;
const NAME = /^sumday-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.db$/;

export function listBackups(dir: string | null): BackupView[] {
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => NAME.test(n))
    .map((n) => {
      const s = statSync(join(dir, n));
      return { name: n, date: NAME.exec(n)![1]!, size: s.size, createdAt: s.mtime.toISOString() };
    })
    // Newest first: by day, then by when the file was written.
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.name < b.name ? 1 : -1));
}

/** Make a backup now. `daily` names it by date only, so there's one per day. */
export async function backup(db: Db, dir: string, kind: "daily" | "manual" = "manual"): Promise<BackupView> {
  mkdirSync(dir, { recursive: true });
  const date = today(db);
  const time = new Date().toISOString().slice(11, 19).replaceAll(":", "");
  const name = kind === "daily" ? `sumday-${date}.db` : `sumday-${date}-${time}.db`;
  await db.backup(join(dir, name));
  pruneBackups(dir);
  return listBackups(dir).find((b) => b.name === name)!;
}

export function pruneBackups(dir: string, keep = KEEP_BACKUPS): string[] {
  const removed: string[] = [];
  for (const b of listBackups(dir).slice(keep)) {
    unlinkSync(join(dir, b.name));
    removed.push(b.name);
  }
  return removed;
}

/** Today's daily backup, if there isn't one yet. */
export async function ensureDailyBackup(db: Db, dir: string): Promise<string | null> {
  const date = today(db);
  if (listBackups(dir).some((b) => b.date === date)) return null;
  return (await backup(db, dir, "daily")).name;
}

// ---------- Export ----------

const EXPORT_TABLES = [
  "settings",
  "people",
  "accounts",
  "balance_snapshots",
  "categories",
  "category_budgets",
  "rules",
  "transactions",
  "recurring_ignored",
  "goals",
  "goal_allocations",
  "securities",
  "holdings",
  "prices",
  "scenarios",
  "reports",
] as const;
const JSON_COLUMNS = new Set(["value", "profile", "csv_mapping", "holdings_mapping", "match", "actions", "asset_mix", "overrides", "data"]);

export function exportJson(db: Db): Record<string, unknown> {
  const tables: Record<string, unknown[]> = {};
  for (const t of EXPORT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    tables[t] = rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => {
          if (JSON_COLUMNS.has(k) && typeof v === "string") {
            try {
              return [k, JSON.parse(v)];
            } catch {
              return [k, v];
            }
          }
          return [k, v];
        }),
      ),
    );
  }
  return { app: "sumday", schemaVersion: schemaVersion(db), exportedAt: new Date().toISOString(), note: "Amounts are in cents.", tables };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote when needed; a leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function exportTransactionsCsv(db: Db): string {
  const rows = db
    .prepare(
      `SELECT t.date, a.name AS account, t.payee, t.payee_raw AS original_payee, printf('%.2f', t.amount / 100.0) AS amount,
         c.name AS category, c.group_name AS category_group, t.memo, t.notes,
         CASE WHEN t.transfer_id IS NOT NULL THEN 'yes' ELSE '' END AS transfer, t.id
       FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.status = 'posted' ORDER BY t.date, t.id`,
    )
    .all() as Record<string, unknown>[];
  const header = ["date", "account", "payee", "original_payee", "amount", "category", "category_group", "memo", "notes", "transfer", "id"];
  return [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\r\n") + "\r\n";
}

export function registerBackupRoutes(app: FastifyInstance, db: Db, dir: string | null): void {
  app.get("/api/backups", async () => ({ dir, keep: KEEP_BACKUPS, backups: listBackups(dir) }));

  app.post("/api/backups", async (_request, reply) => {
    if (!dir) throw badRequest("Backups aren't set up for this database.");
    return reply.code(201).send(await backup(db, dir, "manual"));
  });

  app.get("/api/export/json", async (_request, reply) => {
    reply.header("content-disposition", `attachment; filename="sumday-${today(db)}.json"`);
    return exportJson(db);
  });

  app.get("/api/export/transactions.csv", async (_request, reply) => {
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="sumday-transactions-${today(db)}.csv"`);
    return exportTransactionsCsv(db);
  });
}

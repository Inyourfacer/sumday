import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrations as defaultMigrations, type Migration } from "./migrations/index.ts";

export type Db = Database.Database;

/** Open (creating if needed) the database file and bring its schema up to date. */
export function openDb(path: string, migrations: readonly Migration[] = defaultMigrations): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, migrations);
  return db;
}

/**
 * Apply any migrations newer than the database's current version. Each one
 * runs in its own transaction, so a failure leaves the database at the last
 * good version.
 */
export function migrate(db: Db, migrations: readonly Migration[] = defaultMigrations): number[] {
  checkMigrationList(migrations);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);

  const current = schemaVersion(db);
  const known = migrations.at(-1)?.version ?? 0;
  if (current > known) {
    throw new Error(
      `Database schema is version ${current}, but this copy of Sumday only knows up to ${known}. ` +
        `Update Sumday before opening this database.`,
    );
  }

  const applied: number[] = [];
  const record = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name);
    })();
    applied.push(m.version);
  }
  return applied;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

function checkMigrationList(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migration versions must be 1, 2, 3…; found ${m.version} at position ${i + 1} (${m.name})`);
    }
  });
}

/** Read a JSON setting, or undefined if it isn't set. */
export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.value) as T);
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(key, JSON.stringify(value));
}

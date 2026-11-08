/**
 * Database migrations, applied in order and exactly once each.
 *
 * Rules:
 * - Never edit or reorder a migration that has been released; add a new one.
 * - Versions are consecutive integers starting at 1.
 * - Money columns are INTEGER cents; dates are TEXT 'YYYY-MM-DD'.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "settings",
    sql: `
      -- Key/value store for app and household settings. Values are JSON.
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL CHECK (json_valid(value)),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
    `,
  },
];

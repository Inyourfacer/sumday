import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSetting, migrate, openDb, schemaVersion, setSetting } from "./db.ts";
import type { Migration } from "./migrations/index.ts";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sumday-test-"));
  dirs.push(dir);
  return join(dir, "nested", "sumday.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testMigrations: Migration[] = [
  { version: 1, name: "a", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;" },
  { version: 2, name: "b", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT;" },
];

describe("migrations", () => {
  it("creates the file and folder, and applies the real migrations", () => {
    const db = openDb(tempDbPath());
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("applies each migration once, in order", () => {
    const db = openDb(":memory:", testMigrations.slice(0, 1));
    expect(schemaVersion(db)).toBe(1);
    expect(migrate(db, testMigrations)).toEqual([2]);
    expect(migrate(db, testMigrations)).toEqual([]);
    expect(schemaVersion(db)).toBe(2);
    db.close();
  });

  it("keeps data across reopening", () => {
    const path = tempDbPath();
    const first = openDb(path);
    setSetting(first, "household.name", "Test household");
    first.close();
    const second = openDb(path);
    expect(getSetting(second, "household.name")).toBe("Test household");
    second.close();
  });

  it("rolls back a failing migration and keeps the last good version", () => {
    const db = openDb(":memory:", testMigrations.slice(0, 1));
    const broken: Migration[] = [
      ...testMigrations.slice(0, 1),
      { version: 2, name: "broken", sql: "CREATE TABLE c (id INTEGER); SELECT * FROM no_such_table;" },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(schemaVersion(db)).toBe(1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").all();
    expect(tables).toEqual([]);
    db.close();
  });

  it("refuses a database newer than the app", () => {
    const db = openDb(":memory:", testMigrations);
    expect(() => migrate(db, testMigrations.slice(0, 1))).toThrow(/only knows up to 1/);
    db.close();
  });

  it("rejects gaps in migration versions", () => {
    const gappy: Migration[] = [testMigrations[0]!, { version: 3, name: "c", sql: "" }];
    expect(() => openDb(":memory:", gappy)).toThrow(/must be 1, 2, 3/);
  });
});

describe("settings", () => {
  it("stores JSON values and overwrites them", () => {
    const db = openDb(":memory:");
    expect(getSetting(db, "missing")).toBeUndefined();
    setSetting(db, "plan.successTarget", 0.85);
    setSetting(db, "plan.successTarget", 0.9);
    setSetting(db, "household", { state: "TX", people: 2 });
    expect(getSetting(db, "plan.successTarget")).toBe(0.9);
    expect(getSetting(db, "household")).toEqual({ state: "TX", people: 2 });
    db.close();
  });
});

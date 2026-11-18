import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("uses local defaults", () => {
    const config = loadConfig({}, "/home/me/sumday");
    expect(config).toEqual({
      dbPath: resolve("/home/me/sumday/var/sumday.db"),
      port: 4321,
      host: "127.0.0.1",
      webDir: resolve("/home/me/sumday/dist"),
      backupDir: resolve("/home/me/sumday/var/backups"),
    });
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({ SUMDAY_DB: "/data/money.db", SUMDAY_PORT: "8080" }, "/home/me/sumday");
    expect(config.dbPath).toBe(resolve("/data/money.db"));
    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(loadConfig({ SUMDAY_BACKUP_DIR: "/backups" }).backupDir).toBe(resolve("/backups"));
  });

  it("rejects a bad port", () => {
    expect(() => loadConfig({ SUMDAY_PORT: "abc" })).toThrow(/SUMDAY_PORT/);
    expect(() => loadConfig({ SUMDAY_PORT: "70000" })).toThrow(/SUMDAY_PORT/);
  });
});

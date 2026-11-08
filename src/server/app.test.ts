import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthResponse } from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, schemaVersion, setSetting } from "./db.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function setup(webDir?: string) {
  const db = openDb(":memory:");
  const app = await buildApp({ db, webDir });
  cleanups.push(() => {
    void app.close();
    db.close();
  });
  return { db, app };
}

describe("API", () => {
  it("reports health and schema version", async () => {
    const { db, app } = await setup();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthResponse>();
    expect(body).toMatchObject({ status: "ok", app: "sumday", setupComplete: false });
    expect(body.schemaVersion).toBe(schemaVersion(db));
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reflects setup status from settings", async () => {
    const { db, app } = await setup();
    setSetting(db, "setup.complete", true);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json<HealthResponse>().setupComplete).toBe(true);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });
});

describe("web UI serving", () => {
  it("serves the app shell for client-side routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sumday-web-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Sumday</title>");

    const { app } = await setup(dir);
    for (const url of ["/", "/spending", "/settings/household"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain("<title>Sumday</title>");
    }
    const api = await app.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);
  });
});

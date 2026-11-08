import { existsSync, readFileSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse, SummaryResponse } from "../shared/api.ts";
import { registerAccountRoutes } from "./accounts.ts";
import { registerBudgetRoutes } from "./budget.ts";
import { registerPlanRoutes } from "./plan.ts";
import { registerInvestmentRoutes } from "./investments.ts";
import { registerRetirementRoutes } from "./retirement.ts";
import { tiingoProvider, type PriceProvider } from "./prices.ts";
import { registerCategoryRoutes } from "./categories.ts";
import { schemaVersion, type Db } from "./db.ts";
import { registerHouseholdRoutes, isSetupComplete, setupGaps } from "./household.ts";
import { installErrorHandler } from "./http.ts";
import { registerImportRoutes } from "./imports.ts";
import { registerRuleRoutes } from "./rules.ts";
import { registerTransactionRoutes } from "./transactions.ts";

export interface AppOptions {
  db: Db;
  /** Directory of the built web UI. Skipped if missing (e.g. in `npm run dev`, where Vite serves it). */
  webDir?: string;
  logger?: boolean;
  /** Where daily prices come from. Defaults to Tiingo with TIINGO_API_KEY. */
  priceProvider?: PriceProvider;
}

const version = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

export async function buildApp({ db, webDir, logger = false, priceProvider }: AppOptions): Promise<FastifyInstance> {
  const prices = priceProvider ?? tiingoProvider(process.env.TIINGO_API_KEY);
  // Bank exports can be several MB; allow up to ~15 MB of JSON.
  const app = Fastify({ logger, bodyLimit: 15 * 1024 * 1024 });
  installErrorHandler(app);

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    app: "sumday",
    version,
    schemaVersion: schemaVersion(db),
    setupComplete: isSetupComplete(db),
  }));

  app.get("/api/summary", async (): Promise<SummaryResponse> => ({
    setupComplete: isSetupComplete(db),
    accountCount: count(db, "SELECT COUNT(*) AS n FROM accounts WHERE is_closed = 0"),
    transactionCount: count(db, "SELECT COUNT(*) AS n FROM transactions WHERE status = 'posted'"),
    uncategorizedCount: count(db, "SELECT COUNT(*) AS n FROM transactions WHERE status = 'posted' AND category_id IS NULL"),
    stagedImportCount: count(db, "SELECT COUNT(*) AS n FROM import_batches WHERE status = 'staged'"),
    setupGaps: setupGaps(db),
  }));

  registerHouseholdRoutes(app, db);
  registerAccountRoutes(app, db);
  registerCategoryRoutes(app, db);
  registerRuleRoutes(app, db);
  registerTransactionRoutes(app, db);
  registerImportRoutes(app, db);
  registerBudgetRoutes(app, db);
  registerPlanRoutes(app, db);
  registerInvestmentRoutes(app, db, prices);
  registerRetirementRoutes(app, db);

  if (webDir !== undefined && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    // Client-side routing: any non-API page loads the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" }));
  }

  return app;
}

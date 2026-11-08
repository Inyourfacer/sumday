import { existsSync, readFileSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "../shared/api.ts";
import { getSetting, schemaVersion, type Db } from "./db.ts";

export interface AppOptions {
  db: Db;
  /** Directory of the built web UI. Skipped if missing (e.g. in `npm run dev`, where Vite serves it). */
  webDir?: string;
  logger?: boolean;
}

const version = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export async function buildApp({ db, webDir, logger = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    app: "sumday",
    version,
    schemaVersion: schemaVersion(db),
    setupComplete: getSetting<boolean>(db, "setup.complete") ?? false,
  }));

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

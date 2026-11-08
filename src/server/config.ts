import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Port the local web app listens on. */
  port: number;
  /** Interface to bind. Localhost only, so the app is not reachable from the network. */
  host: string;
  /** Built web UI to serve, if it exists. */
  webDir: string;
}

const DEFAULT_PORT = 4321;

/** Read settings from the environment (and `.env` if present). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const port = env.SUMDAY_PORT === undefined || env.SUMDAY_PORT === "" ? DEFAULT_PORT : Number(env.SUMDAY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SUMDAY_PORT must be a port number (1–65535), got "${env.SUMDAY_PORT}"`);
  }
  return {
    dbPath: resolve(cwd, env.SUMDAY_DB || "var/sumday.db"),
    port,
    host: "127.0.0.1",
    webDir: resolve(cwd, "dist"),
  };
}

/** Load `.env` into process.env, if the file exists. Existing variables win. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = resolve(cwd, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

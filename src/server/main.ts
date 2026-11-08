import { buildApp } from "./app.ts";
import { loadConfig, loadDotEnv } from "./config.ts";
import { openDb, schemaVersion } from "./db.ts";

loadDotEnv();
const config = loadConfig();
const db = openDb(config.dbPath);
const app = await buildApp({ db, webDir: config.webDir });

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down.`);
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
console.log(`Sumday is running at http://${config.host}:${config.port}`);
console.log(`Database: ${config.dbPath} (schema v${schemaVersion(db)})`);

import { ensureDailyBackup } from "../server/backup.ts";
import type { Db } from "../server/db.ts";
import { refreshPrices } from "../server/holdings.ts";
import type { PriceProvider } from "../server/prices.ts";
import { ensureLastMonthReport } from "../server/reports.ts";

const SIX_HOURS = 6 * 60 * 60 * 1000;
const HOURLY = 60 * 60 * 1000;

export interface SchedulerOptions {
  /** Daily backups go here; omit to turn them off. */
  backupDir?: string;
  log?: (msg: string) => void;
}

/**
 * Background jobs, run inside the server process. Each job is idempotent and
 * catches up on its own, so a machine that was asleep just picks up where it
 * left off:
 * - prices every 6 hours (from the last day they have);
 * - a backup once a day (checked hourly, newest 30 kept);
 * - last month's review report on the 1st (or the first time Sumday runs after).
 */
export function startScheduler(db: Db, provider: PriceProvider, { backupDir, log = console.log }: SchedulerOptions = {}): () => void {
  const runPrices = async () => {
    if (!provider.configured) return;
    try {
      const s = await refreshPrices(db, provider);
      if (s.updated || s.errors.length) log(`Prices: ${s.updated} new closes${s.errors.length ? `, ${s.errors.length} problem(s)` : ""}.`);
    } catch (err) {
      log(`Price refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const runDaily = async () => {
    if (backupDir) {
      try {
        const name = await ensureDailyBackup(db, backupDir);
        if (name) log(`Backup: ${name}`);
      } catch (err) {
        log(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const month = ensureLastMonthReport(db);
      if (month) log(`Monthly report for ${month} is ready.`);
    } catch (err) {
      log(`Monthly report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const first = setTimeout(() => void runPrices(), 5_000);
  const firstDaily = setTimeout(() => void runDaily(), 10_000);
  const every = setInterval(() => void runPrices(), SIX_HOURS);
  const hourly = setInterval(() => void runDaily(), HOURLY);
  if (!provider.configured) log("No TIINGO_API_KEY set: daily prices are off (manual prices still work).");
  return () => {
    clearTimeout(first);
    clearTimeout(firstDaily);
    clearInterval(every);
    clearInterval(hourly);
  };
}

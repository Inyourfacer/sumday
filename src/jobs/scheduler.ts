import type { Db } from "../server/db.ts";
import { refreshPrices } from "../server/holdings.ts";
import type { PriceProvider } from "../server/prices.ts";

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Background jobs, run inside the server process. Each job is idempotent and
 * catches up on its own (prices fetch from the last day they have), so a
 * machine that was asleep just picks up where it left off.
 */
export function startScheduler(db: Db, provider: PriceProvider, log: (msg: string) => void = console.log): () => void {
  const runPrices = async () => {
    if (!provider.configured) return;
    try {
      const s = await refreshPrices(db, provider);
      if (s.updated || s.errors.length) log(`Prices: ${s.updated} new closes${s.errors.length ? `, ${s.errors.length} problem(s)` : ""}.`);
    } catch (err) {
      log(`Price refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const first = setTimeout(() => void runPrices(), 5_000);
  const every = setInterval(() => void runPrices(), SIX_HOURS);
  if (!provider.configured) log("No TIINGO_API_KEY set: daily prices are off (manual prices still work).");
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

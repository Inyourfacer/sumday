import { addDays, parseIsoDate, type IsoDate } from "../engine/dates.ts";
import { defaultMix, validateMix, type AssetMix } from "../engine/invest/classify.ts";
import type { Position, Target } from "../engine/invest/portfolio.ts";
import type { TaxTreatment } from "../shared/schemas.ts";
import { upsertBalance } from "./accounts.ts";
import { today } from "./budget.ts";
import { getSetting, type Db } from "./db.ts";
import { PriceError, type PriceProvider } from "./prices.ts";

export const DEFAULT_TARGET: Target = { us_stock: 0.6, intl_stock: 0.3, bonds: 0.1 };

/** Accounts whose holdings make up the investment portfolio (529s are for school, so they're left out). */
export const PORTFOLIO_TYPES = ["brokerage", "401k", "403b", "457", "ira", "roth_ira", "hsa"];

export function getTarget(db: Db): { target: Target; isDefault: boolean } {
  const stored = getSetting<Target>(db, "investments.target");
  return stored ? { target: stored, isDefault: false } : { target: DEFAULT_TARGET, isDefault: true };
}

export interface SecurityRow {
  id: number;
  ticker: string | null;
  name: string;
  proxy_ticker: string | null;
  expense_ratio: number | null;
  asset_mix: string | null;
  mix_source: "known" | "guessed" | "manual" | null;
  price_error: string | null;
}

/** Find a security by ticker (or by name when there's no ticker), creating it with a guessed mix. */
export function findOrCreateSecurity(db: Db, ticker: string | null, name: string): number {
  const existing = (
    ticker
      ? db.prepare("SELECT id FROM securities WHERE ticker = ? COLLATE NOCASE").get(ticker)
      : db.prepare("SELECT id FROM securities WHERE ticker IS NULL AND name = ? COLLATE NOCASE").get(name)
  ) as { id: number } | undefined;
  if (existing) return existing.id;
  const guess = defaultMix(ticker, name);
  const result = db
    .prepare("INSERT INTO securities (ticker, name, asset_mix, mix_source) VALUES (?, ?, ?, ?)")
    .run(ticker, name || ticker || "Unnamed", guess ? JSON.stringify(guess.mix) : null, guess?.source ?? null);
  return Number(result.lastInsertRowid);
}

export function setPrice(db: Db, securityId: number, date: IsoDate, close: number, source: "provider" | "import" | "manual" | "proxy"): void {
  // Prices you enter by hand are never overwritten by a feed.
  db.prepare(
    `INSERT INTO prices (security_id, date, close, source) VALUES (?, ?, ?, ?)
     ON CONFLICT (security_id, date) DO UPDATE SET close = excluded.close, source = excluded.source
     WHERE prices.source <> 'manual' OR excluded.source = 'manual'`,
  ).run(securityId, date, close, source);
}

export interface HoldingRow {
  id: number;
  account_id: number;
  account_name: string;
  account_type: string;
  tax_treatment: TaxTreatment;
  owner_person_id: number | null;
  security_id: number;
  ticker: string | null;
  name: string;
  proxy_ticker: string | null;
  expense_ratio: number | null;
  asset_mix: string | null;
  mix_source: SecurityRow["mix_source"];
  price_error: string | null;
  shares: number;
  cost_basis: number | null;
  price: number | null;
  price_date: string | null;
  price_source: string | null;
}

export function loadHoldings(db: Db, accountId?: number): HoldingRow[] {
  return db
    .prepare(
      `SELECT h.id, h.account_id, a.name AS account_name, a.type AS account_type, a.tax_treatment, a.owner_person_id,
         s.id AS security_id, s.ticker, s.name, s.proxy_ticker, s.expense_ratio, s.asset_mix, s.mix_source, s.price_error,
         h.shares, h.cost_basis, p.close AS price, p.date AS price_date, p.source AS price_source
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN prices p ON p.security_id = s.id AND p.date = (SELECT MAX(date) FROM prices WHERE security_id = s.id)
       WHERE a.is_closed = 0 ${accountId === undefined ? "" : "AND h.account_id = ?"}
       ORDER BY a.name, COALESCE(s.ticker, s.name)`,
    )
    .all(...(accountId === undefined ? [] : [accountId])) as HoldingRow[];
}

export function holdingValue(h: Pick<HoldingRow, "shares" | "price">): number {
  return h.price === null ? 0 : Math.round(h.shares * h.price * 100);
}

export function toPositions(rows: readonly HoldingRow[]): Position[] {
  return rows
    .filter((h) => PORTFOLIO_TYPES.includes(h.account_type))
    .map((h) => ({
      holdingId: h.id,
      accountId: h.account_id,
      accountName: h.account_name,
      ownerId: h.owner_person_id,
      taxTreatment: h.tax_treatment,
      label: h.ticker ?? h.name,
      value: holdingValue(h),
      mix: h.asset_mix ? (JSON.parse(h.asset_mix) as AssetMix) : null,
      costBasis: h.cost_basis,
      expenseRatio: h.expense_ratio,
    }));
}

/**
 * Record each holdings account's market value as a balance snapshot dated
 * today, so account balances and net worth history use real prices.
 */
export function snapshotHoldingsAccounts(db: Db, accountIds?: readonly number[]): void {
  const date = today(db);
  const rows = loadHoldings(db);
  const ids = accountIds ?? [...new Set(rows.map((h) => h.account_id))];
  for (const id of ids) {
    const value = rows.filter((h) => h.account_id === id).reduce((s, h) => s + holdingValue(h), 0);
    upsertBalance(db, id, date, value, "import");
  }
}

/**
 * The most recent trading day whose close should already be published:
 * yesterday, or Friday over a weekend and on Monday. (Holidays just cost one
 * extra, empty request.)
 */
export function latestExpectedClose(now: IsoDate): IsoDate {
  const { year, month, day } = parseIsoDate(now);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  const back = weekday === 0 ? 2 : weekday === 1 ? 3 : weekday === 6 ? 1 : 1;
  return addDays(now, -back);
}

export interface RefreshSummary {
  provider: string;
  configured: boolean;
  updated: number;
  errors: { ticker: string; message: string }[];
}

/**
 * Fetch closes for every held security with a ticker, from the day after its
 * last price (or the last 10 days) to today, then fill proxy-priced funds.
 * Safe to run any number of times; catches up after days the machine was off.
 */
export async function refreshPrices(db: Db, provider: PriceProvider): Promise<RefreshSummary> {
  const summary: RefreshSummary = { provider: provider.name, configured: provider.configured, updated: 0, errors: [] };
  if (!provider.configured) return summary;
  const now = today(db);
  const held = db
    .prepare(
      `SELECT DISTINCT s.id, s.ticker, s.proxy_ticker, (SELECT MAX(date) FROM prices WHERE security_id = s.id AND source = 'provider') AS last
       FROM securities s JOIN holdings h ON h.security_id = s.id JOIN accounts a ON a.id = h.account_id
       WHERE a.is_closed = 0 AND h.shares <> 0`,
    )
    .all() as { id: number; ticker: string | null; proxy_ticker: string | null; last: string | null }[];
  // Free price plans allow only so many requests an hour: skip anything already up to date.
  const expected = latestExpectedClose(now);

  const setError = db.prepare("UPDATE securities SET price_error = ? WHERE id = ?");
  for (const s of held) {
    try {
      if (s.ticker) {
        if (/^(SPAXX|FDRXX|VMFXX|SWVXX|FZFXX|VUSXX|CORE)$/i.test(s.ticker)) {
          // Money market funds hold $1 a share.
          setPrice(db, s.id, now, 1, "import");
          setError.run(null, s.id);
          continue;
        }
        // From the day after the last feed price: a price from an imported file (or one typed in)
        // doesn't stop the feed from filling in that day's official close.
        if (s.last && s.last >= expected) continue;
        const from = s.last ? addDays(s.last, 1) : addDays(now, -10);
        if (from > now) continue;
        const closes = await provider.fetchCloses(s.ticker, from, now);
        for (const c of closes) setPrice(db, s.id, c.date, c.close, "provider");
        // A positions file is stamped with the day it was imported, but its "last price" is really
        // the latest close. Once the feed has that close, drop the newer-dated file price.
        const latest = db.prepare("SELECT MAX(date) AS d FROM prices WHERE security_id = ? AND source = 'provider'").get(s.id) as { d: string | null };
        if (latest.d) db.prepare("DELETE FROM prices WHERE security_id = ? AND source = 'import' AND date > ?").run(s.id, latest.d);
        summary.updated += closes.length;
        setError.run(null, s.id);
      } else if (s.proxy_ticker) {
        const lastProxy = db.prepare("SELECT MAX(date) AS d FROM prices WHERE security_id = ? AND source = 'proxy'").get(s.id) as { d: string | null };
        if (lastProxy.d && lastProxy.d >= expected) continue;
        summary.updated += await refreshProxy(db, provider, s.id, s.proxy_ticker, now);
        setError.run(null, s.id);
      }
    } catch (err) {
      const message = err instanceof PriceError ? err.message : `Price update failed: ${err instanceof Error ? err.message : String(err)}`;
      setError.run(message, s.id);
      summary.errors.push({ ticker: s.ticker ?? s.proxy_ticker ?? `#${s.id}`, message });
    }
  }
  snapshotHoldingsAccounts(db);
  return summary;
}

/**
 * A fund without a ticker follows its proxy: from the last real price (from a
 * statement or typed in), each day's price moves by the proxy's % change.
 */
async function refreshProxy(db: Db, provider: PriceProvider, securityId: number, proxy: string, now: IsoDate): Promise<number> {
  const anchor = db
    .prepare("SELECT date, close FROM prices WHERE security_id = ? AND source <> 'proxy' ORDER BY date DESC LIMIT 1")
    .get(securityId) as { date: string; close: number } | undefined;
  if (!anchor) throw new PriceError("Needs one real price first (import a statement or enter a price).");
  // Start a week before the anchor so there's a proxy close on or before it (weekends, holidays).
  const closes = await provider.fetchCloses(proxy, addDays(anchor.date, -7), now);
  const base = [...closes].filter((c) => c.date <= anchor.date).at(-1);
  if (!base || base.close <= 0) throw new PriceError(`No ${proxy} price around ${anchor.date} to start from.`);
  let count = 0;
  for (const c of closes) {
    if (c.date <= anchor.date) continue;
    setPrice(db, securityId, c.date, Math.round(anchor.close * (c.close / base.close) * 1e6) / 1e6, "proxy");
    count += 1;
  }
  return count;
}

export function checkMix(mix: AssetMix): void {
  const problem = validateMix(mix);
  if (problem) throw new Error(problem);
}

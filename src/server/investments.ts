import type { FastifyInstance } from "fastify";
import { parseCsv } from "../engine/import/csv.ts";
import { dominantClass, type AssetClass, type AssetMix } from "../engine/invest/classify.ts";
import { allocation, drift, fees, locationHints, rebalance, splitContribution, type Position } from "../engine/invest/portfolio.ts";
import { applyHoldingsMapping, suggestHoldingsMapping, type HoldingsMapping } from "../engine/invest/positions.ts";
import { xirr, type Flow } from "../engine/invest/xirr.ts";
import { daysBetween } from "../engine/dates.ts";
import type { HoldingView, HoldingsImportResult, HoldingsInspectResult, InvestmentsResponse } from "../shared/api.ts";
import {
  holdingInputSchema,
  holdingPatchSchema,
  holdingsImportSchema,
  investmentsQuerySchema,
  manualPriceSchema,
  securityPatchSchema,
  targetSchema,
} from "../shared/schemas.ts";
import { getAccount } from "./accounts.ts";
import { today } from "./budget.ts";
import { setSetting, type Db } from "./db.ts";
import {
  PORTFOLIO_TYPES,
  checkMix,
  findOrCreateSecurity,
  getTarget,
  holdingValue,
  loadHoldings,
  refreshPrices,
  setPrice,
  snapshotHoldingsAccounts,
  toPositions,
  type HoldingRow,
} from "./holdings.ts";
import { badRequest, idParam, notFound, parse } from "./http.ts";
import { getPeople } from "./household.ts";
import { buildPlan } from "./plan.ts";
import type { PriceProvider } from "./prices.ts";

function toView(h: HoldingRow): HoldingView {
  const value = holdingValue(h);
  return {
    id: h.id,
    accountId: h.account_id,
    securityId: h.security_id,
    ticker: h.ticker,
    name: h.name,
    shares: h.shares,
    price: h.price,
    priceDate: h.price_date,
    priceSource: h.price_source,
    value,
    costBasis: h.cost_basis,
    gain: h.cost_basis === null || h.price === null ? null : value - h.cost_basis,
    mix: h.asset_mix ? (JSON.parse(h.asset_mix) as AssetMix) : null,
    mixSource: h.mix_source,
    expenseRatio: h.expense_ratio,
    proxyTicker: h.proxy_ticker,
    priceError: h.price_error,
  };
}

/** Money-weighted return: starting value, then transfers in and out, then today's value. */
function accountXirr(db: Db, accountId: number, currentValue: number, now: string): number | null {
  const first = db
    .prepare("SELECT date, balance FROM balance_snapshots WHERE account_id = ? ORDER BY date LIMIT 1")
    .get(accountId) as { date: string; balance: number } | undefined;
  if (!first || daysBetween(first.date, now) < 90) return null;
  const transfers = db
    .prepare("SELECT date, amount FROM transactions WHERE account_id = ? AND status = 'posted' AND transfer_id IS NOT NULL AND date > ?")
    .all(accountId, first.date) as { date: string; amount: number }[];
  const flows: Flow[] = [{ date: first.date, amount: -first.balance }, ...transfers.map((t) => ({ date: t.date, amount: -t.amount })), { date: now, amount: currentValue }];
  return xirr(flows);
}

/** The monthly amount the plan puts into investing steps. */
function planInvesting(db: Db): number {
  const plan = buildPlan(db);
  return plan.result.recommendations
    .filter((r) => ["hsa", "ira", "max_workplace", "taxable"].includes(r.step))
    .reduce((s, r) => s + r.amount, 0);
}

/** For each class, the held fund to buy more of: mostly that class, cheapest known fee, then the biggest holding. */
function suggestFund(positions: readonly Position[], cls: AssetClass): { label: string; accountName: string } | null {
  const candidates = positions
    .filter((p) => dominantClass(p.mix) === cls)
    .sort((a, b) => (a.expenseRatio ?? 99) - (b.expenseRatio ?? 99) || b.value - a.value);
  const best = candidates[0];
  return best ? { label: best.label, accountName: best.accountName } : null;
}

export function investments(db: Db, provider: PriceProvider, contribution?: number): InvestmentsResponse {
  const now = today(db);
  const rows = loadHoldings(db);
  const people = new Map(getPeople(db).map((p) => [p.id, p.name]));
  const positions = toPositions(rows);
  const alloc = allocation(positions);
  const { target, isDefault } = getTarget(db);
  const d = drift(alloc, target);
  const amount = contribution ?? planInvesting(db);
  const accountIds = [...new Set(rows.map((h) => h.account_id))];

  const errors = rows
    .filter((h) => h.price_error)
    .map((h) => ({ label: h.ticker ?? h.name, message: h.price_error! }))
    .filter((e, i, all) => all.findIndex((x) => x.label === e.label) === i);
  // "Prices as of": the feed's latest close (statement and $1 money-market prices don't count).
  const latest =
    (db.prepare("SELECT MAX(date) AS d FROM prices WHERE source = 'provider' AND security_id IN (SELECT security_id FROM holdings)").get() as { d: string | null }).d ??
    rows.map((h) => h.price_date).filter((x): x is string => x !== null).sort().at(-1) ??
    null;

  return {
    accounts: accountIds.map((id) => {
      const hs = rows.filter((h) => h.account_id === id);
      const value = hs.reduce((s, h) => s + holdingValue(h), 0);
      const first = hs[0]!;
      return {
        id,
        name: first.account_name,
        type: first.account_type,
        taxTreatment: first.tax_treatment,
        ownerName: first.owner_person_id === null ? null : (people.get(first.owner_person_id) ?? null),
        value,
        xirr: accountXirr(db, id, value, now),
        holdings: hs.map(toView),
      };
    }),
    total: alloc.total,
    unclassified: alloc.unclassified,
    target,
    targetIsDefault: isDefault,
    drift: d.rows,
    outOfBand: d.outOfBand,
    nextContribution: {
      amount,
      source: contribution === undefined ? "plan" : "chosen",
      split: splitContribution(alloc, target, amount).map((x) => ({ ...x, suggestion: suggestFund(positions, x.assetClass) })),
    },
    rebalance: rebalance(positions, target),
    locationHints: locationHints(positions),
    fees: fees(positions),
    prices: { provider: provider.name, configured: provider.configured, latest, errors },
  };
}

function getHoldingsMapping(db: Db, accountId: number): HoldingsMapping | undefined {
  const row = db.prepare("SELECT holdings_mapping FROM accounts WHERE id = ?").get(accountId) as { holdings_mapping: string | null } | undefined;
  return row?.holdings_mapping ? (JSON.parse(row.holdings_mapping) as HoldingsMapping) : undefined;
}

export function registerInvestmentRoutes(app: FastifyInstance, db: Db, provider: PriceProvider): void {
  app.get("/api/investments", async (request) => {
    const { contribution } = parse(investmentsQuerySchema, request.query);
    return investments(db, provider, contribution);
  });

  app.put("/api/investments/target", async (request) => {
    const { target } = parse(targetSchema, request.body);
    try {
      checkMix(target);
    } catch (err) {
      throw badRequest(`Target: ${(err as Error).message}`);
    }
    setSetting(db, "investments.target", target);
    return investments(db, provider);
  });

  app.post("/api/prices/refresh", async () => refreshPrices(db, provider));

  app.post("/api/holdings", async (request, reply) => {
    const input = parse(holdingInputSchema, request.body);
    const account = getAccount(db, input.accountId);
    if (!PORTFOLIO_TYPES.includes(account.type) && account.type !== "529") throw badRequest("Holdings go in brokerage, retirement, HSA or 529 accounts.");
    if (!input.ticker && !input.name) throw badRequest("Enter a ticker or a fund name.");
    db.transaction(() => {
      const securityId = findOrCreateSecurity(db, input.ticker, input.name || input.ticker!);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, shares, cost_basis) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, security_id) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run(input.accountId, securityId, input.shares, input.costBasis);
      if (input.price !== null) setPrice(db, securityId, today(db), input.price, "manual");
    })();
    await refreshPrices(db, provider).catch(() => undefined);
    snapshotHoldingsAccounts(db, [input.accountId]);
    return reply.code(201).send(investments(db, provider));
  });

  app.patch("/api/holdings/:id", async (request) => {
    const id = idParam(request.params);
    const holding = db.prepare("SELECT account_id FROM holdings WHERE id = ?").get(id) as { account_id: number } | undefined;
    if (!holding) throw notFound("Holding");
    const patch = parse(holdingPatchSchema, request.body);
    if (patch.shares !== undefined) db.prepare("UPDATE holdings SET shares = ? WHERE id = ?").run(patch.shares, id);
    if (patch.costBasis !== undefined) db.prepare("UPDATE holdings SET cost_basis = ? WHERE id = ?").run(patch.costBasis, id);
    snapshotHoldingsAccounts(db, [holding.account_id]);
    return investments(db, provider);
  });

  app.delete("/api/holdings/:id", async (request) => {
    const id = idParam(request.params);
    const holding = db.prepare("SELECT account_id FROM holdings WHERE id = ?").get(id) as { account_id: number } | undefined;
    if (!holding) throw notFound("Holding");
    db.prepare("DELETE FROM holdings WHERE id = ?").run(id);
    snapshotHoldingsAccounts(db, [holding.account_id]);
    return investments(db, provider);
  });

  app.patch("/api/securities/:id", async (request) => {
    const id = idParam(request.params);
    if (!db.prepare("SELECT 1 FROM securities WHERE id = ?").get(id)) throw notFound("Security");
    const patch = parse(securityPatchSchema, request.body);
    if (patch.mix) {
      try {
        checkMix(patch.mix);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }
    if (patch.ticker) {
      const clash = db.prepare("SELECT 1 FROM securities WHERE ticker = ? COLLATE NOCASE AND id <> ?").get(patch.ticker, id);
      if (clash) throw badRequest(`${patch.ticker} is already set up as another holding.`);
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.ticker !== undefined) set("ticker", patch.ticker);
    if (patch.proxyTicker !== undefined) set("proxy_ticker", patch.proxyTicker);
    if (patch.expenseRatio !== undefined) set("expense_ratio", patch.expenseRatio);
    if (patch.mix !== undefined) {
      set("asset_mix", patch.mix === null ? null : JSON.stringify(patch.mix));
      set("mix_source", patch.mix === null ? null : "manual");
    }
    if (sets.length) db.prepare(`UPDATE securities SET ${sets.join(", ")}, price_error = NULL WHERE id = ?`).run(...args, id);
    if (patch.ticker !== undefined || patch.proxyTicker !== undefined) await refreshPrices(db, provider).catch(() => undefined);
    return investments(db, provider);
  });

  app.post("/api/securities/:id/prices", async (request) => {
    const id = idParam(request.params);
    if (!db.prepare("SELECT 1 FROM securities WHERE id = ?").get(id)) throw notFound("Security");
    const { date, close } = parse(manualPriceSchema, request.body);
    setPrice(db, id, date, close, "manual");
    snapshotHoldingsAccounts(db);
    return investments(db, provider);
  });

  app.post("/api/holdings/import/inspect", async (request): Promise<HoldingsInspectResult> => {
    const input = parse(holdingsImportSchema, request.body);
    getAccount(db, input.accountId);
    const rows = parseCsv(input.content);
    if (rows.length === 0) throw badRequest("The file has no rows.");
    const saved = getHoldingsMapping(db, input.accountId);
    const suggestion = suggestHoldingsMapping(rows);
    return {
      columns: suggestion.columns,
      sampleRows: rows.slice(0, 15),
      ...(saved ?? suggestion.mapping ? { mapping: saved ?? suggestion.mapping } : {}),
      mappingSource: saved ? "saved" : suggestion.mapping ? "suggested" : "none",
      notes: saved ? [] : suggestion.notes,
    };
  });

  app.post("/api/holdings/import", async (request): Promise<HoldingsImportResult> => {
    const input = parse(holdingsImportSchema, request.body);
    const account = getAccount(db, input.accountId);
    if (!PORTFOLIO_TYPES.includes(account.type) && account.type !== "529") throw badRequest("Holdings go in brokerage, retirement, HSA or 529 accounts.");
    const rows = parseCsv(input.content);
    const mapping = input.mapping ?? getHoldingsMapping(db, account.id) ?? suggestHoldingsMapping(rows).mapping;
    if (!mapping) throw badRequest("Tell Sumday which columns hold the symbol, description and quantity.");
    const { positions, skipped } = applyHoldingsMapping(rows, mapping);
    if (positions.length === 0) throw badRequest("No holdings found in this file.");
    const date = today(db);

    const result: HoldingsImportResult = { added: 0, updated: 0, removed: 0, skipped, value: 0 };
    db.transaction(() => {
      db.prepare("UPDATE accounts SET holdings_mapping = ? WHERE id = ?").run(JSON.stringify(mapping), account.id);
      const before = new Set((db.prepare("SELECT security_id FROM holdings WHERE account_id = ?").all(account.id) as { security_id: number }[]).map((r) => r.security_id));
      const seen = new Set<number>();
      // A file can list the same fund twice (e.g. two lots); add them up.
      const merged = new Map<number, { shares: number; basis: number | null; price: number | null }>();
      for (const p of positions) {
        const securityId = findOrCreateSecurity(db, p.ticker, p.name);
        const prev = merged.get(securityId);
        merged.set(securityId, {
          shares: (prev?.shares ?? 0) + p.shares,
          basis: p.costBasis === null && prev?.basis == null ? null : (prev?.basis ?? 0) + (p.costBasis ?? 0),
          price: p.price ?? prev?.price ?? null,
        });
      }
      const upsert = db.prepare(
        `INSERT INTO holdings (account_id, security_id, shares, cost_basis) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, security_id) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      );
      for (const [securityId, m] of merged) {
        upsert.run(account.id, securityId, m.shares, m.basis);
        if (m.price !== null) setPrice(db, securityId, date, m.price, "import");
        seen.add(securityId);
        if (before.has(securityId)) result.updated += 1;
        else result.added += 1;
      }
      // The file is the full picture: anything no longer listed was sold.
      for (const id of before) {
        if (!seen.has(id)) {
          db.prepare("DELETE FROM holdings WHERE account_id = ? AND security_id = ?").run(account.id, id);
          result.removed += 1;
        }
      }
    })();
    snapshotHoldingsAccounts(db, [account.id]);
    await refreshPrices(db, provider).catch(() => undefined);
    result.value = loadHoldings(db, account.id).reduce((s, h) => s + holdingValue(h), 0);
    return result;
  });
}

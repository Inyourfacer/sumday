import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDays } from "../engine/dates.ts";
import type { AccountView, BudgetResponse, HoldingsImportResult, HoldingsInspectResult, InvestmentsResponse, PlanResponse } from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, type Db } from "./db.ts";
import { PriceError, tiingoProvider, type Close, type PriceProvider } from "./prices.ts";

let db: Db;
let app: FastifyInstance;
let today: string;
let brokerage: AccountView;
let k401: AccountView;
const calls: string[] = [];

/** Prices for the last 10 days: VTI 370→379, VXUS 70→79, VOO 500→509; anything else is unknown. */
function fakeProvider(): PriceProvider {
  const base: Record<string, number> = { VTI: 370, VXUS: 70, VOO: 500, BND: 72 };
  return {
    name: "Fake",
    configured: true,
    async fetchCloses(ticker, from, to): Promise<Close[]> {
      calls.push(`${ticker} ${from}..${to}`);
      const start = base[ticker];
      if (start === undefined) throw new PriceError(`Tiingo doesn't have prices for ${ticker}.`);
      const out: Close[] = [];
      for (let i = 10; i >= 0; i--) {
        const date = addDays(today, -i);
        if (date >= from && date <= to) out.push({ date, close: start + (10 - i) });
      }
      return out;
    },
  };
}

async function call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown) {
  const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}
async function ok<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await call<T>(method, url, body);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const POSITIONS = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total
X1,Individual,SPAXX**,HELD IN MONEY MARKET,,,$1000.00,
X1,Individual,VTI,VANGUARD TOTAL STOCK MKT ETF,100,$370.00,"$37,000.00","$30,000.00"
X1,Individual,VXUS,VANGUARD TOTAL INTL STOCK ETF,100,$70.00,"$7,000.00","$8,000.00"
X1,Individual,Pending Activity,,,,$-20.00,
`;

beforeEach(async () => {
  calls.length = 0;
  db = openDb(":memory:");
  app = await buildApp({ db, priceProvider: fakeProvider() });
  today = (await ok<BudgetResponse>("GET", "/api/budget")).today;
  brokerage = await ok<AccountView>("POST", "/api/accounts", { name: "Brokerage", type: "brokerage" });
  k401 = await ok<AccountView>("POST", "/api/accounts", { name: "401(k)", type: "401k" });
});

afterEach(async () => {
  await app.close();
  db.close();
});

const importPositions = (content: string, accountId = brokerage.id) =>
  ok<HoldingsImportResult>("POST", "/api/holdings/import", { accountId, fileName: "positions.csv", content });

describe("positions import", () => {
  it("suggests a mapping, imports holdings, prices them and sets the account balance", async () => {
    const inspect = await ok<HoldingsInspectResult>("POST", "/api/holdings/import/inspect", {
      accountId: brokerage.id,
      fileName: "positions.csv",
      content: POSITIONS,
    });
    expect(inspect.mappingSource).toBe("suggested");
    expect(inspect.mapping).toMatchObject({ symbolColumn: 2, quantityColumn: 4, valueColumn: 6, costBasisColumn: 7 });

    const result = await importPositions(POSITIONS);
    expect(result).toMatchObject({ added: 3, updated: 0, removed: 0 });
    // After the import, the feed adds today's closes: VTI 380, VXUS 80, SPAXX $1.
    expect(result.value).toBe(100 * 38_000 + 100 * 8_000 + 100_000);

    const inv = await ok<InvestmentsResponse>("GET", "/api/investments");
    const holdings = inv.accounts[0]!.holdings;
    expect(holdings.map((h) => [h.ticker, h.price, h.priceSource, h.mix])).toEqual([
      ["SPAXX", 1, "provider", { cash: 1 }],
      ["VTI", 380, "provider", { us_stock: 1 }],
      ["VXUS", 80, "provider", { intl_stock: 1 }],
    ]);
    expect(holdings.find((h) => h.ticker === "VXUS")!.gain).toBe(800_000 - 800_000);
    expect(holdings.find((h) => h.ticker === "VTI")!.gain).toBe(3_800_000 - 3_000_000);
    // The account's balance is the holdings' market value.
    expect((await ok<AccountView>("GET", `/api/accounts/${brokerage.id}`)).balance).toBe(result.value);

    // Re-importing a file without VXUS removes it; the mapping is remembered.
    const again = await importPositions(POSITIONS.split("\n").filter((l) => !l.includes("VXUS")).join("\n"));
    expect(again).toMatchObject({ added: 0, updated: 2, removed: 1 });
    const inspect2 = await ok<HoldingsInspectResult>("POST", "/api/holdings/import/inspect", {
      accountId: brokerage.id,
      fileName: "p.csv",
      content: POSITIONS,
    });
    expect(inspect2.mappingSource).toBe("saved");
  });

  it("refuses files without holdings and non-investment accounts", async () => {
    expect((await call("POST", "/api/holdings/import", { accountId: brokerage.id, fileName: "x.csv", content: "a,b\n1,2\n" })).status).toBe(400);
    const checking = await ok<AccountView>("POST", "/api/accounts", { name: "Checking", type: "checking" });
    expect((await call("POST", "/api/holdings/import", { accountId: checking.id, fileName: "p.csv", content: POSITIONS })).status).toBe(400);
  });
});

describe("prices", () => {
  it("records errors for unknown tickers and only fetches what's missing", async () => {
    await ok("POST", "/api/holdings", { accountId: brokerage.id, ticker: "ZZZZ", name: "Mystery", shares: 10 });
    let inv = await ok<InvestmentsResponse>("GET", "/api/investments");
    expect(inv.prices.errors).toEqual([{ label: "ZZZZ", message: "Tiingo doesn't have prices for ZZZZ." }]);
    expect(inv.unclassified).toBe(0); // no price yet → no value

    await ok("POST", "/api/holdings", { accountId: brokerage.id, ticker: "VTI", shares: 1 });
    calls.length = 0;
    await ok("POST", "/api/prices/refresh");
    // VTI is up to date, so it's not fetched again; the unknown ticker is retried.
    expect(calls.some((c) => c.startsWith("VTI"))).toBe(false);
    inv = await ok<InvestmentsResponse>("GET", "/api/investments");
    expect(inv.prices.latest).toBe(today);
  });

  it("prices a 401(k) fund without a ticker by following a proxy", async () => {
    const created = await ok<InvestmentsResponse>("POST", "/api/holdings", {
      accountId: k401.id,
      ticker: null,
      name: "State Street S&P 500 Index Fund",
      shares: 100,
    });
    const fund = created.accounts[0]!.holdings[0]!;
    expect(fund.mix).toEqual({ us_stock: 1 }); // guessed from the name
    expect(fund.mixSource).toBe("guessed");
    // A statement price from 5 days ago anchors it; VOO went from 505 to 510 since.
    const anchor = addDays(today, -5);
    await ok("POST", `/api/securities/${fund.securityId}/prices`, { date: anchor, close: 40 });
    const inv = await ok<InvestmentsResponse>("PATCH", `/api/securities/${fund.securityId}`, { proxyTicker: "VOO" });
    const h = inv.accounts[0]!.holdings[0]!;
    expect(h.priceSource).toBe("proxy");
    expect(h.priceDate).toBe(today);
    expect(h.price).toBeCloseTo(40 * (510 / 505), 4);
  });
});

describe("allocation, target and rebalancing", () => {
  it("compares to the target, splits the next contribution, and suggests trades", async () => {
    await importPositions(POSITIONS);
    let inv = await ok<InvestmentsResponse>("GET", "/api/investments?contribution=100000");
    expect(inv.targetIsDefault).toBe(true);
    // $38,000 US, $8,000 intl, $1,000 cash of $47,000: US 81%, intl 17%, bonds 0%.
    expect(inv.drift.map((r) => [r.assetClass, r.status])).toEqual([
      ["us_stock", "over"],
      ["intl_stock", "under"],
      ["bonds", "under"],
      ["cash", "over"], // 2.1% against a 0% target, outside the 1-point minimum band
    ]);
    expect(inv.nextContribution.source).toBe("chosen");
    expect(inv.nextContribution.split.map((s) => s.assetClass)).toEqual(["intl_stock", "bonds"]);
    expect(inv.nextContribution.split[0]!.suggestion).toEqual({ label: "VXUS", accountName: "Brokerage" });
    expect(inv.nextContribution.split[1]!.suggestion).toBeNull(); // no bond fund held yet
    // Everything is taxable, so rebalancing sells taxable VTI and estimates the gain.
    expect(inv.rebalance.needed).toBe(true);
    expect(inv.rebalance.trades.every((t) => t.where === "taxable")).toBe(true);
    expect(inv.rebalance.taxableSales[0]).toMatchObject({ label: "VTI" });
    expect(inv.rebalance.taxableSales[0]!.estimatedGain).toBeGreaterThan(0);

    // The plan flags the drift too.
    const plan = await ok<PlanResponse>("GET", "/api/plan");
    expect(plan.alerts.map((a) => a.kind)).toContain("rebalance");

    expect((await call("PUT", "/api/investments/target", { target: { us_stock: 0.5 } })).status).toBe(400);
    inv = await ok<InvestmentsResponse>("PUT", "/api/investments/target", { target: { us_stock: 0.8, intl_stock: 0.18, cash: 0.02 } });
    expect(inv.targetIsDefault).toBe(false);
    expect(inv.outOfBand).toBe(false);
    expect(inv.rebalance.needed).toBe(false);
  });

  it("lets you set a blended fund's mix, ticker-less", async () => {
    const inv = await ok<InvestmentsResponse>("POST", "/api/holdings", {
      accountId: k401.id,
      name: "Vanguard Target Retirement 2055 Trust",
      shares: 100,
      price: 50,
    });
    expect(inv.unclassified).toBe(500_000);
    const sid = inv.accounts[0]!.holdings[0]!.securityId;
    expect((await call("PATCH", `/api/securities/${sid}`, { mix: { us_stock: 0.5 } })).status).toBe(400);
    const after = await ok<InvestmentsResponse>("PATCH", `/api/securities/${sid}`, {
      mix: { us_stock: 0.54, intl_stock: 0.36, bonds: 0.1 },
      expenseRatio: 0.075,
    });
    expect(after.unclassified).toBe(0);
    expect(after.accounts[0]!.holdings[0]).toMatchObject({ mixSource: "manual", expenseRatio: 0.075 });
    expect(after.fees.weighted).toBeCloseTo(0.075);
  });

  it("edits and deletes holdings, keeping the balance in step", async () => {
    const inv = await ok<InvestmentsResponse>("POST", "/api/holdings", { accountId: brokerage.id, ticker: "VTI", shares: 10, costBasis: 300_000 });
    const h = inv.accounts[0]!.holdings[0]!;
    await ok("PATCH", `/api/holdings/${h.id}`, { shares: 20 });
    expect((await ok<AccountView>("GET", `/api/accounts/${brokerage.id}`)).balance).toBe(20 * 38_000);
    await ok("DELETE", `/api/holdings/${h.id}`);
    expect((await ok<AccountView>("GET", `/api/accounts/${brokerage.id}`)).balance).toBe(0);
  });
});

describe("Tiingo client", () => {
  it("builds the request and reads closes", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      return new Response(JSON.stringify([{ date: "2026-11-02T00:00:00.000Z", close: 370.5 }]), { status: 200 });
    }) as typeof fetch;
    const t = tiingoProvider("abc", fakeFetch);
    expect(await t.fetchCloses("BRK.B", "2026-11-01", "2026-11-05")).toEqual([{ date: "2026-11-02", close: 370.5 }]);
    expect(seen[0]).toEqual({ url: "https://api.tiingo.com/tiingo/daily/brk-b/prices?startDate=2026-11-01&endDate=2026-11-05", auth: "Token abc" });
  });

  it("explains failures", async () => {
    const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
    await expect(tiingoProvider("k", status(404)).fetchCloses("NOPE", "2026-11-01", "2026-11-02")).rejects.toThrow(/doesn't have prices for NOPE/);
    await expect(tiingoProvider("k", status(401)).fetchCloses("VTI", "2026-11-01", "2026-11-02")).rejects.toThrow(/API key/);
    await expect(tiingoProvider(undefined).fetchCloses("VTI", "2026-11-01", "2026-11-02")).rejects.toThrow(/TIINGO_API_KEY/);
    expect(tiingoProvider(undefined).configured).toBe(false);
  });
});

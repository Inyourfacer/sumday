import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDays } from "../engine/dates.ts";
import type { AccountView, AlertsResponse, BudgetResponse } from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, type Db } from "./db.ts";

let db: Db;
let app: FastifyInstance;
let now: string;
let checking: AccountView;

async function ok<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}
const tx = (accountId: number, date: string, amount: number, payee: string) => ok("POST", "/api/transactions", { accountId, date, amount, payee });
const kinds = (r: AlertsResponse) => r.alerts.map((a) => a.kind);

beforeEach(async () => {
  db = openDb(":memory:");
  app = await buildApp({ db });
  now = (await ok<BudgetResponse>("GET", "/api/budget")).today;
  checking = await ok<AccountView>("POST", "/api/accounts", { name: "Checking", type: "checking" });
  await ok("POST", `/api/accounts/${checking.id}/balances`, { date: now, balance: 500_000 });
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe("alerts", () => {
  it("flags large charges, and dismissing hides them", async () => {
    await tx(checking.id, now, -80_000, "Furniture Barn");
    await tx(checking.id, now, -2_000, "Coffee");
    let r = await ok<AlertsResponse>("GET", "/api/alerts");
    const large = r.alerts.filter((a) => a.kind === "large_transaction");
    expect(large.map((a) => a.title)).toEqual(["Large charge: Furniture Barn $800"]);

    r = await ok<AlertsResponse>("POST", "/api/alerts/dismiss", { key: large[0]!.key });
    expect(kinds(r)).not.toContain("large_transaction");
    expect(r.dismissedCount).toBe(1);
    r = await ok<AlertsResponse>("POST", "/api/alerts/restore");
    expect(kinds(r)).toContain("large_transaction");

    // A higher threshold, or turning the alert off, quiets it.
    r = await ok<AlertsResponse>("PUT", "/api/alerts/settings", { largeAmount: 100_000 });
    expect(kinds(r)).not.toContain("large_transaction");
    expect(r.settings.largeAmount).toBe(100_000);
    r = await ok<AlertsResponse>("PUT", "/api/alerts/settings", { largeAmount: 50_000, disabled: ["large_transaction"] });
    expect(kinds(r)).not.toContain("large_transaction");
  });

  it("spots new subscriptions and bills that changed", async () => {
    for (const back of [60, 30, 0]) await tx(checking.id, addDays(now, -back), -1_599, "Streamly");
    for (const back of [150, 120, 90, 60, 30]) await tx(checking.id, addDays(now, -back), -8_000, "Insurer");
    await tx(checking.id, now, -9_600, "Insurer");
    const r = await ok<AlertsResponse>("GET", "/api/alerts");
    expect(r.alerts.find((a) => a.kind === "new_subscription")?.title).toBe("New monthly charge: Streamly");
    const bill = r.alerts.find((a) => a.kind === "bill_changed");
    expect(bill?.title).toBe("Insurer went up");
    expect(bill?.message).toContain("$96");
    expect(r.alerts.filter((a) => a.kind === "new_subscription").map((a) => a.title)).not.toContain("New monthly charge: Insurer");
  });

  it("warns about low cash, stale accounts and intro rates ending", async () => {
    await ok("POST", `/api/accounts/${checking.id}/balances`, { date: now, balance: 20_000 });
    const old = await ok<AccountView>("POST", "/api/accounts", { name: "Old savings", type: "savings" });
    await ok("POST", `/api/accounts/${old.id}/balances`, { date: addDays(now, -40), balance: 100_000 });
    const card = await ok<AccountView>("POST", "/api/accounts", {
      name: "Promo card",
      type: "credit_card",
      interestRatePct: 24,
      promoRatePct: 0,
      promoEnds: addDays(now, 30),
    });
    await ok("POST", `/api/accounts/${card.id}/balances`, { date: now, balance: -300_000 });

    const r = await ok<AlertsResponse>("GET", "/api/alerts");
    expect(kinds(r)).toEqual(expect.arrayContaining(["low_cash", "stale_data", "promo_ending"]));
    expect(r.alerts.find((a) => a.kind === "stale_data")?.title).toBe("Old savings hasn't been updated in 40 days");
    expect(r.alerts.find((a) => a.kind === "promo_ending")?.message).toContain("0% to 24%");

    const quiet = await ok<AlertsResponse>("PUT", "/api/alerts/settings", { lowCash: 10_000, staleDays: 60 });
    expect(kinds(quiet)).not.toContain("low_cash");
    expect(kinds(quiet)).not.toContain("stale_data");
  });
});

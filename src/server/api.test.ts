import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AccountView,
  CategoryView,
  HouseholdResponse,
  ImportBatchDetail,
  ImportBatchView,
  ImportInspectResult,
  RuleView,
  SummaryResponse,
  TransactionList,
  TransactionUpdateResult,
  TransactionView,
} from "../shared/api.ts";
import { buildApp } from "./app.ts";
import { openDb, type Db } from "./db.ts";

let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(":memory:");
  app = await buildApp({ db });
});
afterEach(async () => {
  await app.close();
  db.close();
});

async function call<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown) {
  const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}
async function ok<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await call<T>(method, url, body);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const createAccount = (body: object) => ok<AccountView>("POST", "/api/accounts", body);
const categoryId = async (name: string) =>
  (await ok<CategoryView[]>("GET", "/api/categories")).find((c) => c.name === name)!.id;
const txns = async (query = "") => ok<TransactionList>("GET", `/api/transactions${query}`);
async function importFile(accountId: number, fileName: string, content: string, mapping?: object) {
  const batch = await ok<ImportBatchDetail>("POST", "/api/imports", { accountId, fileName, content, mapping });
  return batch;
}
async function importAndCommit(accountId: number, fileName: string, content: string) {
  const batch = await importFile(accountId, fileName, content);
  await ok("POST", `/api/imports/${batch.id}/commit`);
  return batch;
}

const CHECKING_CSV = `Posting Date,Description,Amount,Balance
11/01/2026,ACME CORP PAYROLL,2500.00,
11/02/2026,TRADER JOE'S #552 OAKLAND CA,-84.12,
11/03/2026,SQ *BLUE BOTTLE COFFEE,-5.50,
11/03/2026,SQ *BLUE BOTTLE COFFEE,-5.50,
11/05/2026,ONLINE PAYMENT TO CHASE CARD,-500.00,
`;

describe("household", () => {
  it("starts with defaults and saves people", async () => {
    const empty = await ok<HouseholdResponse>("GET", "/api/household");
    expect(empty.people).toEqual([]);
    expect(empty.setupComplete).toBe(false);
    expect(empty.household.planningHorizonAge).toBe(95);

    const saved = await ok<HouseholdResponse>("PUT", "/api/household", {
      household: { filingStatus: "married_joint", state: "tx", dependents: 2 },
      people: [
        {
          name: "Alex",
          birthDate: "1986-04-12",
          income: 12_000_000,
          employerPlan: { type: "401k", matchTiers: [{ matchPct: 100, upToPct: 3 }, { matchPct: 50, upToPct: 2 }], pretaxPct: 8 },
        },
        { name: "Sam", birthDate: "1988-09-30" },
      ],
    });
    expect(saved.household.state).toBe("TX");
    expect(saved.people.map((p) => p.name)).toEqual(["Alex", "Sam"]);
    expect(saved.people[0]!.employerPlan.matchTiers).toHaveLength(2);
    expect(saved.people[1]!.retirementAge).toBe(65);

    // Editing keeps ids; leaving someone out removes them.
    const alex = saved.people[0]!;
    const edited = await ok<HouseholdResponse>("PUT", "/api/household", {
      household: saved.household,
      people: [{ ...alex, retirementAge: 60 }],
    });
    expect(edited.people).toHaveLength(1);
    expect(edited.people[0]!.id).toBe(alex.id);
    expect(edited.people[0]!.retirementAge).toBe(60);
  });

  it("rejects bad input with a readable message", async () => {
    const res = await call<{ error: string; issues: { path: string }[] }>("PUT", "/api/household", {
      household: { state: "Texas" },
      people: [{ name: "" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["household.state", "people.0.name"]));
  });

  it("tracks setup completion and gaps", async () => {
    let summary = await ok<SummaryResponse>("GET", "/api/summary");
    expect(summary.setupGaps.length).toBeGreaterThan(0);
    await ok("PUT", "/api/household", {
      household: {},
      people: [
        { name: "Alex", birthDate: "1986-04-12", income: 100 },
        { name: "Sam", birthDate: "1988-09-30" },
      ],
    });
    summary = await ok<SummaryResponse>("GET", "/api/summary");
    expect(summary.setupGaps).toEqual(["Add Sam's income (or 0 if not working)."]);
    // 0 means "not working", which is an answer.
    const hh = await ok<HouseholdResponse>("GET", "/api/household");
    await ok("PUT", "/api/household", { household: hh.household, people: hh.people.map((p) => ({ ...p, income: p.income ?? 0 })) });
    summary = await ok<SummaryResponse>("GET", "/api/summary");
    expect(summary.setupGaps).toEqual([]);
    await ok("POST", "/api/setup/complete", { complete: true });
    expect((await ok<SummaryResponse>("GET", "/api/summary")).setupComplete).toBe(true);
  });
});

describe("accounts and balances", () => {
  it("defaults the tax treatment and computes balances from snapshots plus later transactions", async () => {
    const ira = await createAccount({ name: "Roth", type: "roth_ira" });
    expect(ira.taxTreatment).toBe("roth");
    const k = await createAccount({ name: "401k", type: "401k" });
    expect(k.taxTreatment).toBe("traditional");

    const checking = await createAccount({ name: "Checking", type: "checking" });
    await ok("POST", `/api/accounts/${checking.id}/balances`, { date: "2026-10-31", balance: 100_000 });
    await ok("POST", "/api/transactions", { accountId: checking.id, date: "2026-10-30", amount: -999, payee: "Before" });
    await ok("POST", "/api/transactions", { accountId: checking.id, date: "2026-11-02", amount: -2_500, payee: "After" });
    const after = await ok<AccountView>("GET", `/api/accounts/${checking.id}`);
    expect(after.balance).toBe(97_500);
    expect(after.balanceAsOf).toBe("2026-11-02");
  });

  it("validates the owner and lets an account be deleted", async () => {
    const bad = await call("POST", "/api/accounts", { name: "X", type: "checking", ownerPersonId: 99 });
    expect(bad.status).toBe(400);
    const a = await createAccount({ name: "Temp", type: "savings" });
    expect((await call("DELETE", `/api/accounts/${a.id}`)).status).toBe(204);
    expect((await call("GET", `/api/accounts/${a.id}`)).status).toBe(404);
  });
});

describe("CSV import", () => {
  it("suggests a mapping, stages rows for review, dedupes and commits", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    const inspected = await ok<ImportInspectResult>("POST", "/api/imports/inspect", {
      accountId: checking.id,
      fileName: "checking.csv",
      content: CHECKING_CSV,
    });
    expect(inspected.format).toBe("csv");
    expect(inspected.mappingSource).toBe("suggested");
    expect(inspected.columns).toEqual(["Posting Date", "Description", "Amount", "Balance"]);
    expect(inspected.sampleRows).toHaveLength(6);

    const batch = await importFile(checking.id, "checking.csv", CHECKING_CSV, inspected.mapping);
    expect(batch.status).toBe("staged");
    expect(batch.newCount).toBe(5);
    expect(batch.transactions.map((t) => t.payee)).toContain("Trader Joe's");
    // Staged rows don't count until committed.
    expect((await txns()).total).toBe(0);
    expect((await ok<SummaryResponse>("GET", "/api/summary")).stagedImportCount).toBe(1);

    await ok("POST", `/api/imports/${batch.id}/commit`);
    expect((await txns()).total).toBe(5);
    expect((await ok<AccountView>("GET", `/api/accounts/${checking.id}`)).balance).toBe(250_000 - 8_412 - 550 - 550 - 50_000);

    // The mapping was saved for next time.
    const again = await ok<ImportInspectResult>("POST", "/api/imports/inspect", {
      accountId: checking.id,
      fileName: "checking.csv",
      content: CHECKING_CSV,
    });
    expect(again.mappingSource).toBe("saved");

    // Re-importing the same file adds nothing; an overlapping file adds only the new rows.
    const repeat = await importFile(checking.id, "checking.csv", CHECKING_CSV);
    expect(repeat).toMatchObject({ newCount: 0, duplicateCount: 5, sameFileImportedBefore: true });
    const overlap = await importFile(
      checking.id,
      "checking-2.csv",
      `${CHECKING_CSV}11/06/2026,SHELL OIL 57444283401,-45.00,\n`,
    );
    // The newer staged import replaced the unfinished repeat.
    expect((await ok<ImportBatchView>("GET", `/api/imports/${repeat.id}`)).status).toBe("discarded");
    expect(overlap).toMatchObject({ newCount: 1, duplicateCount: 5 });
    expect(overlap.transactions[0]!.payee).toBe("Shell Oil");
  });

  it("reports unreadable rows and refuses files with none", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    const batch = await importFile(
      checking.id,
      "x.csv",
      "Date,Description,Amount\n11/01/2026,A,-1\n11/02/2026,B,-1\n11/03/2026,C,-1\n11/04/2026,D,-1\nnot a date,E,-2\n",
    );
    expect(batch.newCount).toBe(4);
    expect(batch.errors).toEqual([{ line: 6, message: 'can\'t read date "not a date"' }]);

    const res = await call<{ error: string }>("POST", "/api/imports", {
      accountId: checking.id,
      fileName: "bad.csv",
      content: "Date,Description,Amount\nnope,B,-2\n",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Line 2/);
  });

  it("undo removes the rows; discard drops a staged import", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    const batch = await importAndCommit(checking.id, "c.csv", CHECKING_CSV);
    expect((await txns()).total).toBe(5);
    expect((await call("DELETE", `/api/transactions/${(await txns()).items[0]!.id}`)).status).toBe(400);
    await ok("POST", `/api/imports/${batch.id}/undo`);
    expect((await txns()).total).toBe(0);
    // After undo the same file imports fresh.
    const again = await importFile(checking.id, "c.csv", CHECKING_CSV);
    expect(again.newCount).toBe(5);
    await ok("POST", `/api/imports/${again.id}/discard`);
    expect((await ok<ImportBatchView[]>("GET", "/api/imports")).map((b) => b.status)).toEqual(["undone"]);
  });
});

const CARD_OFX = `OFXHEADER:100
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>4111XXXX1111</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261101<TRNAMT>-15.49<FITID>A1<NAME>NETFLIX.COM</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261102<TRNAMT>-62.10<FITID>A2<NAME>SAFEWAY #1234</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261107<TRNAMT>500.00<FITID>A3<NAME>PAYMENT THANK YOU</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-1234.56<DTASOF>20261108</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

describe("OFX import and transfers", () => {
  it("records the statement balance and links a card payment to the checking debit", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    const card = await createAccount({ name: "Visa", type: "credit_card" });
    await importAndCommit(checking.id, "checking.csv", CHECKING_CSV);

    const inspected = await ok<ImportInspectResult>("POST", "/api/imports/inspect", {
      accountId: card.id,
      fileName: "card.qfx",
      content: CARD_OFX,
    });
    expect(inspected.ofx).toEqual({
      transactionCount: 3,
      accountIdLast4: "1111",
      ledgerBalance: { date: "2026-11-08", amount: -123_456 },
    });

    const batch = await importFile(card.id, "card.qfx", CARD_OFX);
    const payment = batch.transactions.find((t) => t.amount === 50_000)!;
    expect(payment.categoryName).toBe("Transfer");
    expect(payment.transferAccountName).toBe("Checking");
    await ok("POST", `/api/imports/${batch.id}/commit`);

    // The statement balance is now the card's balance.
    expect((await ok<AccountView>("GET", `/api/accounts/${card.id}`)).balance).toBe(-123_456);

    const checkingSide = (await txns(`?accountId=${checking.id}&search=chase`)).items[0]!;
    expect(checkingSide.categoryName).toBe("Transfer");
    expect(checkingSide.transferId).toBe(payment.id);

    // Undoing the card import releases the checking side.
    await ok("POST", `/api/imports/${batch.id}/undo`);
    const released = await ok<TransactionView>("GET", `/api/transactions/${checkingSide.id}`);
    expect(released).toMatchObject({ transferId: null, categoryId: null });
    expect((await ok<AccountView>("GET", `/api/accounts/${card.id}`)).balance).toBe(0);
  });

  it("unlinking stops the pair from being linked again", async () => {
    const a = await createAccount({ name: "Checking", type: "checking" });
    const b = await createAccount({ name: "Savings", type: "savings" });
    await ok("POST", "/api/transactions", { accountId: a.id, date: "2026-11-01", amount: -10_000, payee: "To savings" });
    const inflow = await ok<TransactionView>("POST", "/api/transactions", {
      accountId: b.id,
      date: "2026-11-02",
      amount: 10_000,
      payee: "From checking",
    });
    expect(inflow.transferId).not.toBeNull();

    const unlinked = await ok<TransactionView[]>("POST", `/api/transactions/${inflow.id}/unlink-transfer`);
    expect(unlinked.every((t) => t.transferId === null && t.categoryId === null)).toBe(true);

    // A later import nearby doesn't re-pair them.
    await importAndCommit(a.id, "x.csv", "Date,Description,Amount\n11/03/2026,SOMETHING,-1.00\n");
    expect((await ok<TransactionView>("GET", `/api/transactions/${inflow.id}`)).transferId).toBeNull();

    // Linking by hand works.
    const linked = await ok<TransactionView[]>("POST", "/api/transactions/link-transfer", { ids: [unlinked[0]!.id, unlinked[1]!.id] });
    expect(linked.every((t) => t.categoryName === "Transfer")).toBe(true);
  });
});

describe("rules and corrections", () => {
  it("suggests a rule after a correction and applies it to past transactions, sparing manual ones", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    await importAndCommit(checking.id, "c.csv", CHECKING_CSV);
    const coffee = (await txns("?search=blue")).items;
    expect(coffee).toHaveLength(2);
    const restaurants = await categoryId("Restaurants & coffee");
    const groceries = await categoryId("Groceries");

    // Give one coffee a different category by hand first.
    await ok("PATCH", `/api/transactions/${coffee[1]!.id}`, { categoryId: groceries });
    const result = await ok<TransactionUpdateResult>("PATCH", `/api/transactions/${coffee[0]!.id}`, { categoryId: restaurants });
    expect(result.transaction).toMatchObject({ categoryId: restaurants, categorySource: "manual" });
    expect(result.suggestion).toEqual({
      match: { payee: { op: "contains", value: "Blue Bottle Coffee" }, direction: "debit" },
      actions: { categoryId: restaurants },
      otherMatches: 0, // the other one was set by hand
    });

    const created = await ok<{ rule: RuleView; changed: number }>("POST", "/api/rules", {
      ...result.suggestion,
      position: "top",
    });
    expect(created.rule.matchCount).toBe(2);
    expect((await ok<TransactionView>("GET", `/api/transactions/${coffee[1]!.id}`)).categoryId).toBe(groceries);

    // New imports use the rule.
    const next = await importFile(checking.id, "c2.csv", "Date,Description,Amount\n11/09/2026,SQ *BLUE BOTTLE COFFEE,-6.00\n");
    expect(next.transactions[0]).toMatchObject({ categoryId: restaurants, categorySource: "rule", ruleId: created.rule.id });
  });

  it("orders rules, previews matches, and falls back when a rule is deleted", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    await importAndCommit(checking.id, "c.csv", CHECKING_CSV);
    const groceries = await categoryId("Groceries");
    const shopping = await categoryId("Shopping");

    const preview = await ok<{ matchCount: number }>("POST", "/api/rules/preview", {
      match: { payee: { op: "contains", value: "trader joe" } },
    });
    expect(preview.matchCount).toBe(1);

    const general = await ok<{ rule: RuleView }>("POST", "/api/rules", { match: { direction: "debit", amountMin: 5000 }, actions: { categoryId: shopping } });
    const specific = await ok<{ rule: RuleView }>("POST", "/api/rules", {
      match: { payee: { op: "contains", value: "trader joe" } },
      actions: { categoryId: groceries, renamePayee: "Trader Joe's" },
    });
    // The general rule is first, so it wins.
    let tj = (await txns("?search=trader")).items[0]!;
    expect(tj.categoryId).toBe(shopping);

    await ok("POST", "/api/rules/reorder", { ids: [specific.rule.id, general.rule.id] });
    tj = (await txns("?search=trader")).items[0]!;
    expect(tj.categoryId).toBe(groceries);

    await ok("DELETE", `/api/rules/${specific.rule.id}`);
    tj = (await txns("?search=trader")).items[0]!;
    expect(tj.categoryId).toBe(shopping);

    const bad = await call("POST", "/api/rules", { match: {}, actions: { categoryId: shopping } });
    expect(bad.status).toBe(400);
  });

  it("filters the uncategorized inbox and handles category deletion", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    await importAndCommit(checking.id, "c.csv", CHECKING_CSV);
    expect((await txns("?uncategorized=true")).total).toBe(5);

    const created = await ok<CategoryView>("POST", "/api/categories", { name: "Coffee", budgetType: "flex" });
    await ok("POST", "/api/rules", { match: { payee: { op: "contains", value: "blue bottle" } }, actions: { categoryId: created.id } });
    expect((await txns("?uncategorized=true")).total).toBe(3);
    expect((await txns(`?categoryId=${created.id}`)).total).toBe(2);

    expect((await call("POST", "/api/categories", { name: "coffee", budgetType: "flex" })).status).toBe(409);
    await ok("DELETE", `/api/categories/${created.id}`);
    expect((await txns("?uncategorized=true")).total).toBe(5);
    expect(await ok<RuleView[]>("GET", "/api/rules")).toEqual([]);

    const transfer = (await ok<CategoryView[]>("GET", "/api/categories")).find((c) => c.isSystem)!;
    expect((await call("DELETE", `/api/categories/${transfer.id}`)).status).toBe(400);
  });
});

describe("manual transactions", () => {
  it("can be created, edited and deleted; imported ones keep their bank date and amount", async () => {
    const checking = await createAccount({ name: "Checking", type: "checking" });
    const cash = await ok<TransactionView>("POST", "/api/transactions", {
      accountId: checking.id,
      date: "2026-11-04",
      amount: -2_000,
      payee: "Farmers market",
      categoryId: await categoryId("Groceries"),
    });
    expect(cash).toMatchObject({ isManual: true, categorySource: "manual", payee: "Farmers market" });
    const edited = await ok<TransactionUpdateResult>("PATCH", `/api/transactions/${cash.id}`, { amount: -2_500, notes: "eggs" });
    expect(edited.transaction).toMatchObject({ amount: -2_500, notes: "eggs" });
    expect((await call("DELETE", `/api/transactions/${cash.id}`)).status).toBe(204);

    await importAndCommit(checking.id, "c.csv", CHECKING_CSV);
    const imported = (await txns()).items[0]!;
    expect((await call("PATCH", `/api/transactions/${imported.id}`, { amount: 1 })).status).toBe(400);
    const renamed = await ok<TransactionUpdateResult>("PATCH", `/api/transactions/${imported.id}`, { payee: "My name" });
    expect(renamed.transaction.payee).toBe("My name");
  });
});

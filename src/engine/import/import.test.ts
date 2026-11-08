import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from "./csv.ts";
import { bestDateOrder, guessDateOrder, parseDateWithOrder } from "./dateFormats.ts";
import { dedupeKeys } from "./dedupe.ts";
import { applyMapping, suggestMapping, type CsvMapping } from "./mapping.ts";
import { looksLikeOfx, parseOfx } from "./ofx.ts";

describe("parseCsv", () => {
  it("handles quotes, embedded commas, newlines and doubled quotes", () => {
    const text = 'Date,Description,Amount\r\n11/01/2026,"JOE\'S ""BEST"" PIZZA, INC",-12.50\r\n11/02/2026,"MULTI\nLINE",3\r\n';
    expect(parseCsv(text)).toEqual([
      ["Date", "Description", "Amount"],
      ["11/01/2026", 'JOE\'S "BEST" PIZZA, INC', "-12.50"],
      ["11/02/2026", "MULTI\nLINE", "3"],
    ]);
  });

  it("strips a BOM, skips blank lines and keeps a last line without newline", () => {
    expect(parseCsv("﻿a,b\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty cells", () => {
    expect(parseCsv("a,,c\n,,\n")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });

  it("detects semicolon and tab delimiters", () => {
    expect(detectDelimiter("Date;Amount;Payee\n")).toBe(";");
    expect(detectDelimiter("Date\tAmount\n")).toBe("\t");
    expect(detectDelimiter('"a,b";c;d')).toBe(";");
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("dates in bank files", () => {
  it.each([
    ["11/05/2026", "MDY", "2026-11-05"],
    ["1/5/26", "MDY", "2026-01-05"],
    ["05/11/2026", "DMY", "2026-11-05"],
    ["2026-11-05", "YMD", "2026-11-05"],
    ["2026/11/05", "YMD", "2026-11-05"],
    ["20261105", "YMD", "2026-11-05"],
    ["2026-11-05T00:00:00Z", "YMD", "2026-11-05"],
    ["11/05/2026 1:45 PM", "MDY", "2026-11-05"],
    ["12.31.99", "MDY", "1999-12-31"],
  ] as const)("reads %s as %s", (text, order, expected) => {
    expect(parseDateWithOrder(text, order)).toBe(expected);
  });

  it("rejects impossible dates", () => {
    expect(parseDateWithOrder("02/30/2026", "MDY")).toBeUndefined();
    expect(parseDateWithOrder("13/01/2026", "MDY")).toBeUndefined();
    expect(parseDateWithOrder("hello", "MDY")).toBeUndefined();
    expect(parseDateWithOrder("1/2/123", "MDY")).toBeUndefined();
  });

  it("guesses the order from samples", () => {
    expect(guessDateOrder(["11/05/2026", "11/06/2026"])).toBe("MDY");
    expect(guessDateOrder(["25/10/2026", "03/11/2026"])).toBe("DMY");
    expect(guessDateOrder(["2026-11-05"])).toBe("YMD");
    expect(guessDateOrder(["nope"])).toBeUndefined();
    expect(guessDateOrder([])).toBeUndefined();
  });

  it("tolerates a few unreadable values when picking the order", () => {
    const values = ["11/01/2026", "11/02/2026", "11/03/2026", "11/04/2026", "Pending"];
    expect(guessDateOrder(values)).toBeUndefined();
    expect(bestDateOrder(values)).toBe("MDY");
    expect(bestDateOrder(["11/01/2026", "x", "y"])).toBeUndefined();
  });
});

describe("suggestMapping", () => {
  it("maps a typical checking export with a single amount column", () => {
    const rows = parseCsv(
      "Posting Date,Description,Amount,Type,Balance\n11/03/2026,TRADER JOE'S #552,-84.12,DEBIT,1000.00\n11/04/2026,ACME PAYROLL,2500.00,CREDIT,3415.88\n",
    );
    const { mapping, columns, notes } = suggestMapping(rows, "checking");
    expect(columns[0]).toBe("Posting Date");
    expect(notes).toEqual([]);
    expect(mapping).toEqual({
      hasHeader: true,
      dateColumn: 0,
      dateOrder: "MDY",
      payeeColumn: 1,
      amount: { mode: "single", column: 2, negate: false },
    });
  });

  it("maps separate debit and credit columns, and a memo", () => {
    const rows = parseCsv(
      "Transaction Date,Post Date,Payee,Memo,Debit,Credit\n2026-11-01,2026-11-02,NETFLIX.COM,Streaming,15.49,\n2026-11-03,2026-11-03,REFUND,,,20.00\n",
    );
    const { mapping } = suggestMapping(rows);
    expect(mapping).toEqual({
      hasHeader: true,
      dateColumn: 0,
      dateOrder: "YMD",
      payeeColumn: 2,
      memoColumn: 3,
      amount: { mode: "debitCredit", debitColumn: 4, creditColumn: 5 },
    });
  });

  it("guesses that a credit card export with positive purchases needs negating", () => {
    const rows = parseCsv("Date,Description,Amount\n11/01/2026,COFFEE,4.50\n11/02/2026,GROCERIES,80.00\n11/05/2026,PAYMENT THANK YOU,-500.00\n");
    const { mapping, notes } = suggestMapping(rows, "credit_card");
    expect(mapping?.amount).toEqual({ mode: "single", column: 2, negate: true });
    expect(notes[0]).toMatch(/positive/);
  });

  it("works without a header row", () => {
    const rows = parseCsv('"11/01/2026","-4.50","*","","COFFEE SHOP"\n"11/02/2026","-80.00","*","","GROCER"\n');
    const { mapping, columns } = suggestMapping(rows);
    expect(columns).toEqual(["Column 1", "Column 2", "Column 3", "Column 4", "Column 5"]);
    expect(mapping).toMatchObject({
      hasHeader: false,
      dateColumn: 0,
      payeeColumn: 4,
      amount: { mode: "single", column: 1 },
    });
  });

  it("explains what it couldn't find", () => {
    const { mapping, notes } = suggestMapping(parseCsv("Foo,Bar\nx,y\n"));
    expect(mapping).toBeUndefined();
    expect(notes.join(" ")).toMatch(/date column/);
  });
});

describe("applyMapping", () => {
  const single: CsvMapping = {
    hasHeader: true,
    dateColumn: 0,
    dateOrder: "MDY",
    payeeColumn: 1,
    memoColumn: 3,
    amount: { mode: "single", column: 2, negate: false },
  };

  it("reads rows and reports bad ones with line numbers", () => {
    const rows = parseCsv(
      "Date,Description,Amount,Memo\n11/01/2026,COFFEE,-4.50,\n13/45/2026,BAD DATE,-1.00,\n11/02/2026,,-2.00,fallback memo\n11/03/2026,NO AMOUNT,,\n",
    );
    const result = applyMapping(rows, single);
    expect(result.rows).toEqual([
      { date: "2026-11-01", amount: -450, payee: "COFFEE", line: 2 },
      { date: "2026-11-02", amount: -200, payee: "fallback memo", line: 4 },
    ]);
    expect(result.errors).toEqual([
      { line: 3, message: 'can\'t read date "13/45/2026"' },
      { line: 5, message: "amount is blank" },
    ]);
  });

  it("negates amounts when asked", () => {
    const rows = parseCsv("Date,Description,Amount\n11/01/2026,COFFEE,4.50\n11/05/2026,PAYMENT,-500\n");
    const result = applyMapping(rows, { ...single, memoColumn: undefined, amount: { mode: "single", column: 2, negate: true } });
    expect(result.rows.map((r) => r.amount)).toEqual([-450, 50000]);
  });

  it("combines debit and credit columns regardless of their signs", () => {
    const rows = parseCsv("Date,Payee,Debit,Credit\n11/01/2026,A,15.49,\n11/02/2026,B,,20.00\n11/03/2026,C,-3.00,\n11/04/2026,D,,\n");
    const mapping: CsvMapping = {
      hasHeader: true,
      dateColumn: 0,
      dateOrder: "MDY",
      payeeColumn: 1,
      amount: { mode: "debitCredit", debitColumn: 2, creditColumn: 3 },
    };
    const result = applyMapping(rows, mapping);
    expect(result.rows.map((r) => r.amount)).toEqual([-1549, 2000, -300]);
    expect(result.errors).toEqual([{ line: 5, message: "debit and credit are both blank" }]);
  });
});

const SGML_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261106120000</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>121000248<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101<DTEND>20261106
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261102120000.000[-5:EST]<TRNAMT>-42.17<FITID>2026110201<NAME>SAFEWAY #1234<MEMO>GROCERIES</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261103<TRNAMT>2500.00<FITID>2026110302<NAME>ACME CORP PAYROLL</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261104<TRNAMT>-9.99<FITID>2026110403<NAME>BEN &amp; JERRY'S</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>bad<TRNAMT>-1.00<FITID>x</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3123.45<DTASOF>20261106</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const XML_OFX = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>4111XXXX1111</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261101</DTPOSTED><TRNAMT>-15.49</TRNAMT><FITID>A1</FITID><NAME>NETFLIX.COM</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>500.00</TRNAMT><FITID>A2</FITID><MEMO>PAYMENT THANK YOU</MEMO></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-812.30</BALAMT><DTASOF>20261106</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

describe("parseOfx", () => {
  it("detects OFX", () => {
    expect(looksLikeOfx(SGML_OFX)).toBe(true);
    expect(looksLikeOfx(XML_OFX)).toBe(true);
    expect(looksLikeOfx("Date,Amount\n")).toBe(false);
  });

  it("reads OFX 1.x SGML", () => {
    const result = parseOfx(SGML_OFX);
    expect(result.account).toEqual({ id: "000123456789", type: "CHECKING" });
    expect(result.rows).toEqual([
      { date: "2026-11-02", amount: -4217, payee: "SAFEWAY #1234", memo: "GROCERIES", externalId: "2026110201", line: 1 },
      { date: "2026-11-03", amount: 250000, payee: "ACME CORP PAYROLL", externalId: "2026110302", line: 2 },
      { date: "2026-11-04", amount: -999, payee: "BEN & JERRY'S", externalId: "2026110403", line: 3 },
    ]);
    expect(result.errors).toEqual([{ line: 4, message: "transaction 4: missing or bad DTPOSTED" }]);
    expect(result.ledgerBalance).toEqual({ date: "2026-11-06", amount: 312345 });
  });

  it("reads OFX 2.x XML credit card statements", () => {
    const result = parseOfx(XML_OFX);
    expect(result.account).toEqual({ id: "4111XXXX1111", type: "CREDITCARD" });
    expect(result.rows.map((r) => [r.date, r.amount, r.payee, r.externalId])).toEqual([
      ["2026-11-01", -1549, "NETFLIX.COM", "A1"],
      ["2026-11-05", 50000, "PAYMENT THANK YOU", "A2"],
    ]);
    expect(result.ledgerBalance).toEqual({ date: "2026-11-06", amount: -81230 });
  });
});

describe("dedupeKeys", () => {
  it("uses the bank id when present", () => {
    expect(dedupeKeys([{ date: "2026-11-01", amount: -100, payee: "X", externalId: "F1" }])).toEqual(["id:F1"]);
  });

  it("numbers identical same-day rows so both are kept, and repeat imports match", () => {
    const coffee = { date: "2026-11-01", amount: -500, payee: "Blue Bottle" };
    const keys = dedupeKeys([coffee, { ...coffee, payee: "BLUE BOTTLE" }, { ...coffee, amount: -600 }]);
    expect(keys).toEqual(["k:2026-11-01|-500|BLUE BOTTLE|0", "k:2026-11-01|-500|BLUE BOTTLE|1", "k:2026-11-01|-600|BLUE BOTTLE|0"]);
    expect(dedupeKeys([coffee, coffee])).toEqual(keys.slice(0, 2));
  });
});

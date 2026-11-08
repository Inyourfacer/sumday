import { parseMoney, type Cents } from "../money.ts";
import type { IsoDate } from "../dates.ts";
import { parseDateWithOrder } from "./dateFormats.ts";
import type { ParseResult, RawRow } from "./types.ts";

/**
 * Reads bank and credit card statements from OFX/QFX files, both the older
 * SGML style (OFX 1.x, where leaf tags have no closing tag) and XML (OFX 2.x).
 * Investment statements are handled in Phase 4.
 */
export interface OfxStatement extends ParseResult {
  account?: { id: string; type: string };
  ledgerBalance?: { date: IsoDate; amount: Cents };
}

export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 2000).toUpperCase();
  return head.includes("OFXHEADER") || head.includes("<OFX>") || head.includes("<?OFX");
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/** Value of a leaf tag inside a block: works with or without a closing tag. */
function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  if (!match) return undefined;
  const value = decodeEntities(match[1]!.trim());
  return value === "" ? undefined : value;
}

function blocks(text: string, name: string): string[] {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "gi");
  return [...text.matchAll(re)].map((m) => m[1]!);
}

/** OFX dates look like 20261105, 20261105120000 or 20261105120000.000[-5:EST]. */
function ofxDate(value: string | undefined): IsoDate | undefined {
  if (value === undefined || !/^\d{8}/.test(value)) return undefined;
  return parseDateWithOrder(value.slice(0, 8), "YMD");
}

export function parseOfx(text: string): OfxStatement {
  const result: OfxStatement = { rows: [], errors: [] };

  const acctBlock = blocks(text, "BANKACCTFROM")[0] ?? blocks(text, "CCACCTFROM")[0];
  if (acctBlock !== undefined) {
    const id = tag(acctBlock, "ACCTID");
    if (id !== undefined) result.account = { id, type: tag(acctBlock, "ACCTTYPE") ?? "CREDITCARD" };
  }

  blocks(text, "STMTTRN").forEach((block, index) => {
    const line = index + 1;
    try {
      const date = ofxDate(tag(block, "DTPOSTED"));
      if (date === undefined) throw new Error("missing or bad DTPOSTED");
      const amountText = tag(block, "TRNAMT");
      if (amountText === undefined) throw new Error("missing TRNAMT");
      const amount = parseMoney(amountText);
      const name = tag(block, "NAME") ?? tag(block, "PAYEE");
      const memo = tag(block, "MEMO");
      const payee = name ?? memo;
      if (payee === undefined) throw new Error("missing NAME and MEMO");
      const row: RawRow = { date, amount, payee, line };
      if (memo !== undefined && memo !== payee) row.memo = memo;
      const fitid = tag(block, "FITID");
      if (fitid !== undefined) row.externalId = fitid;
      result.rows.push(row);
    } catch (err) {
      result.errors.push({ line, message: `transaction ${line}: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  const ledger = blocks(text, "LEDGERBAL")[0];
  if (ledger !== undefined) {
    const amountText = tag(ledger, "BALAMT");
    const date = ofxDate(tag(ledger, "DTASOF"));
    if (amountText !== undefined && date !== undefined) {
      try {
        result.ledgerBalance = { date, amount: parseMoney(amountText) };
      } catch {
        // A bad balance shouldn't block the transactions.
      }
    }
  }
  return result;
}

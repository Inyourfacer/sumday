import { parseMoney, type Cents } from "../money.ts";
import { bestDateOrder, guessDateOrder, parseDateWithOrder, type DateOrder } from "./dateFormats.ts";
import type { ParseResult, RawRow } from "./types.ts";

/**
 * How to read one bank's CSV export. Saved per account and reused on every
 * import. Columns are 0-based indexes.
 */
export interface CsvMapping {
  hasHeader: boolean;
  dateColumn: number;
  dateOrder: DateOrder;
  payeeColumn: number;
  memoColumn?: number;
  amount:
    | { mode: "single"; column: number; negate: boolean }
    | { mode: "debitCredit"; debitColumn: number; creditColumn: number };
}

export interface MappingSuggestion {
  mapping: CsvMapping | undefined;
  /** Column names to show in the mapping form ("Column 1"… if there's no header). */
  columns: string[];
  /** Why parts of the mapping could not be guessed. */
  notes: string[];
}

const DATE_NAMES = [/^trans(action)?\.? ?date$/, /^date$/, /^post(ed|ing)? ?date$/, /date/];
const AMOUNT_NAMES = [/^amount$/, /^amount/, /amount/];
const DEBIT_NAMES = [/^debit/, /withdrawal/, /money out/, /outflow/, /^debit|charge/];
const CREDIT_NAMES = [/^credit/, /deposit/, /money in/, /inflow/];
const PAYEE_NAMES = [/^description$/, /^payee$/, /^merchant/, /^name$/, /description/, /payee|merchant|details/];
const MEMO_NAMES = [/^memo$/, /^notes?$/, /memo|reference|extended/];

function findColumn(headers: readonly string[], patterns: readonly RegExp[], exclude: ReadonlySet<number>): number | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const pattern of patterns) {
    const index = lower.findIndex((h, i) => !exclude.has(i) && pattern.test(h));
    if (index !== -1) return index;
  }
  return undefined;
}

function isMoney(text: string): boolean {
  try {
    parseMoney(text);
    return true;
  } catch {
    return false;
  }
}

function columnValues(rows: readonly string[][], column: number): string[] {
  return rows.map((r) => (r[column] ?? "").trim()).filter((v) => v !== "");
}

/**
 * Guess a mapping from the file's first rows. `accountType` lets it guess the
 * sign convention: credit card exports usually show purchases as positive.
 */
export function suggestMapping(rows: readonly string[][], accountType?: string): MappingSuggestion {
  const notes: string[] = [];
  const first = rows[0] ?? [];
  const width = Math.max(0, ...rows.slice(0, 20).map((r) => r.length));
  const samples = rows.slice(1, 50);

  // A header row has no date and no money amounts in it.
  const hasHeader = first.length > 0 && first.every((cell) => guessDateOrder([cell]) === undefined && !isMoney(cell));
  const dataRows = hasHeader ? samples : rows.slice(0, 50);
  const columns = hasHeader ? first.map((h, i) => h.trim() || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);

  const used = new Set<number>();
  const pick = (patterns: readonly RegExp[], fallback: (i: number) => boolean): number | undefined => {
    let index = hasHeader ? findColumn(columns, patterns, used) : undefined;
    if (index === undefined) {
      for (let i = 0; i < width; i++) {
        if (!used.has(i) && fallback(i)) {
          index = i;
          break;
        }
      }
    }
    if (index !== undefined) used.add(index);
    return index;
  };

  const dateColumn = pick(DATE_NAMES, (i) => {
    const values = columnValues(dataRows, i);
    return values.length > 0 && bestDateOrder(values) !== undefined;
  });
  const dateOrder = dateColumn === undefined ? undefined : bestDateOrder(columnValues(dataRows, dateColumn));

  let amount: CsvMapping["amount"] | undefined;
  const amountColumn = hasHeader ? findColumn(columns, AMOUNT_NAMES, used) : undefined;
  const debitColumn = hasHeader ? findColumn(columns, DEBIT_NAMES, used) : undefined;
  const creditColumn = hasHeader ? findColumn(columns, CREDIT_NAMES, used) : undefined;
  if (amountColumn !== undefined) {
    used.add(amountColumn);
    amount = { mode: "single", column: amountColumn, negate: false };
  } else if (debitColumn !== undefined && creditColumn !== undefined && debitColumn !== creditColumn) {
    used.add(debitColumn);
    used.add(creditColumn);
    amount = { mode: "debitCredit", debitColumn, creditColumn };
  } else {
    const index = pick([], (i) => {
      const values = columnValues(dataRows, i);
      return values.length > 0 && values.every(isMoney) && values.some((v) => /[.]\d\d$/.test(v) || /^\(?-?\$/.test(v));
    });
    if (index !== undefined) amount = { mode: "single", column: index, negate: false };
  }

  if (amount?.mode === "single" && accountType === "credit_card") {
    const values = columnValues(dataRows, amount.column).map(parseMoney);
    const positives = values.filter((v) => v > 0).length;
    if (values.length > 0 && positives > values.length / 2) {
      amount = { ...amount, negate: true };
      notes.push("Most amounts are positive, so purchases are assumed to be positive in this card's export. Check the sign.");
    }
  }

  const payeeColumn = pick(PAYEE_NAMES, (i) => {
    const values = columnValues(dataRows, i);
    return values.length > 0 && values.some((v) => /[a-z]/i.test(v)) && !values.every(isMoney);
  });
  const memoColumn = hasHeader ? findColumn(columns, MEMO_NAMES, used) : undefined;

  if (dateColumn === undefined || dateOrder === undefined) notes.push("Couldn't find the date column.");
  if (amount === undefined) notes.push("Couldn't find the amount column(s).");
  if (payeeColumn === undefined) notes.push("Couldn't find the description column.");

  const mapping =
    dateColumn !== undefined && dateOrder !== undefined && amount !== undefined && payeeColumn !== undefined
      ? { hasHeader, dateColumn, dateOrder, payeeColumn, ...(memoColumn === undefined ? {} : { memoColumn }), amount }
      : undefined;
  return { mapping, columns, notes };
}

function readMoney(text: string | undefined): Cents | undefined {
  const trimmed = (text ?? "").trim();
  return trimmed === "" ? undefined : parseMoney(trimmed);
}

/** Turn CSV rows into transactions using a mapping. Bad rows become errors, not exceptions. */
export function applyMapping(rows: readonly string[][], mapping: CsvMapping): ParseResult {
  const result: ParseResult = { rows: [], errors: [] };
  rows.forEach((cells, index) => {
    if (index === 0 && mapping.hasHeader) return;
    const line = index + 1;
    if (cells.every((c) => c.trim() === "")) return;
    try {
      const dateText = (cells[mapping.dateColumn] ?? "").trim();
      const date = parseDateWithOrder(dateText, mapping.dateOrder);
      if (date === undefined) throw new Error(`can't read date "${dateText}"`);

      let amount: Cents;
      if (mapping.amount.mode === "single") {
        const value = readMoney(cells[mapping.amount.column]);
        if (value === undefined) throw new Error("amount is blank");
        amount = mapping.amount.negate ? -value : value;
      } else {
        const debit = readMoney(cells[mapping.amount.debitColumn]);
        const credit = readMoney(cells[mapping.amount.creditColumn]);
        if (debit === undefined && credit === undefined) throw new Error("debit and credit are both blank");
        amount = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
      }
      if (amount === 0) amount = 0;

      const memo = mapping.memoColumn === undefined ? "" : (cells[mapping.memoColumn] ?? "").trim();
      const payee = (cells[mapping.payeeColumn] ?? "").trim() || memo;
      if (payee === "") throw new Error("description is blank");

      const row: RawRow = { date, amount, payee, line };
      if (memo !== "" && memo !== payee) row.memo = memo;
      result.rows.push(row);
    } catch (err) {
      result.errors.push({ line, message: err instanceof Error ? err.message : String(err) });
    }
  });
  return result;
}

/**
 * Reading a brokerage "positions" export (CSV): one row per holding with a
 * symbol, a description, shares, and usually price, value and cost basis.
 * The file is a snapshot: importing it replaces the account's holdings.
 */
import { parseMoney, type Cents } from "../money.ts";

export interface HoldingsMapping {
  hasHeader: boolean;
  symbolColumn?: number;
  nameColumn?: number;
  quantityColumn: number;
  priceColumn?: number;
  valueColumn?: number;
  costBasisColumn?: number;
}

export interface ParsedPosition {
  ticker: string | null;
  name: string;
  shares: number;
  /** Price per share in dollars, if the file has one (or value ÷ shares). */
  price: number | null;
  value: Cents | null;
  costBasis: Cents | null;
  line: number;
}

const FIND = {
  symbol: [/^symbol$/, /^ticker$/, /symbol|ticker/],
  name: [/^description$/, /^(security|fund|investment|holding) ?name$/, /^name$/, /description|name|security|investment/],
  quantity: [/^quantity$/, /^shares$/, /quantity|shares|units/],
  price: [/^(last )?price$/, /^(current |share |nav )?price/, /price|nav/],
  value: [/^(current |market )?value$/, /market value|current value|^value|balance/],
  costBasis: [/^cost basis( total)?$/, /cost basis|total cost|cost/],
};

function find(headers: string[], patterns: RegExp[], used: Set<number>): number | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const p of patterns) {
    const i = lower.findIndex((h, idx) => !used.has(idx) && p.test(h));
    if (i !== -1) {
      used.add(i);
      return i;
    }
  }
  return undefined;
}

export function suggestHoldingsMapping(rows: readonly string[][]): { mapping: HoldingsMapping | undefined; columns: string[]; notes: string[] } {
  const headerIndex = rows.findIndex((r) => r.some((c) => /symbol|ticker/i.test(c)) && r.some((c) => /quantity|shares|units/i.test(c)));
  const notes: string[] = [];
  const header = rows[headerIndex] ?? [];
  const columns = header.map((h, i) => h.trim() || `Column ${i + 1}`);
  if (headerIndex === -1) {
    notes.push("Couldn't find a header row with Symbol and Quantity columns. Map the columns by hand.");
    return { mapping: undefined, columns: (rows[0] ?? []).map((_, i) => `Column ${i + 1}`), notes };
  }
  if (headerIndex > 0) notes.push(`Skipping ${headerIndex} line(s) above the column names.`);
  const used = new Set<number>();
  const symbolColumn = find(columns, FIND.symbol, used);
  const quantityColumn = find(columns, FIND.quantity, used);
  const costBasisColumn = find(columns, FIND.costBasis, used);
  const valueColumn = find(columns, FIND.value, used);
  const priceColumn = find(columns, FIND.price, used);
  const nameColumn = find(columns, FIND.name, used);
  if (quantityColumn === undefined) return { mapping: undefined, columns, notes: [...notes, "Couldn't find the quantity column."] };
  const mapping: HoldingsMapping = { hasHeader: true, quantityColumn };
  if (symbolColumn !== undefined) mapping.symbolColumn = symbolColumn;
  if (nameColumn !== undefined) mapping.nameColumn = nameColumn;
  if (priceColumn !== undefined) mapping.priceColumn = priceColumn;
  if (valueColumn !== undefined) mapping.valueColumn = valueColumn;
  if (costBasisColumn !== undefined) mapping.costBasisColumn = costBasisColumn;
  return { mapping, columns, notes };
}

function number(text: string | undefined): number | null {
  const t = (text ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (t === "" || t === "--" || t === "n/a" || t === "N/A") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function money(text: string | undefined): Cents | null {
  const t = (text ?? "").trim();
  if (t === "" || t === "--" || /^n\/?a$/i.test(t)) return null;
  try {
    return parseMoney(t.replace(/\s/g, ""));
  } catch {
    return null;
  }
}

/** "SPAXX**" → "SPAXX"; anything that doesn't look like a ticker → null. */
export function cleanTicker(text: string | undefined): string | null {
  const t = (text ?? "").trim().toUpperCase().replace(/\*+$/, "");
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(t) ? t : null;
}

// Summary lines, matched on the whole cell: a fund called "Total Stock Market" is a real holding.
const SKIP = /^(account total|totals?|pending activity|grand total|sub-?total|cash & cash investments total|cash & sweep total)\s*:?$/i;
const CASH_ROW = /cash|money market|core|sweep/i;

export function applyHoldingsMapping(
  rows: readonly string[][],
  mapping: HoldingsMapping,
): { positions: ParsedPosition[]; skipped: { line: number; reason: string }[] } {
  const positions: ParsedPosition[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const headerIndex = mapping.hasHeader
    ? Math.max(
        0,
        rows.findIndex((r) => mapping.symbolColumn !== undefined && /symbol|ticker/i.test(r[mapping.symbolColumn] ?? "")),
      )
    : -1;
  rows.forEach((cells, i) => {
    if (i <= headerIndex) return;
    const line = i + 1;
    if (cells.every((c) => c.trim() === "")) return;
    const symbolText = mapping.symbolColumn === undefined ? "" : (cells[mapping.symbolColumn] ?? "").trim();
    const nameText = mapping.nameColumn === undefined ? "" : (cells[mapping.nameColumn] ?? "").trim();
    const label = nameText || symbolText;
    if (SKIP.test(symbolText) || SKIP.test(nameText)) return;
    let shares = number(cells[mapping.quantityColumn]);
    let price = mapping.priceColumn === undefined ? null : number(cells[mapping.priceColumn]);
    const value = mapping.valueColumn === undefined ? null : money(cells[mapping.valueColumn]);
    const costBasis = mapping.costBasisColumn === undefined ? null : money(cells[mapping.costBasisColumn]);

    // Cash lines often have a value but no share count: $1 a share.
    if (shares === null && value !== null && CASH_ROW.test(`${symbolText} ${nameText}`)) {
      shares = value / 100;
      price = 1;
    }
    if (shares === null || shares === 0) {
      if (label) skipped.push({ line, reason: `no share count for "${label}"` });
      return;
    }
    if (!label) {
      skipped.push({ line, reason: "no symbol or description" });
      return;
    }
    if (price === null && value !== null) price = value / 100 / shares;
    positions.push({
      ticker: cleanTicker(symbolText),
      name: nameText || symbolText,
      shares,
      price,
      value: value ?? (price === null ? null : Math.round(shares * price * 100)),
      costBasis,
      line,
    });
  });
  return { positions, skipped };
}

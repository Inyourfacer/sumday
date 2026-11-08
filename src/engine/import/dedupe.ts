import { payeeKey } from "../categorize/payee.ts";
import type { RawRow } from "./types.ts";

/**
 * A stable key per row, so importing an overlapping date range twice doesn't
 * create duplicates.
 *
 * - With a bank id (OFX FITID): "id:<FITID>".
 * - Otherwise: date | amount | payee, plus an occurrence number, so two real
 *   identical purchases on the same day (two $5 coffees) stay two rows, and
 *   both are recognized when the same file range is imported again.
 */
export function dedupeKeys(rows: readonly RawRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (row.externalId !== undefined) return `id:${row.externalId}`;
    const base = `${row.date}|${row.amount}|${payeeKey(row.payee)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `k:${base}|${n}`;
  });
}

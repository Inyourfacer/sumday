import type { IsoDate } from "../dates.ts";
import type { Cents } from "../money.ts";

/** One transaction as read from a file, before rules, dedupe or transfers. */
export interface RawRow {
  date: IsoDate;
  /** Signed: negative = money out of the account, positive = money in. */
  amount: Cents;
  payee: string;
  memo?: string;
  /** Bank-assigned unique id (OFX FITID), when the file has one. */
  externalId?: string;
  /** 1-based line or record number in the file, for error messages. */
  line?: number;
}

export interface RowError {
  line: number;
  message: string;
}

export interface ParseResult {
  rows: RawRow[];
  errors: RowError[];
}

/** Types shared by the API server and the web UI. */
import type { DateOrder } from "../engine/import/dateFormats.ts";
import type { CsvMapping } from "../engine/import/mapping.ts";
import type { RowError } from "../engine/import/types.ts";
import type { RuleActions, RuleMatch } from "../engine/categorize/rules.ts";
import type { AccountType, BudgetType, Household, Person, TaxTreatment } from "./schemas.ts";

export type { CsvMapping, DateOrder, RowError, RuleActions, RuleMatch };

export interface HealthResponse {
  status: "ok";
  app: "sumday";
  version: string;
  /** Highest database migration applied. */
  schemaVersion: number;
  /** Whether the first-run household setup has been completed or skipped. */
  setupComplete: boolean;
}

export interface ApiError {
  error: string;
  issues?: { path: string; message: string }[];
}

export interface HouseholdResponse {
  household: Household;
  people: Person[];
  setupComplete: boolean;
}

export interface SummaryResponse {
  setupComplete: boolean;
  accountCount: number;
  transactionCount: number;
  uncategorizedCount: number;
  stagedImportCount: number;
  /** Things the user still needs to fill in. */
  setupGaps: string[];
}

export interface AccountView {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  ownerPersonId: number | null;
  interestRatePct: number | null;
  isClosed: boolean;
  isLiability: boolean;
  /** Latest snapshot plus posted transactions after it. */
  balance: number;
  balanceAsOf: string | null;
  transactionCount: number;
  hasCsvMapping: boolean;
}

export interface BalanceSnapshotView {
  id: number;
  date: string;
  balance: number;
  source: "manual" | "import";
}

export interface CategoryView {
  id: number;
  name: string;
  group: string;
  budgetType: BudgetType;
  isEssential: boolean;
  isSystem: boolean;
  transactionCount: number;
}

export interface RuleView {
  id: number;
  priority: number;
  match: RuleMatch;
  actions: RuleActions;
  matchCount: number;
}

export interface RulePreview {
  matchCount: number;
  samples: { id: number; date: string; payee: string; amount: number; categoryName: string | null }[];
}

export interface RuleSuggestion {
  match: RuleMatch;
  actions: RuleActions;
  /** Other posted transactions this rule would recategorize. */
  otherMatches: number;
}

export interface TransactionView {
  id: number;
  accountId: number;
  accountName: string;
  date: string;
  amount: number;
  payee: string;
  payeeRaw: string;
  memo: string;
  notes: string;
  categoryId: number | null;
  categoryName: string | null;
  categorySource: "rule" | "manual" | "transfer" | null;
  ruleId: number | null;
  transferId: number | null;
  transferAccountName: string | null;
  status: "staged" | "posted";
  importBatchId: number | null;
  isManual: boolean;
}

export interface TransactionList {
  total: number;
  items: TransactionView[];
}

export interface TransactionUpdateResult {
  transaction: TransactionView;
  suggestion: RuleSuggestion | null;
}

export type ImportStatus = "staged" | "committed" | "undone" | "discarded";

export interface ImportBatchView {
  id: number;
  accountId: number;
  accountName: string;
  format: "csv" | "ofx";
  fileName: string;
  status: ImportStatus;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  errors: RowError[];
  ledgerBalance: { date: string; amount: number } | null;
  /** Another import already brought in this exact file. */
  sameFileImportedBefore: boolean;
  createdAt: string;
  committedAt: string | null;
}

export interface ImportBatchDetail extends ImportBatchView {
  transactions: TransactionView[];
}

export interface ImportInspectResult {
  format: "csv" | "ofx";
  /** CSV only. */
  columns?: string[];
  sampleRows?: string[][];
  mapping?: CsvMapping;
  mappingSource?: "saved" | "suggested" | "none";
  notes?: string[];
  /** OFX only. */
  ofx?: { transactionCount: number; accountIdLast4: string | null; ledgerBalance: { date: string; amount: number } | null };
}

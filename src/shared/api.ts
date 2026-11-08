/** Types shared by the API server and the web UI. */
import type { DateOrder } from "../engine/import/dateFormats.ts";
import type { CsvMapping } from "../engine/import/mapping.ts";
import type { RowError } from "../engine/import/types.ts";
import type { RuleActions, RuleMatch } from "../engine/categorize/rules.ts";
import type { AccountType, BudgetType, Household, Person, TaxTreatment } from "./schemas.ts";
import type { BudgetMonth, CashFlowMonth } from "../engine/budget/budget.ts";
import type { NetWorthPoint } from "../engine/budget/networth.ts";
import type { RecurringSeries, UpcomingItem } from "../engine/budget/recurring.ts";

import type { GoalProgress } from "../engine/plan/goals.ts";
import type { StrategyComparison } from "../engine/plan/debt.ts";
import type { Fact, Recommendation, StepId, WaterfallResult } from "../engine/plan/waterfall.ts";

export type { BudgetMonth, CashFlowMonth, NetWorthPoint, RecurringSeries, UpcomingItem };
export type { Fact, GoalProgress, Recommendation, StepId, StrategyComparison, WaterfallResult };

export interface PlanSettings {
  steps: { id: StepId; enabled: boolean }[];
  starterAmount: number;
  highInterestApr: number;
  /** null = 3 months with two earners, 6 with one. */
  emergencyMonths: number | null;
  availableOverride: number | null;
}

export interface PlanAlert {
  kind: "idle_cash" | "cash_yield" | "promo_ending" | "rebalance" | "fees" | "unclassified" | "retirement";
  title: string;
  message: string;
  facts: Fact[];
}

export interface PlanResponse {
  result: WaterfallResult;
  /** Where the monthly amount and the emergency fund numbers come from. */
  basis: {
    expectedIncome: number | null;
    fixed: number;
    nonMonthly: number;
    flex: number;
    /** expectedIncome − fixed − nonMonthly − flex, or null without expected income. */
    computed: number | null;
    override: number | null;
    /** Complete months the averages use. */
    averagedMonths: string[];
    essentialMonthly: number;
    emergencyTarget: number;
    emergencySaved: number;
    emergencyBasis: "earmarked" | "savings_accounts";
    emergencyMonths: number;
  };
  limits: { year: number; requestedYear: number; exact: boolean; source: string };
  settings: PlanSettings;
  alerts: PlanAlert[];
  warnings: string[];
}

export interface GoalView {
  id: number;
  name: string;
  kind: "emergency" | "custom";
  targetAmount: number;
  /** Emergency fund only: the target is worked out from essential spending. */
  targetIsAuto: boolean;
  targetDate: string | null;
  priority: number;
  allocations: { accountId: number; accountName: string; amount: number }[];
  progress: GoalProgress;
  /** What the plan puts toward this goal each month right now. */
  plannedMonthly: number;
  emergency?: { months: number; essentialMonthly: number; autoTarget: number; basis: "earmarked" | "savings_accounts" };
}

export type AssetClassId = "us_stock" | "intl_stock" | "bonds" | "cash" | "real_estate" | "other";
export type Mix = Partial<Record<AssetClassId, number>>;

export interface HoldingView {
  id: number;
  accountId: number;
  securityId: number;
  ticker: string | null;
  name: string;
  shares: number;
  price: number | null;
  priceDate: string | null;
  priceSource: string | null;
  value: number;
  costBasis: number | null;
  gain: number | null;
  mix: Mix | null;
  mixSource: "known" | "guessed" | "manual" | null;
  expenseRatio: number | null;
  proxyTicker: string | null;
  priceError: string | null;
}

export interface InvestmentsResponse {
  accounts: {
    id: number;
    name: string;
    type: string;
    taxTreatment: string;
    ownerName: string | null;
    value: number;
    /** Money-weighted yearly return, when there's enough history. */
    xirr: number | null;
    holdings: HoldingView[];
  }[];
  total: number;
  unclassified: number;
  target: Mix;
  targetIsDefault: boolean;
  drift: { assetClass: AssetClassId; value: number; current: number; target: number; drift: number; band: number; status: "in" | "over" | "under" }[];
  outOfBand: boolean;
  nextContribution: {
    amount: number;
    /** Where the amount came from: the plan's investing steps, or what you typed. */
    source: "plan" | "chosen";
    split: { assetClass: AssetClassId; amount: number; suggestion: { label: string; accountName: string } | null }[];
  };
  rebalance: {
    needed: boolean;
    trades: { where: "tax_advantaged" | "taxable"; sell: AssetClassId; buy: AssetClassId; amount: number }[];
    taxableSales: { holdingId: number; label: string; accountName: string; amount: number; estimatedGain: number | null }[];
    remaining: { assetClass: AssetClassId; amount: number }[];
  };
  locationHints: { kind: string; amount: number; message: string }[];
  fees: {
    weighted: number | null;
    knownValue: number;
    unknownValue: number;
    yearly: number;
    drag10: number;
    drag30: number;
    expensive: { holdingId: number; label: string; accountName: string; expenseRatio: number; value: number }[];
  };
  prices: { provider: string; configured: boolean; latest: string | null; errors: { label: string; message: string }[] };
}

export interface HoldingsInspectResult {
  columns: string[];
  sampleRows: string[][];
  mapping?: import("../engine/invest/positions.ts").HoldingsMapping;
  mappingSource: "saved" | "suggested" | "none";
  notes: string[];
}

export interface HoldingsImportResult {
  added: number;
  updated: number;
  removed: number;
  skipped: { line: number; reason: string }[];
  value: number;
}

export interface RetirementResponse {
  ready: boolean;
  /** What's missing before a projection can run. */
  missing: string[];
  settings: {
    successTarget: number;
    ordinaryTaxPct: number;
    capitalGainsPct: number;
    runs: number;
    blockLength: number;
    includePlanSavings: boolean;
  };
  inputs: {
    startYear: number;
    endYear: number;
    retireYear: number;
    people: {
      id: number;
      name: string;
      birthYear: number;
      retirementAge: number;
      claimAge: number;
      socialSecurityMonthly: number | null;
      pension: { monthly: number; startAge: number; cola: boolean } | null;
      rmdStartAge: number;
    }[];
    balances: { taxable: number; traditional: number; roth: number; hsa: number; total: number };
    allocation: { stocks: number; bonds: number; cash: number };
    feePct: number;
    extraSavings: { total: number; fromPlan: boolean };
    spending: {
      categories: { categoryId: number; name: string; current: number; retirement: number | null }[];
      items: { label: string; amount: number; fromAge: number | null; toAge: number | null }[];
      oneOffs: { label: string; amount: number; age: number; everyYears: number | null }[];
      /** Regular yearly spending when retirement starts (one-off costs not included), today's dollars. */
      firstYear: number;
    };
  } | null;
  /** Changes promoted from scenarios, in order (remove with DELETE /api/retirement/events/:index). */
  events: string[];
  result: import("../engine/retire/montecarlo.ts").SimResult | null;
  whatIfs: import("../engine/retire/montecarlo.ts").WhatIfs | null;
  sources: { returns: string; returnsYears: string; rmd: string };
}

export interface ScenarioView {
  id: number;
  name: string;
  overrides: import("./schemas.ts").OverrideInput[];
  /** One line per change. */
  summary: string[];
}

export interface ScenarioComparison {
  ready: boolean;
  missing: string[];
  target: number;
  /** The first row is your plan as it is today. */
  rows: {
    id: number | null;
    name: string;
    summary: string[];
    successRate: number;
    retireYear: number;
    medianAtRetirement: number;
    medianAtEnd: number;
    medianDepletionYear: number | null;
    affordableSpending: number;
    ongoingSpending: number;
    extraSavingsMonthly: number;
    median: { year: number; value: number }[];
  }[];
}

export interface DebtView {
  id: number;
  name: string;
  type: string;
  balance: number;
  apr: number;
  aprMissing: boolean;
  minPayment: number;
  minimumEstimated: boolean;
  promoApr: number | null;
  promoEnds: string | null;
  paysInFull: boolean;
}

export interface DebtsResponse {
  debts: DebtView[];
  /** Extra per month used for the payoff plans. */
  extra: number;
  /** What the plan currently puts toward debt each month. */
  suggestedExtra: number;
  start: string;
  /** null when there's no debt to pay down. */
  comparison: StrategyComparison | null;
}

export interface BudgetSettings {
  expectedIncome: number | null;
  plannedSavings: number;
  fundStart: string | null;
}

export interface BudgetResponse {
  budget: BudgetMonth;
  settings: BudgetSettings;
  today: string;
}

export interface BudgetSuggestionsResponse {
  expectedIncome: number | null;
  budgets: { categoryId: number; name: string; budgetType: BudgetType; amount: number; current: number | null }[];
  basedOnMonths: string[];
}

export interface CashFlowResponse {
  /** The last entry is the current, unfinished month. */
  months: CashFlowMonth[];
  averages: { income: number; spending: number; net: number; savingsRate: number | null; movedToSavings: number };
}

export interface TrendsResponse {
  months: string[];
  rows: {
    categoryId: number | null;
    name: string;
    group: string;
    budgetType: BudgetType | "uncategorized";
    /** Spending per month as positive amounts (income rows: money in). */
    values: number[];
    /** Average over complete months. */
    average: number;
  }[];
}

export interface RecurringView extends RecurringSeries {
  accountName: string;
  categoryName: string | null;
  /** Money moving between your own accounts (card payments, savings). Not a bill. */
  isTransfer: boolean;
  ignored: boolean;
}

export interface RecurringResponse {
  series: RecurringView[];
  /** Expected charges and deposits over the next 45 days (active, not ignored). */
  upcoming: (UpcomingItem & { accountName: string; categoryName: string | null; isTransfer: boolean })[];
  today: string;
}

export interface NetWorthResponse {
  points: NetWorthPoint[];
  /** Change in net worth from the previous month's point. */
  change: number | null;
}

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
  minimumPayment: number | null;
  promoRatePct: number | null;
  promoEnds: string | null;
  /** Effective value: credit cards default to paid in full. */
  paysInFull: boolean;
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
  /** CSV only. Column names, from the header row when there is one. */
  columns?: string[];
  /** The file's first rows exactly as read, header row included. */
  sampleRows?: string[][];
  mapping?: CsvMapping;
  mappingSource?: "saved" | "suggested" | "none";
  notes?: string[];
  /** OFX only. */
  ofx?: { transactionCount: number; accountIdLast4: string | null; ledgerBalance: { date: string; amount: number } | null };
}

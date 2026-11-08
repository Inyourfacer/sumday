/**
 * Validation schemas for everything the UI sends the API. Shared so the
 * forms and the server agree on the rules.
 */
import { z } from "zod";
import { isIsoDate } from "../engine/dates.ts";

export const isoDate = z.string().refine(isIsoDate, "Use a real date (YYYY-MM-DD).");
export const cents = z.number().int("Amounts are whole cents.").refine(Number.isSafeInteger, "Amount is too large.");
const nonNegCents = cents.refine((v) => v >= 0, "Can't be negative.");
const pct = (max: number) => z.number().min(0).max(max);
const id = z.number().int().positive();

// ---------- Household ----------

export const FILING_STATUSES = ["single", "married_joint", "married_separate", "head_of_household"] as const;
export const HSA_COVERAGE = ["none", "self", "family"] as const;

export const householdSchema = z.object({
  filingStatus: z.enum(FILING_STATUSES).default("married_joint"),
  /** Two-letter state code, or "" if not set. */
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((s) => s === "" || /^[A-Z]{2}$/.test(s), "Use a two-letter state code.")
    .default(""),
  dependents: z.number().int().min(0).max(20).default(0),
  hsaCoverage: z.enum(HSA_COVERAGE).default("none"),
  inflationPct: pct(20).default(2.5),
  planningHorizonAge: z.number().int().min(70).max(120).default(95),
  timeZone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown time zone.")
    .default("America/Chicago"),
});
export type Household = z.infer<typeof householdSchema>;

export const PLAN_TYPES = ["none", "401k", "403b", "457"] as const;

export const matchTierSchema = z.object({
  /** Employer puts in this % of what you contribute… */
  matchPct: pct(200),
  /** …on contributions up to this % of salary. */
  upToPct: pct(100),
});
export type MatchTier = z.infer<typeof matchTierSchema>;

export const employerPlanSchema = z.object({
  type: z.enum(PLAN_TYPES).default("none"),
  matchTiers: z.array(matchTierSchema).max(5).default([]),
  pretaxPct: pct(100).default(0),
  rothPct: pct(100).default(0),
  /** Yearly HSA payroll contribution, in cents. */
  hsaPayrollAnnual: nonNegCents.default(0),
});

export const pensionSchema = z.object({
  monthly: nonNegCents,
  startAge: z.number().int().min(40).max(80),
  cola: z.boolean().default(false),
});

export const personSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, "Enter a name.").max(60),
  birthDate: isoDate.nullable().default(null),
  retirementAge: z.number().int().min(30).max(85).default(65),
  /** Gross yearly earned income, in cents. null = not entered yet (0 = not working). */
  income: nonNegCents.nullable().default(null),
  raisePct: pct(20).default(3),
  /** Monthly Social Security benefit estimates from ssa.gov, in cents. */
  socialSecurity: z
    .object({ at62: nonNegCents.nullable(), atFra: nonNegCents.nullable(), at70: nonNegCents.nullable() })
    .default({ at62: null, atFra: null, at70: null }),
  ssClaimAge: z.number().int().min(62).max(70).default(67),
  pension: pensionSchema.nullable().default(null),
  employerPlan: employerPlanSchema.default({ type: "none", matchTiers: [], pretaxPct: 0, rothPct: 0, hsaPayrollAnnual: 0 }),
});
export type PersonInput = z.input<typeof personSchema>;
export type Person = z.infer<typeof personSchema> & { id: number };

export const householdUpdateSchema = z.object({
  household: householdSchema,
  people: z.array(personSchema).max(2, "Sumday supports one or two adults."),
});

// ---------- Accounts ----------

export const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit_card",
  "loan",
  "mortgage",
  "brokerage",
  "401k",
  "403b",
  "457",
  "ira",
  "roth_ira",
  "hsa",
  "529",
  "property",
  "other_asset",
  "other_liability",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  loan: "Loan",
  mortgage: "Mortgage",
  brokerage: "Brokerage",
  "401k": "401(k)",
  "403b": "403(b)",
  "457": "457(b)",
  ira: "Traditional IRA",
  roth_ira: "Roth IRA",
  hsa: "HSA",
  "529": "529 plan",
  property: "Property / home",
  other_asset: "Other asset",
  other_liability: "Other debt",
};

export const LIABILITY_TYPES: readonly AccountType[] = ["credit_card", "loan", "mortgage", "other_liability"];

export const TAX_TREATMENTS = ["taxable", "traditional", "roth", "hsa"] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export function defaultTaxTreatment(type: AccountType): TaxTreatment {
  if (type === "roth_ira") return "roth";
  if (type === "hsa") return "hsa";
  if (type === "401k" || type === "403b" || type === "457" || type === "ira") return "traditional";
  return "taxable";
}

// Field rules shared by create and update. Defaults are added only for create:
// zod's .partial() keeps defaults, which would make an update that sends one
// field silently reset the others.
const accountFields = {
  name: z.string().trim().min(1, "Enter a name.").max(80),
  institution: z.string().trim().max(80),
  type: z.enum(ACCOUNT_TYPES),
  taxTreatment: z.enum(TAX_TREATMENTS),
  /** null = joint. */
  ownerPersonId: id.nullable(),
  /** APR for debts, APY for cash. */
  interestRatePct: z.number().min(0).max(100).nullable(),
  isClosed: z.boolean(),
  /** Debts: required minimum payment per month. */
  minimumPayment: nonNegCents.nullable(),
  /** Debts: intro APR and the date it ends. */
  promoRatePct: z.number().min(0).max(100).nullable(),
  promoEnds: isoDate.nullable(),
  /** Credit cards: paid in full every month (null = default for the type). */
  paysInFull: z.boolean().nullable(),
};
export const accountInputSchema = z.object({
  name: accountFields.name,
  institution: accountFields.institution.default(""),
  type: accountFields.type,
  taxTreatment: accountFields.taxTreatment.optional(),
  ownerPersonId: accountFields.ownerPersonId.default(null),
  interestRatePct: accountFields.interestRatePct.default(null),
  isClosed: accountFields.isClosed.default(false),
  minimumPayment: accountFields.minimumPayment.default(null),
  promoRatePct: accountFields.promoRatePct.default(null),
  promoEnds: accountFields.promoEnds.default(null),
  paysInFull: accountFields.paysInFull.default(null),
});
export const accountPatchSchema = z.object(accountFields).partial();

export const balanceInputSchema = z.object({ date: isoDate, balance: cents });

// ---------- Categories ----------

export const BUDGET_TYPES = ["income", "fixed", "flex", "non_monthly", "transfer"] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];
export const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  income: "Income",
  fixed: "Fixed",
  flex: "Flex",
  non_monthly: "Non-monthly",
  transfer: "Transfer",
};

const categoryFields = {
  name: z.string().trim().min(1, "Enter a name.").max(60),
  group: z.string().trim().max(60),
  budgetType: z.enum(BUDGET_TYPES),
  isEssential: z.boolean(),
};
export const categoryInputSchema = z.object({
  ...categoryFields,
  group: categoryFields.group.default(""),
  isEssential: categoryFields.isEssential.default(false),
});
// No defaults here: see accountFields.
export const categoryPatchSchema = z.object(categoryFields).partial();

// ---------- Rules ----------

export const ruleMatchSchema = z.object({
  payee: z.object({ op: z.enum(["contains", "equals", "startsWith", "regex"]), value: z.string().max(200) }).optional(),
  amountMin: nonNegCents.optional(),
  amountMax: nonNegCents.optional(),
  direction: z.enum(["debit", "credit"]).optional(),
  accountId: id.optional(),
});
export const ruleActionsSchema = z.object({
  categoryId: id.optional(),
  renamePayee: z.string().trim().max(80).optional(),
});
export const ruleInputSchema = z.object({
  match: ruleMatchSchema,
  actions: ruleActionsSchema,
  /** "top" for rules made from a correction, "bottom" for new general rules. */
  position: z.enum(["top", "bottom"]).default("bottom"),
  /** Also recategorize existing transactions (except ones you set by hand). */
  applyToExisting: z.boolean().default(true),
});
export const rulePatchSchema = z.object({
  match: ruleMatchSchema.optional(),
  actions: ruleActionsSchema.optional(),
  applyToExisting: z.boolean().default(true),
});
export const rulePreviewSchema = z.object({ match: ruleMatchSchema });
export const ruleReorderSchema = z.object({ ids: z.array(id) });

// ---------- Transactions ----------

export const transactionInputSchema = z.object({
  accountId: id,
  date: isoDate,
  amount: cents,
  payee: z.string().trim().min(1, "Enter a payee.").max(200),
  memo: z.string().trim().max(500).default(""),
  notes: z.string().trim().max(1000).default(""),
  categoryId: id.nullable().optional(),
});
export const transactionPatchSchema = z.object({
  categoryId: id.nullable().optional(),
  payee: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** Date and amount can only change on manually entered transactions. */
  date: isoDate.optional(),
  amount: cents.optional(),
});
export const transactionQuerySchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  uncategorized: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .optional(),
  search: z.string().trim().max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export const linkTransferSchema = z.object({ ids: z.tuple([id, id]) });

// ---------- Budget ----------

export const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-11.");

export const budgetSettingsSchema = z.object({
  /** Expected monthly take-home income. null = not set (no Flex budget yet). */
  expectedIncome: cents.refine((v) => v >= 0, "Can't be negative.").nullable().optional(),
  /** Monthly amount you plan to move to savings and investments. */
  plannedSavings: cents.refine((v) => v >= 0, "Can't be negative.").optional(),
  /** First month of the non-monthly sinking funds. */
  fundStart: monthKey.nullable().optional(),
});

export const categoryBudgetsSchema = z.object({
  items: z
    .array(
      z.object({
        categoryId: id,
        /** Monthly for Fixed, yearly for Non-monthly. null removes the budget. */
        amount: cents.refine((v) => v >= 0, "Can't be negative.").nullable(),
        startingBalance: cents.optional(),
      }),
    )
    .max(500),
});

export const budgetQuerySchema = z.object({ month: monthKey.optional() });
export const monthsQuerySchema = z.object({ months: z.coerce.number().int().min(1).max(60).default(12) });
export const recurringIgnoreSchema = z.object({ key: z.string().min(1).max(500) });

// ---------- Goals & plan ----------

export const goalInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80),
  targetAmount: cents.refine((v) => v > 0, "Enter a target above $0."),
  targetDate: isoDate.nullable().default(null),
});
export const goalPatchSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80).optional(),
  /** null on the emergency fund means "work it out from spending". */
  targetAmount: cents.refine((v) => v > 0, "Enter a target above $0.").nullable().optional(),
  targetDate: isoDate.nullable().optional(),
});
export const goalAllocationsSchema = z.object({
  items: z.array(z.object({ accountId: id, amount: cents.refine((v) => v >= 0, "Can't be negative.") })).max(100),
});
export const goalReorderSchema = z.object({ ids: z.array(id) });

export const planSettingsSchema = z.object({
  steps: z.array(z.object({ id: z.string(), enabled: z.boolean() })).optional(),
  starterAmount: cents.refine((v) => v >= 0, "Can't be negative.").optional(),
  highInterestApr: z.number().min(0).max(100).optional(),
  /** null = 3 months with two earners, 6 with one. */
  emergencyMonths: z.number().min(1).max(24).nullable().optional(),
  /** Override the monthly amount to allocate. null = work it out from the budget. */
  availableOverride: cents.refine((v) => v >= 0, "Can't be negative.").nullable().optional(),
});
export const debtQuerySchema = z.object({
  extra: z.coerce.number().int().min(0).max(100_000_000).optional(),
});

// ---------- Investments ----------

export const ASSET_CLASS_IDS = ["us_stock", "intl_stock", "bonds", "cash", "real_estate", "other"] as const;
const fraction = z.number().min(0).max(1);
export const assetMixSchema = z.partialRecord(z.enum(ASSET_CLASS_IDS), fraction);
export const ticker = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, "That doesn't look like a ticker.");

export const targetSchema = z.object({ target: assetMixSchema });
export const holdingInputSchema = z.object({
  accountId: id,
  ticker: ticker.nullable().default(null),
  name: z.string().trim().max(120).default(""),
  shares: z.number().refine((v) => Number.isFinite(v) && v !== 0, "Enter the number of shares."),
  costBasis: cents.nullable().default(null),
  /** Price per share today, in dollars, if you know it (otherwise the price feed fills it in). */
  price: z.number().positive().nullable().default(null),
});
export const holdingPatchSchema = z.object({
  shares: z.number().refine((v) => Number.isFinite(v) && v !== 0, "Enter the number of shares.").optional(),
  costBasis: cents.nullable().optional(),
});
export const securityPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  ticker: ticker.nullable().optional(),
  proxyTicker: ticker.nullable().optional(),
  expenseRatio: z.number().min(0).max(10).nullable().optional(),
  mix: assetMixSchema.nullable().optional(),
});
export const manualPriceSchema = z.object({ date: isoDate, close: z.number().positive() });
export const holdingsMappingSchema = z.object({
  hasHeader: z.boolean(),
  symbolColumn: z.number().int().min(0).optional(),
  nameColumn: z.number().int().min(0).optional(),
  quantityColumn: z.number().int().min(0),
  priceColumn: z.number().int().min(0).optional(),
  valueColumn: z.number().int().min(0).optional(),
  costBasisColumn: z.number().int().min(0).optional(),
});
export const holdingsImportSchema = z.object({
  accountId: id,
  fileName: z.string().max(255),
  content: z.string().min(1, "The file is empty.").max(5_000_000),
  mapping: holdingsMappingSchema.optional(),
});
export const investmentsQuerySchema = z.object({ contribution: z.coerce.number().int().min(0).max(100_000_000).optional() });

// ---------- Scenarios ----------

const yearField = z.number().int().min(2000).max(2150);
export const overrideSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("retirement_age"), personId: id, age: z.number().int().min(30).max(85) }),
  z.object({
    type: z.literal("income"),
    personId: id,
    /** New yearly pay in today's dollars (0 = stops working). */
    income: cents.refine((v) => v >= 0, "Can't be negative."),
    pretaxPct: z.number().min(0).max(100).nullable().default(null),
  }),
  z.object({ type: z.literal("extra_savings"), monthly: cents }),
  z.object({ type: z.literal("retirement_spending"), annualChange: cents }),
  z.object({
    type: z.literal("lump_sum"),
    label: z.string().trim().min(1, "Name it.").max(80),
    year: yearField,
    /** Positive = money in (inheritance, sale); negative = money out (wedding, gift). */
    amount: cents.refine((v) => v !== 0, "Enter an amount."),
  }),
  z.object({ type: z.literal("allocation"), stocks: z.number().min(0).max(1), bonds: z.number().min(0).max(1), cash: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("home_purchase"),
    year: yearField,
    downPayment: cents.refine((v) => v >= 0, "Can't be negative."),
    /** Change in monthly housing cost after buying (can be negative). */
    monthlyCostChange: cents,
  }),
]);
export type OverrideInput = z.infer<typeof overrideSchema>;

export const scenarioInputSchema = z.object({
  name: z.string().trim().min(1, "Name the scenario.").max(80),
  overrides: z.array(overrideSchema).max(20),
});
export const scenarioPatchSchema = z.object({
  name: z.string().trim().min(1, "Name the scenario.").max(80).optional(),
  overrides: z.array(overrideSchema).max(20).optional(),
});
export const compareQuerySchema = z.object({
  ids: z
    .string()
    .default("")
    .transform((v) => v.split(",").filter(Boolean).map(Number))
    .refine((ids) => ids.length <= 3 && ids.every((x) => Number.isInteger(x) && x > 0), "Compare up to 3 scenarios."),
});

// ---------- Retirement ----------

const ageField = z.number().int().min(18).max(120);
export const retirementSettingsSchema = z.object({
  /** Chance of success to aim for, 0.5–0.99. */
  successTarget: z.number().min(0.5).max(0.99).optional(),
  ordinaryTaxPct: z.number().min(0).max(60).optional(),
  capitalGainsPct: z.number().min(0).max(40).optional(),
  runs: z.number().int().min(500).max(20_000).optional(),
  blockLength: z.number().int().min(1).max(15).optional(),
  includePlanSavings: z.boolean().optional(),
  /** Changes promoted from scenarios that live in the retirement plan (savings, spending, one-time amounts, a home). */
  events: z.array(overrideSchema).max(30).optional(),
  spending: z
    .object({
      /** Yearly amount in retirement per category id; null or missing = same as today. */
      categoryOverrides: z.record(z.string(), cents.refine((v) => v >= 0, "Can't be negative.").nullable()),
      items: z
        .array(
          z.object({
            label: z.string().trim().min(1, "Name the change.").max(80),
            amount: cents,
            fromAge: ageField.nullable(),
            toAge: ageField.nullable(),
          }),
        )
        .max(50),
      oneOffs: z
        .array(
          z.object({
            label: z.string().trim().min(1, "Name the expense.").max(80),
            amount: cents.refine((v) => v > 0, "Enter an amount."),
            age: ageField,
            everyYears: z.number().int().min(1).max(40).nullable(),
          }),
        )
        .max(50),
    })
    .optional(),
});

// ---------- Imports ----------

export const csvMappingSchema = z.object({
  hasHeader: z.boolean(),
  dateColumn: z.number().int().min(0),
  dateOrder: z.enum(["MDY", "DMY", "YMD"]),
  payeeColumn: z.number().int().min(0),
  memoColumn: z.number().int().min(0).optional(),
  amount: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("single"), column: z.number().int().min(0), negate: z.boolean() }),
    z.object({ mode: z.literal("debitCredit"), debitColumn: z.number().int().min(0), creditColumn: z.number().int().min(0) }),
  ]),
});

const MAX_FILE_CHARS = 10_000_000;
export const importInspectSchema = z.object({
  accountId: id,
  fileName: z.string().max(255),
  content: z.string().min(1, "The file is empty.").max(MAX_FILE_CHARS, "The file is too large (10 MB max)."),
});
export const importStageSchema = importInspectSchema.extend({ mapping: csvMappingSchema.optional() });

/**
 * Yearly IRS contribution limits. The numbers live in data/limits/<year>.json
 * (updated once a year); this module only picks the right year.
 */
import type { Cents } from "../money.ts";

export type FilingStatus = "single" | "married_joint" | "married_separate" | "head_of_household";

export interface ContributionLimits {
  year: number;
  source: string;
  workplace: { employee: Cents; catchUp50: Cents; catchUp60to63: Cents };
  ira: { limit: Cents; catchUp50: Cents };
  hsa: { self: Cents; family: Cents; catchUp55: Cents };
  /** Modified AGI range over which Roth IRA contributions phase out, by filing status. */
  rothIraPhaseOut: Record<FilingStatus, [Cents, Cents]>;
}

export interface LimitsChoice {
  limits: ContributionLimits;
  /** False when this year's limits aren't in the data yet and an earlier year is used. */
  exact: boolean;
  requestedYear: number;
}

/** This year's limits, or the latest earlier year's when they haven't been published. */
export function limitsFor(year: number, table: readonly ContributionLimits[]): LimitsChoice {
  const exact = table.find((l) => l.year === year);
  if (exact) return { limits: exact, exact: true, requestedYear: year };
  const earlier = [...table].filter((l) => l.year < year).sort((a, b) => b.year - a.year)[0];
  const fallback = earlier ?? [...table].sort((a, b) => a.year - b.year)[0];
  if (!fallback) throw new Error("No contribution limits available.");
  return { limits: fallback, exact: false, requestedYear: year };
}

/** Workplace plan (401k/403b/457) employee limit for someone this age at year end. */
export function workplaceLimit(limits: ContributionLimits, ageAtYearEnd: number | null): Cents {
  const { employee, catchUp50, catchUp60to63 } = limits.workplace;
  if (ageAtYearEnd === null || ageAtYearEnd < 50) return employee;
  if (ageAtYearEnd >= 60 && ageAtYearEnd <= 63) return employee + catchUp60to63;
  return employee + catchUp50;
}

export function iraLimit(limits: ContributionLimits, ageAtYearEnd: number | null): Cents {
  return limits.ira.limit + (ageAtYearEnd !== null && ageAtYearEnd >= 50 ? limits.ira.catchUp50 : 0);
}

export function hsaLimit(limits: ContributionLimits, coverage: "self" | "family", oldestAgeAtYearEnd: number | null): Cents {
  return limits.hsa[coverage] + (oldestAgeAtYearEnd !== null && oldestAgeAtYearEnd >= 55 ? limits.hsa.catchUp55 : 0);
}

/**
 * "Try a change" for retirement: three dials (retire earlier or later, spend
 * more or less, save more) answered with the same seeded simulation as the
 * headline, so the difference comes from the dials and not from luck.
 */
import type { FastifyInstance } from "fastify";
import { simulate, type SimInput } from "../engine/retire/montecarlo.ts";
import type { ExploreResponse } from "../shared/api.ts";
import { exploreSchema } from "../shared/schemas.ts";
import type { Db } from "./db.ts";
import { parse } from "./http.ts";
import { buildInput, getSettings } from "./retirement.ts";

const RUNS = 3000;

export interface Dials {
  /** Years to add to everyone's retirement age (negative = earlier). */
  retireShiftYears: number;
  /** Retirement spending as a percentage of the plan (100 = as planned). */
  spendingPct: number;
  /** Extra saving per month, in cents. */
  extraMonthly: number;
}

export const NO_CHANGE: Dials = { retireShiftYears: 0, spendingPct: 100, extraMonthly: 0 };

/** The plan with the dials applied. People who have already retired are left alone. */
export function withDials(input: SimInput, d: Dials): SimInput {
  const people = input.people.map((p) => {
    const age = p.retirementAge + d.retireShiftYears;
    return p.income > 0 && p.birthYear + age >= input.startYear ? { ...p, retirementAge: age } : p;
  });
  return {
    ...input,
    people,
    runs: RUNS,
    spending: input.spending.map((s) => (s * d.spendingPct) / 100),
    extraSavings: {
      ...input.extraSavings,
      traditional: { ...input.extraSavings.traditional },
      taxable: input.extraSavings.taxable + d.extraMonthly * 12,
    },
  };
}

export function explore(db: Db, dials: Dials): ExploreResponse {
  const { built } = buildInput(db, getSettings(db));
  if (!built) return { ready: false };
  const base = simulate(withDials(built.input, NO_CHANGE), { bands: false });
  const changed = simulate(withDials(built.input, dials));
  return {
    ready: true,
    runs: RUNS,
    base: { successRate: base.successRate },
    changed: {
      successRate: changed.successRate,
      successInterval: changed.successInterval,
      retireYear: changed.retireYear,
      medianAtRetirement: changed.medianAtRetirement,
      medianAtEnd: changed.medianAtEnd,
      bands: changed.bands,
    },
  };
}

export function registerExploreRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/retirement/explore", async (request) => explore(db, parse(exploreSchema, request.body)));
}

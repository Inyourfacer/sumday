/**
 * What each Next best move is worth to retirement: the same seeded simulation
 * with and without that move's savings. Same random years in both runs, so the
 * difference comes from the move and not from luck. Computed on request (and
 * cached) because it runs several simulations.
 */
import type { FastifyInstance } from "fastify";
import { simulate } from "../engine/retire/montecarlo.ts";
import type { MoveImpactsResponse } from "../shared/api.ts";
import type { Db } from "./db.ts";
import { addSavings, buildInput, getSettings, savingsOf } from "./retirement.ts";
import { buildPlan } from "./plan.ts";

const RUNS = 2000;
/** Steps that put money into the retirement accounts the simulation tracks. */
const IMPACT_STEPS = new Set(["employer_match", "max_workplace", "ira", "hsa", "taxable"]);
const cache = new Map<string, MoveImpactsResponse>();

export function moveImpacts(db: Db): MoveImpactsResponse {
  const settings = getSettings(db);
  const { built } = buildInput(db, settings);
  if (!built || !settings.includePlanSavings) return { available: false, impacts: [] };
  const recs = buildPlan(db).result.recommendations.filter((r) => IMPACT_STEPS.has(r.step) && r.amount > 0);
  const key = JSON.stringify({ i: { ...built.input, history: undefined, rmd: undefined }, k: recs.map((r) => [r.key, r.amount, r.contribution]) });
  const hit = cache.get(key);
  if (hit) return hit;

  const quick = { ...built.input, runs: RUNS };
  const rate = (input: typeof quick) => simulate(input, { bands: false });
  const withAll = rate(quick);
  const impacts = recs.map((r) => {
    const extraSavings = { ...quick.extraSavings, traditional: { ...quick.extraSavings.traditional } };
    addSavings(extraSavings, savingsOf(r), -1);
    const without = rate({ ...quick, extraSavings });
    return {
      key: r.key,
      /** Change in the chance the money lasts, in percentage points, from doing this move. */
      successPoints: Math.round((withAll.successRate - without.successRate) * 1000) / 10,
      /** Change in the median portfolio at the end of the plan, today's dollars. */
      medianAtEnd: withAll.medianAtEnd - without.medianAtEnd,
    };
  });
  const result: MoveImpactsResponse = { available: true, runs: RUNS, impacts };
  cache.set(key, result);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return result;
}

export function registerMoveImpactRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/plan/impacts", async () => moveImpacts(db));
}

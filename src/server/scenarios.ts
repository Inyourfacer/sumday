import type { FastifyInstance } from "fastify";
import { affordableSpending, simulate, type SimResult } from "../engine/retire/montecarlo.ts";
import { applyOverrides, describeOverride, type Override } from "../engine/retire/overrides.ts";
import type { ScenarioComparison, ScenarioView } from "../shared/api.ts";
import { compareQuerySchema, scenarioInputSchema, scenarioPatchSchema } from "../shared/schemas.ts";
import { setSetting, type Db } from "./db.ts";
import { getTarget } from "./holdings.ts";
import { getPeople } from "./household.ts";
import { badRequest, idParam, notFound, parse } from "./http.ts";
import { buildInput, getSettings } from "./retirement.ts";

interface Row {
  id: number;
  name: string;
  overrides: string;
}

function names(db: Db): Map<number, string> {
  return new Map(getPeople(db).map((p) => [p.id, p.name]));
}

function toView(db: Db, r: Row): ScenarioView {
  const overrides = JSON.parse(r.overrides) as Override[];
  const who = names(db);
  return { id: r.id, name: r.name, overrides, summary: overrides.map((o) => describeOverride(o, who)) };
}

function listScenarios(db: Db): ScenarioView[] {
  return (db.prepare("SELECT id, name, overrides FROM scenarios ORDER BY id").all() as Row[]).map((r) => toView(db, r));
}

function getScenario(db: Db, id: number): ScenarioView {
  const row = db.prepare("SELECT id, name, overrides FROM scenarios WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw notFound("Scenario");
  return toView(db, row);
}

function checkPeople(db: Db, overrides: readonly Override[]): void {
  const ids = new Set(getPeople(db).map((p) => p.id));
  for (const o of overrides) if ("personId" in o && !ids.has(o.personId)) throw badRequest("That person isn't in your household.");
}

// Same inputs, same (seeded) answer: cache by input.
const cache = new Map<string, { result: SimResult; affordable: number }>();

export function compareScenarios(db: Db, ids: number[]): ScenarioComparison {
  const settings = getSettings(db);
  const { built, missing } = buildInput(db, settings);
  if (!built) return { ready: false, missing, target: settings.successTarget, rows: [] };
  const scenarios = ids.map((id) => getScenario(db, id));
  const variants: { id: number | null; name: string; summary: string[]; overrides: Override[] }[] = [
    { id: null, name: "Your plan today", summary: [], overrides: [] },
    ...scenarios.map((s) => ({ id: s.id, name: s.name, summary: s.summary, overrides: s.overrides })),
  ];
  const rows = variants.map((v) => {
    const input = applyOverrides(built.input, v.overrides);
    const ongoing = applyOverrides({ ...built.input, spending: built.input.spending.map(() => built.view.spending.firstYear) }, v.overrides);
    const key = JSON.stringify({ ...input, history: undefined, rmd: undefined, t: settings.successTarget });
    let hit = cache.get(key);
    if (!hit) {
      const result = simulate(input);
      const t0 = Math.max(0, result.retireYear - input.startYear);
      const ongoingSpending = ongoing.spending[t0] ?? 0;
      hit = { result, affordable: affordableSpending(input, settings.successTarget, result.retireYear, ongoingSpending) };
      cache.set(key, hit);
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
    }
    const r = hit.result;
    const t0 = Math.max(0, r.retireYear - input.startYear);
    const extra = input.extraSavings.taxable + input.extraSavings.roth + input.extraSavings.hsa + Object.values(input.extraSavings.traditional).reduce((s, x) => s + x, 0);
    return {
      id: v.id,
      name: v.name,
      summary: v.summary,
      successRate: r.successRate,
      retireYear: r.retireYear,
      medianAtRetirement: r.medianAtRetirement,
      medianAtEnd: r.medianAtEnd,
      medianDepletionYear: r.medianDepletionYear,
      affordableSpending: hit.affordable,
      ongoingSpending: ongoing.spending[t0] ?? 0,
      extraSavingsMonthly: Math.round(extra / 12),
      median: r.bands.map((b) => ({ year: b.year, value: b.p50 })),
    };
  });
  return { ready: true, missing: [], target: settings.successTarget, rows };
}

/**
 * Make a scenario your plan. Retirement ages, income and the asset mix
 * change in your household and investment settings; savings, spending,
 * one-time amounts and a home purchase become events in the retirement plan.
 */
function promote(db: Db, id: number): { applied: string[] } {
  const scenario = getScenario(db, id);
  const people = getPeople(db);
  const settings = getSettings(db);
  const applied: string[] = [];
  const events = [...settings.events];
  db.transaction(() => {
    const update = db.prepare("UPDATE people SET profile = ? WHERE id = ?");
    for (const o of scenario.overrides) {
      const person = "personId" in o ? people.find((p) => p.id === o.personId) : undefined;
      if (o.type === "retirement_age" && person) {
        person.retirementAge = o.age;
      } else if (o.type === "income" && person) {
        person.income = o.income;
        if (o.pretaxPct !== null) person.employerPlan.pretaxPct = o.pretaxPct;
      } else if (o.type === "allocation") {
        // Keep the US / international split within stocks.
        const { target } = getTarget(db);
        const us = target.us_stock ?? 0;
        const intl = target.intl_stock ?? 0;
        const usShare = us + intl > 0 ? us / (us + intl) : 0.6;
        const round = (x: number) => Math.round(x * 1000) / 1000;
        const next: Record<string, number> = {};
        const add = (k: string, v: number) => {
          if (v > 0) next[k] = round(v);
        };
        add("us_stock", o.stocks * usShare);
        add("intl_stock", o.stocks - round(o.stocks * usShare));
        add("bonds", o.bonds);
        add("cash", o.cash);
        setSetting(db, "investments.target", next);
      } else {
        events.push(o);
      }
      applied.push(describeOverride(o, names(db)));
    }
    for (const p of people) {
      const { id: pid, name: _name, ...profile } = p;
      update.run(JSON.stringify(profile), pid);
    }
    setSetting(db, "retirement", { ...settings, events });
  })();
  return { applied };
}

export function registerScenarioRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/scenarios", async () => listScenarios(db));

  app.post("/api/scenarios", async (request, reply) => {
    const input = parse(scenarioInputSchema, request.body);
    checkPeople(db, input.overrides);
    const result = db.prepare("INSERT INTO scenarios (name, overrides) VALUES (?, ?)").run(input.name, JSON.stringify(input.overrides));
    return reply.code(201).send(getScenario(db, Number(result.lastInsertRowid)));
  });

  app.patch("/api/scenarios/:id", async (request) => {
    const id = idParam(request.params);
    const current = getScenario(db, id);
    const patch = parse(scenarioPatchSchema, request.body);
    if (patch.overrides) checkPeople(db, patch.overrides);
    db.prepare("UPDATE scenarios SET name = ?, overrides = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      patch.name ?? current.name,
      JSON.stringify(patch.overrides ?? current.overrides),
      id,
    );
    return getScenario(db, id);
  });

  app.delete("/api/scenarios/:id", async (request, reply) => {
    const id = idParam(request.params);
    getScenario(db, id);
    db.prepare("DELETE FROM scenarios WHERE id = ?").run(id);
    return reply.code(204).send();
  });

  app.get("/api/scenarios/compare", async (request) => {
    const { ids } = parse(compareQuerySchema, request.query);
    return compareScenarios(db, ids);
  });

  app.post("/api/scenarios/:id/promote", async (request) => promote(db, idParam(request.params)));

  app.delete("/api/retirement/events/:index", async (request) => {
    const index = Number((request.params as { index: string }).index);
    const settings = getSettings(db);
    if (!Number.isInteger(index) || index < 0 || index >= settings.events.length) throw notFound("Event");
    setSetting(db, "retirement", { ...settings, events: settings.events.filter((_, i) => i !== index) });
    return { events: getSettings(db).events };
  });
}

import type { FastifyInstance } from "fastify";
import type { HouseholdResponse } from "../shared/api.ts";
import { householdSchema, householdUpdateSchema, personSchema, type Household, type Person } from "../shared/schemas.ts";
import { getSetting, setSetting, type Db } from "./db.ts";
import { parse } from "./http.ts";
import { z } from "zod";

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
}

export function getHousehold(db: Db): Household {
  const stored = getSetting<unknown>(db, "household");
  return householdSchema.parse(stored ?? { timeZone: systemTimeZone() });
}

export function getPeople(db: Db): Person[] {
  const rows = db.prepare("SELECT id, name, profile FROM people ORDER BY sort, id").all() as {
    id: number;
    name: string;
    profile: string;
  }[];
  return rows.map((r) => ({ ...personSchema.parse({ ...JSON.parse(r.profile), name: r.name }), id: r.id }));
}

export function isSetupComplete(db: Db): boolean {
  return getSetting<boolean>(db, "setup.complete") ?? false;
}

function householdResponse(db: Db): HouseholdResponse {
  return { household: getHousehold(db), people: getPeople(db), setupComplete: isSetupComplete(db) };
}

/** What's still missing for the planning engines; shown as "finish setup" items. */
export function setupGaps(db: Db): string[] {
  const gaps: string[] = [];
  const household = getSetting<unknown>(db, "household");
  const people = getPeople(db);
  if (household === undefined) gaps.push("Add household details (filing status, state).");
  if (people.length === 0) gaps.push("Add the adults in your household.");
  for (const p of people) {
    if (p.birthDate === null) gaps.push(`Add ${p.name}'s birth date.`);
    if (p.income === null) gaps.push(`Add ${p.name}'s income (or 0 if not working).`);
    if (p.employerPlan.type !== "none" && p.employerPlan.matchTiers.length === 0) {
      gaps.push(`Add ${p.name}'s employer match (or none).`);
    }
  }
  return gaps;
}

export function registerHouseholdRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/household", async () => householdResponse(db));

  app.put("/api/household", async (request) => {
    const { household, people } = parse(householdUpdateSchema, request.body);
    const existingIds = new Set(getPeople(db).map((p) => p.id));
    db.transaction(() => {
      setSetting(db, "household", household);
      const keep = new Set<number>();
      const insert = db.prepare("INSERT INTO people (name, profile, sort) VALUES (?, ?, ?)");
      const update = db.prepare("UPDATE people SET name = ?, profile = ?, sort = ? WHERE id = ?");
      people.forEach((person, sort) => {
        const { id, name, ...profile } = person;
        if (id !== undefined && existingIds.has(id)) {
          update.run(name, JSON.stringify(profile), sort, id);
          keep.add(id);
        } else {
          const result = insert.run(name, JSON.stringify(profile), sort);
          keep.add(Number(result.lastInsertRowid));
        }
      });
      for (const id of existingIds) if (!keep.has(id)) db.prepare("DELETE FROM people WHERE id = ?").run(id);
    })();
    return householdResponse(db);
  });

  app.post("/api/setup/complete", async (request) => {
    const { complete } = parse(z.object({ complete: z.boolean() }), request.body);
    setSetting(db, "setup.complete", complete);
    return householdResponse(db);
  });
}

/**
 * What the user did with each Next best move (done / snoozed / dismissed).
 * The engine never sees this: it only decides what is shown. A move comes
 * back on its own when its date passes (done, snoozed) or when it changes
 * enough to be a different decision (dismissed).
 */
import type { FastifyInstance } from "fastify";
import { addDays, type IsoDate } from "../engine/dates.ts";
import type { Recommendation } from "../engine/plan/waterfall.ts";
import { moveActionSchema } from "../shared/schemas.ts";
import type { PlanResponse } from "../shared/api.ts";
import { today } from "./budget.ts";
import type { Db } from "./db.ts";
import { notFound, parse } from "./http.ts";

interface Row {
  key: string;
  state: "done" | "snoozed" | "dismissed";
  until: string | null;
  fingerprint: string;
}

/** Changes when the move is a different decision: its status, or its size by more than $50. */
export function fingerprint(r: Pick<Recommendation, "status" | "amount">): string {
  return `${r.status}:${Math.round(r.amount / 5000)}`;
}

function firstOfNextMonth(now: IsoDate): IsoDate {
  const [y, m] = now.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** Mark each recommendation the user has set aside, and forget states that no longer apply. */
export function applyMoveStates(db: Db, now: IsoDate, recs: Recommendation[]): void {
  const rows = db.prepare("SELECT key, state, until, fingerprint FROM move_states").all() as Row[];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const rec of recs) {
    const row = byKey.get(rec.key);
    if (!row) continue;
    const active = row.state === "dismissed" ? row.fingerprint === fingerprint(rec) : row.until !== null && now < row.until;
    if (active) rec.userState = { state: row.state, until: row.until };
  }
}

export function setMoveState(db: Db, now: IsoDate, rec: Recommendation, action: "done" | "snooze" | "dismiss", days?: number): void {
  const state = action === "done" ? "done" : action === "snooze" ? "snoozed" : "dismissed";
  const until = action === "done" ? firstOfNextMonth(now) : action === "snooze" ? addDays(now, days ?? 14) : null;
  db.prepare(
    `INSERT INTO move_states (key, state, until, fingerprint) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET state = excluded.state, until = excluded.until, fingerprint = excluded.fingerprint, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(rec.key, state, until, fingerprint(rec));
}

export function registerMoveRoutes(app: FastifyInstance, db: Db, buildPlan: (db: Db) => PlanResponse): void {
  app.post("/api/plan/moves", async (request) => {
    const { key, action, days } = parse(moveActionSchema, request.body);
    if (action === "restore") {
      db.prepare("DELETE FROM move_states WHERE key = ?").run(key);
    } else {
      const rec = buildPlan(db).result.recommendations.find((r) => r.key === key);
      if (!rec) throw notFound("Move");
      setMoveState(db, today(db), rec, action, days);
    }
    return buildPlan(db);
  });
}

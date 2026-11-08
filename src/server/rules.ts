import type { FastifyInstance } from "fastify";
import { validateRule, type RuleActions, type RuleMatch } from "../engine/categorize/rules.ts";
import type { RulePreview, RuleView } from "../shared/api.ts";
import { rulePatchSchema, rulePreviewSchema, ruleInputSchema, ruleReorderSchema } from "../shared/schemas.ts";
import { assertCategoryExists } from "./categories.ts";
import { loadRules, recategorize, transactionsMatching } from "./categorize.ts";
import type { Db } from "./db.ts";
import { badRequest, idParam, notFound, parse } from "./http.ts";

/** Drop undefined/blank fields so stored JSON stays tidy. */
function tidy(match: RuleMatch, actions: RuleActions): { match: RuleMatch; actions: RuleActions } {
  const m: RuleMatch = {};
  if (match.payee && match.payee.value.trim() !== "") m.payee = { op: match.payee.op, value: match.payee.value.trim() };
  if (match.amountMin !== undefined) m.amountMin = match.amountMin;
  if (match.amountMax !== undefined) m.amountMax = match.amountMax;
  if (match.direction !== undefined) m.direction = match.direction;
  if (match.accountId !== undefined) m.accountId = match.accountId;
  const a: RuleActions = {};
  if (actions.categoryId !== undefined) a.categoryId = actions.categoryId;
  if (actions.renamePayee) a.renamePayee = actions.renamePayee;
  return { match: m, actions: a };
}

function check(db: Db, match: RuleMatch, actions: RuleActions): void {
  try {
    validateRule(match, actions);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  assertCategoryExists(db, actions.categoryId);
  if (match.accountId !== undefined && !db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(match.accountId)) {
    throw badRequest("That account doesn't exist.");
  }
}

export function listRules(db: Db): RuleView[] {
  return loadRules(db).map((r) => ({ ...r, matchCount: transactionsMatching(db, r.match).length }));
}

function getRule(db: Db, id: number): RuleView {
  const rule = listRules(db).find((r) => r.id === id);
  if (!rule) throw notFound("Rule");
  return rule;
}

export function registerRuleRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/rules", async () => listRules(db));

  app.post("/api/rules", async (request, reply) => {
    const input = parse(ruleInputSchema, request.body);
    const { match, actions } = tidy(input.match, input.actions);
    check(db, match, actions);
    const bounds = db.prepare("SELECT MIN(priority) AS lo, MAX(priority) AS hi FROM rules").get() as {
      lo: number | null;
      hi: number | null;
    };
    const priority = input.position === "top" ? (bounds.lo ?? 100) - 10 : (bounds.hi ?? 90) + 10;
    const result = db
      .prepare("INSERT INTO rules (priority, match, actions) VALUES (?, ?, ?)")
      .run(priority, JSON.stringify(match), JSON.stringify(actions));
    const changed = input.applyToExisting ? recategorize(db) : 0;
    return reply.code(201).send({ rule: getRule(db, Number(result.lastInsertRowid)), changed });
  });

  app.patch("/api/rules/:id", async (request) => {
    const id = idParam(request.params);
    const current = getRule(db, id);
    const patch = parse(rulePatchSchema, request.body);
    const { match, actions } = tidy(patch.match ?? current.match, patch.actions ?? current.actions);
    check(db, match, actions);
    db.prepare("UPDATE rules SET match = ?, actions = ? WHERE id = ?").run(JSON.stringify(match), JSON.stringify(actions), id);
    const changed = patch.applyToExisting ? recategorize(db) : 0;
    return { rule: getRule(db, id), changed };
  });

  app.delete("/api/rules/:id", async (request) => {
    const id = idParam(request.params);
    getRule(db, id);
    const affected = (
      db.prepare("SELECT id FROM transactions WHERE rule_id = ? AND category_source = 'rule'").all(id) as { id: number }[]
    ).map((r) => r.id);
    db.prepare("DELETE FROM rules WHERE id = ?").run(id);
    // Transactions this rule categorized fall through to the next matching rule, or become uncategorized.
    return { changed: recategorize(db, affected) };
  });

  app.post("/api/rules/preview", async (request): Promise<RulePreview> => {
    const { match } = parse(rulePreviewSchema, request.body);
    const tidied = tidy(match, {}).match;
    const ids = transactionsMatching(db, tidied).map((m) => m.id);
    const samples = ids.slice(0, 10).map(
      (id) =>
        db
          .prepare(
            `SELECT t.id, t.date, t.payee, t.amount, c.name AS categoryName
             FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`,
          )
          .get(id) as RulePreview["samples"][number],
    );
    return { matchCount: ids.length, samples };
  });

  app.post("/api/rules/reorder", async (request) => {
    const { ids } = parse(ruleReorderSchema, request.body);
    const existing = new Set(loadRules(db).map((r) => r.id));
    if (ids.length !== existing.size || new Set(ids).size !== ids.length || !ids.every((id) => existing.has(id))) {
      throw badRequest("Send every rule id exactly once, in the new order.");
    }
    const stmt = db.prepare("UPDATE rules SET priority = ? WHERE id = ?");
    db.transaction(() => ids.forEach((id, i) => stmt.run((i + 1) * 10, id)))();
    const changed = recategorize(db);
    return { rules: listRules(db), changed };
  });
}

import type { FastifyInstance } from "fastify";
import type { CategoryView } from "../shared/api.ts";
import { categoryInputSchema, categoryPatchSchema, type BudgetType } from "../shared/schemas.ts";
import type { Db } from "./db.ts";
import { HttpError, badRequest, idParam, notFound, parse } from "./http.ts";

interface CategoryRow {
  id: number;
  name: string;
  group_name: string;
  budget_type: BudgetType;
  is_essential: number;
  is_system: number;
  txn_count: number;
}

const SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id AND t.status = 'posted') AS txn_count
  FROM categories c`;

function toView(r: CategoryRow): CategoryView {
  return {
    id: r.id,
    name: r.name,
    group: r.group_name,
    budgetType: r.budget_type,
    isEssential: r.is_essential === 1,
    isSystem: r.is_system === 1,
    transactionCount: r.txn_count,
  };
}

export function listCategories(db: Db): CategoryView[] {
  return (db.prepare(`${SELECT} ORDER BY c.sort, c.name`).all() as CategoryRow[]).map(toView);
}

export function getCategory(db: Db, id: number): CategoryView {
  const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as CategoryRow | undefined;
  if (!row) throw notFound("Category");
  return toView(row);
}

export function transferCategoryId(db: Db): number {
  const row = db.prepare("SELECT id FROM categories WHERE is_system = 1 AND budget_type = 'transfer' LIMIT 1").get() as
    | { id: number }
    | undefined;
  if (!row) throw new Error("The Transfer category is missing.");
  return row.id;
}

export function assertCategoryExists(db: Db, id: number | null | undefined): void {
  if (id == null) return;
  if (!db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id)) throw badRequest("That category doesn't exist.");
}

function nameTaken(db: Db, name: string, exceptId?: number): boolean {
  return db.prepare("SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE AND id IS NOT ?").get(name, exceptId ?? null) !== undefined;
}

export function registerCategoryRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/categories", async () => listCategories(db));

  app.post("/api/categories", async (request, reply) => {
    const input = parse(categoryInputSchema, request.body);
    if (input.budgetType === "transfer") throw badRequest("There's already a Transfer category.");
    if (nameTaken(db, input.name)) throw new HttpError(409, `There's already a category called "${input.name}".`);
    const sort = (db.prepare("SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM categories WHERE is_system = 0").get() as { s: number }).s;
    const result = db
      .prepare("INSERT INTO categories (name, group_name, budget_type, is_essential, sort) VALUES (?, ?, ?, ?, ?)")
      .run(input.name, input.group, input.budgetType, input.isEssential ? 1 : 0, sort);
    return reply.code(201).send(getCategory(db, Number(result.lastInsertRowid)));
  });

  app.patch("/api/categories/:id", async (request) => {
    const id = idParam(request.params);
    const current = getCategory(db, id);
    const patch = parse(categoryPatchSchema, request.body);
    if (current.isSystem && (patch.budgetType !== undefined && patch.budgetType !== current.budgetType)) {
      throw badRequest("The Transfer category's type can't change.");
    }
    if (!current.isSystem && patch.budgetType === "transfer") throw badRequest("There's already a Transfer category.");
    if (patch.name !== undefined && nameTaken(db, patch.name, id)) {
      throw new HttpError(409, `There's already a category called "${patch.name}".`);
    }
    db.prepare("UPDATE categories SET name = ?, group_name = ?, budget_type = ?, is_essential = ? WHERE id = ?").run(
      patch.name ?? current.name,
      patch.group ?? current.group,
      patch.budgetType ?? current.budgetType,
      (patch.isEssential ?? current.isEssential) ? 1 : 0,
      id,
    );
    return getCategory(db, id);
  });

  /** Transactions in the category become uncategorized; rules that set it are deleted. */
  app.delete("/api/categories/:id", async (request, reply) => {
    const id = idParam(request.params);
    const current = getCategory(db, id);
    if (current.isSystem) throw badRequest(`"${current.name}" is built in and can't be deleted.`);
    db.transaction(() => {
      db.prepare("DELETE FROM rules WHERE json_extract(actions, '$.categoryId') = ?").run(id);
      db.prepare("UPDATE transactions SET category_source = NULL WHERE category_id = ?").run(id);
      db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    })();
    return reply.code(204).send();
  });
}

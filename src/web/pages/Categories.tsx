import { useState } from "react";
import type { CategoryView } from "../../shared/api.ts";
import { BUDGET_TYPES, BUDGET_TYPE_LABELS, type BudgetType } from "../../shared/schemas.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { Link } from "../router.tsx";

const TYPE_HELP: Record<BudgetType, string> = {
  income: "Paychecks and other money coming in.",
  fixed: "About the same every month: rent, insurance, utilities, subscriptions.",
  flex: "Day-to-day spending that comes out of one flexible pool.",
  non_monthly: "Irregular but predictable: travel, car registration, holidays. Saved for monthly.",
  transfer: "Money moving between your own accounts. Not spending.",
};

function CategoryRow({ category, onChanged }: { category: CategoryView; onChanged: () => void }) {
  const [name, setName] = useState(category.name);
  const [group, setGroup] = useState(category.group);
  const [error, setError] = useState<string>();

  const patch = async (body: Partial<{ name: string; group: string; budgetType: BudgetType; isEssential: boolean }>) => {
    try {
      await api("PATCH", `/api/categories/${category.id}`, body);
      setError(undefined);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setName(category.name);
      setGroup(category.group);
    }
  };

  const remove = async () => {
    const used = category.transactionCount;
    const msg = used > 0 ? `Delete “${category.name}”? Its ${used} transactions become uncategorized, and rules that set it are deleted.` : `Delete “${category.name}”?`;
    if (!window.confirm(msg)) return;
    try {
      await api("DELETE", `/api/categories/${category.id}`);
      notifyDataChanged();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <tr>
      <td>
        <input
          aria-label="Category name"
          value={name}
          disabled={category.isSystem}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== category.name && void patch({ name })}
        />
        <ErrorNote message={error} />
      </td>
      <td>
        <input aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value)} onBlur={() => group !== category.group && void patch({ group })} />
      </td>
      <td>
        <select
          aria-label="Type"
          value={category.budgetType}
          disabled={category.isSystem}
          onChange={(e) => void patch({ budgetType: e.target.value as BudgetType })}
        >
          {BUDGET_TYPES.filter((t) => t !== "transfer" || category.isSystem).map((t) => (
            <option key={t} value={t}>
              {BUDGET_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </td>
      <td className="center">
        <input
          type="checkbox"
          aria-label="Essential"
          checked={category.isEssential}
          disabled={category.isSystem}
          onChange={(e) => void patch({ isEssential: e.target.checked })}
        />
      </td>
      <td className="num">
        <Link to={`/transactions?categoryId=${category.id}`}>{category.transactionCount}</Link>
      </td>
      <td className="num">
        {!category.isSystem && (
          <button type="button" className="link danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}

export function CategoriesPage() {
  const categories = useApi<CategoryView[]>("/api/categories");
  const [name, setName] = useState("");
  const [type, setType] = useState<BudgetType>("flex");
  const [error, setError] = useState<string>();

  const add = async () => {
    try {
      await api("POST", "/api/categories", { name, budgetType: type });
      setName("");
      setError(undefined);
      await categories.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!categories.data) return categories.error ? <ErrorNote message={categories.error} /> : <Loading />;

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle="Each category has a budget type, which decides how it's budgeted. Essential categories size your emergency fund."
      />
      <section className="panel">
        <div className="inline-form">
          <input aria-label="New category name" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
          <select aria-label="New category type" value={type} onChange={(e) => setType(e.target.value as BudgetType)}>
            {BUDGET_TYPES.filter((t) => t !== "transfer").map((t) => (
              <option key={t} value={t}>
                {BUDGET_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void add()} disabled={name.trim() === ""}>
            Add category
          </button>
        </div>
        <ErrorNote message={error} />
      </section>

      {BUDGET_TYPES.map((t) => {
        const list = categories.data!.filter((c) => c.budgetType === t);
        if (list.length === 0) return null;
        return (
          <section className="panel tight" key={t}>
            <h2>{BUDGET_TYPE_LABELS[t]}</h2>
            <p className="muted small">{TYPE_HELP[t]}</p>
            <div className="table-wrap">
<table className="table compact edit">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Group</th>
                  <th>Type</th>
                  <th className="center">Essential</th>
                  <th className="num">Transactions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <CategoryRow key={`${c.id}-${c.name}-${c.group}`} category={c} onChanged={() => void categories.reload()} />
                ))}
              </tbody>
            </table>
</div>
          </section>
        );
      })}
    </>
  );
}

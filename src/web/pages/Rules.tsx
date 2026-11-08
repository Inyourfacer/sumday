import { useState } from "react";
import type { AccountView, CategoryView, RuleView } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { RuleForm } from "../components/RuleForm.tsx";
import { describeRule } from "../components/ruleText.ts";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { plural } from "../format.ts";

export function RulesPage() {
  const rules = useApi<RuleView[]>("/api/rules");
  const categories = useApi<CategoryView[]>("/api/categories");
  const accounts = useApi<AccountView[]>("/api/accounts");
  const [editing, setEditing] = useState<RuleView | "new">();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  if (!rules.data || !categories.data) return rules.error ? <ErrorNote message={rules.error} /> : <Loading />;
  const list = rules.data;

  const move = async (index: number, delta: -1 | 1) => {
    const ids = list.map((r) => r.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    try {
      const result = await api<{ changed: number }>("POST", "/api/rules/reorder", { ids });
      setMessage(result.changed > 0 ? `${plural(result.changed, "transaction")} recategorized.` : undefined);
      notifyDataChanged();
      await rules.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (rule: RuleView) => {
    if (!window.confirm("Delete this rule? Transactions it categorized fall back to the next matching rule.")) return;
    const result = await api<{ changed: number }>("DELETE", `/api/rules/${rule.id}`);
    setMessage(`Rule deleted. ${plural(result.changed, "transaction")} recategorized.`);
    notifyDataChanged();
    await rules.reload();
  };

  return (
    <>
      <PageHeader
        title="Rules"
        subtitle="Rules run top to bottom on every new transaction; the first one that matches decides. Categories you set by hand always win."
        actions={
          <button type="button" onClick={() => setEditing("new")}>
            New rule
          </button>
        }
      />
      {message && <div className="note ok">{message}</div>}
      <ErrorNote message={error} />
      {list.length === 0 ? (
        <Empty>
          <p>No rules yet. When you change a transaction's category, Sumday offers to make a rule from it.</p>
        </Empty>
      ) : (
        <ol className="rule-list">
          {list.map((r, i) => {
            const { when, then } = describeRule(r.match, r.actions, categories.data!, accounts.data ?? []);
            return (
              <li key={r.id}>
                <span className="rule-order">{i + 1}</span>
                <div className="rule-text">
                  <div>
                    <span className="muted">When</span> {when}
                  </div>
                  <div>
                    <span className="muted">then</span> {then}
                  </div>
                  <span className="muted small">Matches {plural(r.matchCount, "transaction")}</span>
                </div>
                <div className="rule-actions">
                  <button type="button" className="icon" aria-label="Move up" disabled={i === 0} onClick={() => void move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="icon" aria-label="Move down" disabled={i === list.length - 1} onClick={() => void move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="link" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button type="button" className="link danger" onClick={() => void remove(r)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {editing && (
        <RuleForm
          initial={editing === "new" ? undefined : editing}
          ruleId={editing === "new" ? undefined : editing.id}
          categories={categories.data}
          accounts={accounts.data ?? []}
          onClose={() => setEditing(undefined)}
          onSaved={(changed) => {
            setEditing(undefined);
            setMessage(`Rule saved. ${plural(changed, "transaction")} updated.`);
            void rules.reload();
          }}
        />
      )}
    </>
  );
}

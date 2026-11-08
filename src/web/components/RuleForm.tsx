import { useEffect, useState } from "react";
import type { AccountView, CategoryView, RuleActions, RuleMatch, RulePreview, RuleSuggestion } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged } from "../api.ts";
import { plural } from "../format.ts";
import { OP_LABELS, describeRule } from "./ruleText.ts";
import { Amount, CategorySelect, ErrorNote, Field, Modal, MoneyInput } from "./ui.tsx";

export function RuleForm({
  initial,
  ruleId,
  position = "bottom",
  categories,
  accounts,
  onClose,
  onSaved,
}: {
  initial?: { match: RuleMatch; actions: RuleActions };
  ruleId?: number;
  position?: "top" | "bottom";
  categories: readonly CategoryView[];
  accounts: readonly AccountView[];
  onClose: () => void;
  onSaved: (changed: number) => void;
}) {
  const [match, setMatch] = useState<RuleMatch>(initial?.match ?? { payee: { op: "contains", value: "" } });
  const [actions, setActions] = useState<RuleActions>(initial?.actions ?? {});
  const [applyToExisting, setApplyToExisting] = useState(true);
  const [preview, setPreview] = useState<RulePreview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const timer = setTimeout(() => {
      api<RulePreview>("POST", "/api/rules/preview", { match })
        .then(setPreview)
        .catch(() => setPreview(undefined));
    }, 250);
    return () => clearTimeout(timer);
  }, [match]);

  const payee = match.payee ?? { op: "contains" as const, value: "" };

  const save = async () => {
    try {
      const body = { match, actions, applyToExisting, position };
      const result = ruleId
        ? await api<{ changed: number }>("PATCH", `/api/rules/${ruleId}`, body)
        : await api<{ changed: number }>("POST", "/api/rules", body);
      notifyDataChanged();
      onSaved(result.changed);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      wide
      title={ruleId ? "Edit rule" : "New rule"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()}>
            Save rule
          </button>
        </>
      }
    >
      <h4>When a transaction…</h4>
      <div className="form-grid">
        <Field label="Payee">
          <span className="row">
            <select
              aria-label="Payee condition"
              value={payee.op}
              onChange={(e) => setMatch({ ...match, payee: { ...payee, op: e.target.value as typeof payee.op } })}
            >
              {Object.entries(OP_LABELS).map(([op, label]) => (
                <option key={op} value={op}>
                  {label}
                </option>
              ))}
            </select>
            <input
              aria-label="Payee text"
              value={payee.value}
              placeholder="e.g. Trader Joe"
              onChange={(e) => {
                const value = e.target.value;
                const { payee: _drop, ...rest } = match;
                setMatch(value === "" && payee.op === "contains" ? rest : { ...match, payee: { ...payee, value } });
              }}
            />
          </span>
        </Field>
        <Field label="Direction">
          <select
            value={match.direction ?? ""}
            onChange={(e) => {
              const { direction: _drop, ...rest } = match;
              setMatch(e.target.value === "" ? rest : { ...match, direction: e.target.value as "debit" | "credit" });
            }}
          >
            <option value="">Money in or out</option>
            <option value="debit">Money out</option>
            <option value="credit">Money in</option>
          </select>
        </Field>
        <Field label="Amount at least">
          <MoneyInput
            value={match.amountMin ?? null}
            onChange={(v) => {
              const { amountMin: _drop, ...rest } = match;
              setMatch(v === null ? rest : { ...match, amountMin: v });
            }}
          />
        </Field>
        <Field label="Amount at most">
          <MoneyInput
            value={match.amountMax ?? null}
            onChange={(v) => {
              const { amountMax: _drop, ...rest } = match;
              setMatch(v === null ? rest : { ...match, amountMax: v });
            }}
          />
        </Field>
        <Field label="Account">
          <select
            value={match.accountId ?? ""}
            onChange={(e) => {
              const { accountId: _drop, ...rest } = match;
              setMatch(e.target.value === "" ? rest : { ...match, accountId: Number(e.target.value) });
            }}
          >
            <option value="">Any account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <h4>…then</h4>
      <div className="form-grid">
        <Field label="Set category">
          <CategorySelect
            categories={categories}
            value={actions.categoryId ?? null}
            noneLabel="Don't change"
            onChange={(id) => {
              const { categoryId: _drop, ...rest } = actions;
              setActions(id === null ? rest : { ...actions, categoryId: id });
            }}
          />
        </Field>
        <Field label="Rename payee to" hint="Optional">
          <input
            value={actions.renamePayee ?? ""}
            onChange={(e) => {
              const { renamePayee: _drop, ...rest } = actions;
              setActions(e.target.value === "" ? rest : { ...actions, renamePayee: e.target.value });
            }}
          />
        </Field>
      </div>

      <label className="check">
        <input type="checkbox" checked={applyToExisting} onChange={(e) => setApplyToExisting(e.target.checked)} />
        Also update existing transactions (ones you categorized by hand are left alone)
      </label>

      {preview && (
        <div className="preview">
          <strong>Matches {plural(preview.matchCount, "transaction")}</strong>
          {preview.samples.length > 0 && (
            <ul>
              {preview.samples.map((s) => (
                <li key={s.id}>
                  <span>{s.payee}</span>
                  <span className="muted small">{s.categoryName ?? "Uncategorized"}</span>
                  <Amount cents={s.amount} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorNote message={error} />
    </Modal>
  );
}

/** Shown after a manual recategorization: offer to turn it into a rule. */
export function RuleSuggestionBar({
  suggestion,
  categories,
  accounts,
  onDone,
}: {
  suggestion: RuleSuggestion;
  categories: readonly CategoryView[];
  accounts: readonly AccountView[];
  onDone: (changed: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const { when, then } = describeRule(suggestion.match, suggestion.actions, categories, accounts);

  const accept = async () => {
    try {
      const result = await api<{ changed: number }>("POST", "/api/rules", {
        match: suggestion.match,
        actions: suggestion.actions,
        position: "top",
        applyToExisting: true,
      });
      notifyDataChanged();
      onDone(result.changed);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="suggestion" role="status">
      <div>
        <strong>Make this a rule?</strong> When {when}, {then}.
        {suggestion.otherMatches > 0 && (
          <span className="muted"> Also updates {plural(suggestion.otherMatches, "other transaction")}.</span>
        )}
        <ErrorNote message={error} />
      </div>
      <div className="row">
        <button type="button" className="small" onClick={() => void accept()}>
          Create rule
        </button>
        <button type="button" className="secondary small" onClick={() => setEditing(true)}>
          Edit first
        </button>
        <button type="button" className="link small" onClick={() => onDone(null)}>
          No thanks
        </button>
      </div>
      {editing && (
        <RuleForm
          initial={suggestion}
          position="top"
          categories={categories}
          accounts={accounts}
          onClose={() => setEditing(false)}
          onSaved={(changed) => {
            setEditing(false);
            onDone(changed);
          }}
        />
      )}
    </div>
  );
}

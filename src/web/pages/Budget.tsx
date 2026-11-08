import { useState } from "react";
import { endOfMonth } from "../../engine/dates.ts";
import { firstDay, nextMonth } from "../../engine/budget/budget.ts";
import type { BudgetResponse, BudgetSuggestionsResponse } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { monthTitle, pct } from "../chartMath.ts";
import { Meter } from "../components/charts.tsx";
import { Amount, ErrorNote, Loading, Modal, MoneyInput, PageHeader } from "../components/ui.tsx";
import { formatMoney } from "../format.ts";
import { useLocation } from "../navigation.ts";
import { Link } from "../router.tsx";

const FIXED_STATUS = {
  ok: "On budget",
  over: "Over",
  under: "Under",
  upcoming: "Not paid yet",
  unbudgeted: "No budget",
} as const;

/** Link to the transactions behind a number. */
function txLink(categoryId: number | null, month: string): string {
  const range = `from=${firstDay(month)}&to=${endOfMonth(firstDay(month))}`;
  return categoryId === null ? `/transactions?uncategorized=true&${range}` : `/transactions?categoryId=${categoryId}&${range}`;
}

function BudgetInput({ categoryId, value, onSaved, label }: { categoryId: number; value: number | null; onSaved: () => void; label: string }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (draft === value) return;
    try {
      await api("PUT", "/api/budget/categories", { items: [{ categoryId, amount: draft }] });
      setError(undefined);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <span className="budget-input" onBlur={() => void save()}>
      <MoneyInput value={draft} onChange={setDraft} ariaLabel={label} placeholder="Set" />
      {error && <span className="field-problem">{error}</span>}
    </span>
  );
}

function SuggestionsModal({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const suggestions = useApi<BudgetSuggestionsResponse>("/api/budget/suggestions");
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string>();
  const s = suggestions.data;

  const apply = async () => {
    if (!s) return;
    try {
      const items = s.budgets.filter((b) => !skip.has(b.categoryId)).map((b) => ({ categoryId: b.categoryId, amount: b.amount }));
      if (items.length > 0) await api("PUT", "/api/budget/categories", { items });
      if (s.expectedIncome !== null && !skip.has(-1)) await api("PUT", "/api/budget/settings", { expectedIncome: s.expectedIncome });
      notifyDataChanged();
      onApplied();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const toggle = (id: number) => {
    const next = new Set(skip);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSkip(next);
  };

  return (
    <Modal
      wide
      title="Budget from your history"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!s || (s.budgets.length === 0 && s.expectedIncome === null)} onClick={() => void apply()}>
            Use these
          </button>
        </>
      }
    >
      {!s && <Loading />}
      {s && s.basedOnMonths.length === 0 && (
        <p className="muted">There isn't a full month of transactions yet. Import at least one complete month, or set amounts by hand.</p>
      )}
      {s && s.basedOnMonths.length > 0 && (
        <>
          <p className="muted small">
            Based on {s.basedOnMonths.length === 1 ? monthTitle(s.basedOnMonths[0]!) : `${monthTitle(s.basedOnMonths[0]!)} – ${monthTitle(s.basedOnMonths.at(-1)!)}`}.
            Fixed bills and income use the average of the last three months; non-monthly costs use the yearly total. Untick anything
            you don't want.
          </p>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th />
                  <th>Category</th>
                  <th className="num">Suggested</th>
                  <th className="num">Current</th>
                </tr>
              </thead>
              <tbody>
                {s.expectedIncome !== null && (
                  <tr>
                    <td>
                      <input type="checkbox" aria-label="Use expected income" checked={!skip.has(-1)} onChange={() => toggle(-1)} />
                    </td>
                    <td>Expected monthly income</td>
                    <td className="num">{formatMoney(s.expectedIncome, { cents: false })}/mo</td>
                    <td />
                  </tr>
                )}
                {s.budgets.map((b) => (
                  <tr key={b.categoryId}>
                    <td>
                      <input type="checkbox" aria-label={`Use ${b.name}`} checked={!skip.has(b.categoryId)} onChange={() => toggle(b.categoryId)} />
                    </td>
                    <td>{b.name}</td>
                    <td className="num">
                      {formatMoney(b.amount, { cents: false })}
                      {b.budgetType === "non_monthly" ? "/yr" : "/mo"}
                    </td>
                    <td className="num muted">{b.current === null ? "—" : formatMoney(b.current, { cents: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <ErrorNote message={error} />
    </Modal>
  );
}

export function BudgetPage() {
  const { query } = useLocation();
  const [month, setMonth] = useState<string | undefined>(query.get("month") ?? undefined);
  const data = useApi<BudgetResponse>(`/api/budget${month ? `?month=${month}` : ""}`);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string>();

  if (!data.data) return data.error ? <ErrorNote message={data.error} /> : <Loading />;
  const { budget: b, settings } = data.data;
  const reload = () => {
    notifyDataChanged();
    void data.reload();
  };
  const saveSetting = async (patch: Record<string, unknown>) => {
    try {
      await api("PUT", "/api/budget/settings", patch);
      setError(undefined);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const nothingSet = settings.expectedIncome === null && b.fixed.budget === 0 && b.nonMonthly.lines.every((l) => l.annual === null);
  const over = b.flex.left !== null && b.flex.left < 0;

  return (
    <>
      <PageHeader
        title="Budget"
        actions={
          <div className="month-nav">
            <button type="button" className="icon" aria-label="Previous month" onClick={() => setMonth(nextMonth(b.month, -1))}>
              ‹
            </button>
            <strong>{monthTitle(b.month)}</strong>
            <button type="button" className="icon" aria-label="Next month" onClick={() => setMonth(nextMonth(b.month, 1))}>
              ›
            </button>
            {b.timing !== "current" && (
              <button type="button" className="link small" onClick={() => setMonth(undefined)}>
                This month
              </button>
            )}
          </div>
        }
      />
      <ErrorNote message={error} />

      {nothingSet && (
        <div className="suggestion">
          <div>
            <strong>Set up your budget.</strong> Start from what you actually spent, then adjust.
          </div>
          <button type="button" className="small" onClick={() => setSuggesting(true)}>
            Suggest from my history
          </button>
        </div>
      )}

      <section className="panel flex-hero">
        <div className="flex-head">
          <div>
            <span className="field-label">{over ? "Over the Flex budget by" : b.timing === "past" ? "Flex left over" : "Left to spend (Flex)"}</span>
            <div className={`hero ${over ? "over" : ""}`}>
              {b.flex.left === null ? "—" : formatMoney(Math.abs(b.flex.left), { cents: false })}
            </div>
          </div>
          {b.flex.pace && (
            <div className="pace">
              <span className={`pace-status ${b.flex.pace.status}`}>
                {b.flex.pace.status === "under" ? "✓ Under pace" : b.flex.pace.status === "on" ? "• On pace" : "! Ahead of pace"}
              </span>
              <span className="muted small">
                {formatMoney(b.flex.pace.perDayLeft, { cents: false })}/day for the {b.daysLeft} days left
              </span>
            </div>
          )}
        </div>
        {b.flex.budget !== null ? (
          <>
            <Meter used={b.flex.actual} total={b.flex.budget} label="Flex budget used" />
            <p className="muted small">
              {formatMoney(b.flex.actual, { cents: false })} spent of {formatMoney(b.flex.budget, { cents: false })}
              {b.flex.pace && <> · {formatMoney(b.flex.pace.expectedByNow, { cents: false })} expected by today</>}
            </p>
          </>
        ) : (
          <p className="muted">Enter your expected monthly income below to get a Flex budget.</p>
        )}
        <div className="equation" aria-label="How the Flex budget is calculated">
          <span>
            <span className="muted small">Expected income</span>
            <strong>{settings.expectedIncome === null ? "not set" : formatMoney(settings.expectedIncome, { cents: false })}</strong>
          </span>
          <span className="op">−</span>
          <span>
            <span className="muted small">Fixed</span>
            <strong>{formatMoney(b.fixed.budget, { cents: false })}</strong>
          </span>
          <span className="op">−</span>
          <span>
            <span className="muted small">Non-monthly</span>
            <strong>{formatMoney(b.nonMonthly.setAside, { cents: false })}</strong>
          </span>
          <span className="op">−</span>
          <span>
            <span className="muted small">Savings</span>
            <strong>{formatMoney(settings.plannedSavings, { cents: false })}</strong>
          </span>
          <span className="op">=</span>
          <span>
            <span className="muted small">Flex</span>
            <strong>{b.flex.budget === null ? "—" : formatMoney(b.flex.budget, { cents: false })}</strong>
          </span>
        </div>
      </section>

      <SettingsRow
        key={`${settings.expectedIncome}-${settings.plannedSavings}`}
        settings={settings}
        onSave={saveSetting}
        onSuggest={() => setSuggesting(true)}
      />

      <section className="panel tight">
        <div className="group-head">
          <h2>Income</h2>
          <span>
            <Amount cents={b.income.actual} />
            {b.income.expected !== null && <span className="muted small"> of {formatMoney(b.income.expected, { cents: false })} expected</span>}
          </span>
        </div>
        <ul className="lines">
          {b.income.lines.map((l) => (
            <li key={l.categoryId}>
              <Link to={txLink(l.categoryId, b.month)}>{l.name}</Link>
              <Amount cents={l.actual} />
            </li>
          ))}
          {b.income.uncategorizedIn > 0 && (
            <li className="muted">
              <Link to={txLink(null, b.month)}>Uncategorized money in</Link>
              <Amount cents={b.income.uncategorizedIn} />
            </li>
          )}
          {b.income.lines.length === 0 && b.income.uncategorizedIn === 0 && <li className="muted">No income recorded this month.</li>}
        </ul>
      </section>

      <section className="panel tight">
        <div className="group-head">
          <h2>Fixed</h2>
          <span>
            {formatMoney(b.fixed.actual, { cents: false })} <span className="muted small">of {formatMoney(b.fixed.budget, { cents: false })}</span>
          </span>
        </div>
        <p className="muted small">Bills that are about the same every month. Budgets are monthly.</p>
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Budget / month</th>
                <th className="num">Spent</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {b.fixed.lines.map((l) => (
                <tr key={l.categoryId}>
                  <td>
                    <Link to={txLink(l.categoryId, b.month)}>{l.name}</Link>
                  </td>
                  <td className="num">
                    <BudgetInput key={`${l.categoryId}-${l.budget}`} categoryId={l.categoryId} value={l.budget} onSaved={reload} label={`${l.name} monthly budget`} />
                  </td>
                  <td className="num">{formatMoney(l.actual)}</td>
                  <td>
                    <span className={`status ${l.status}`}>{FIXED_STATUS[l.status]}</span>
                  </td>
                </tr>
              ))}
              <AddBudgetRow type="fixed" existing={b.fixed.lines.map((l) => l.categoryId)} onSaved={reload} />
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel tight">
        <div className="group-head">
          <h2>Flex</h2>
          <span>
            {formatMoney(b.flex.actual, { cents: false })}
            {b.flex.budget !== null && <span className="muted small"> of {formatMoney(b.flex.budget, { cents: false })}</span>}
          </span>
        </div>
        <p className="muted small">Everyday spending shares one pool, so there's no budget per category.</p>
        <ul className="lines">
          {b.flex.lines.map((l) => (
            <li key={l.categoryId}>
              <Link to={txLink(l.categoryId, b.month)}>{l.name}</Link>
              <span>{formatMoney(l.actual)}</span>
            </li>
          ))}
          {b.flex.uncategorized > 0 && (
            <li>
              <span>
                <Link to={txLink(null, b.month)}>Uncategorized</Link> <span className="muted small">(counts as Flex until categorized)</span>
              </span>
              <span>{formatMoney(b.flex.uncategorized)}</span>
            </li>
          )}
          {b.flex.lines.length === 0 && b.flex.uncategorized === 0 && <li className="muted">No Flex spending this month.</li>}
        </ul>
      </section>

      <section className="panel tight">
        <div className="group-head">
          <h2>Non-monthly</h2>
          <span>
            {formatMoney(b.nonMonthly.setAside, { cents: false })} <span className="muted small">set aside this month</span>
          </span>
        </div>
        <p className="muted small">
          Irregular costs. Each has a yearly budget; a twelfth is set aside every month into its fund, and spending draws the fund down.
          {settings.fundStart && <> Funds started {monthTitle(settings.fundStart)}.</>}
        </p>
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Budget / year</th>
                <th className="num">Set aside</th>
                <th className="num">Spent</th>
                <th className="num">Fund</th>
              </tr>
            </thead>
            <tbody>
              {b.nonMonthly.lines.map((l) => (
                <tr key={l.categoryId}>
                  <td>
                    <Link to={txLink(l.categoryId, b.month)}>{l.name}</Link>
                  </td>
                  <td className="num">
                    <BudgetInput key={`${l.categoryId}-${l.annual}`} categoryId={l.categoryId} value={l.annual} onSaved={reload} label={`${l.name} yearly budget`} />
                  </td>
                  <td className="num">{formatMoney(l.setAside)}</td>
                  <td className="num">{formatMoney(l.actual)}</td>
                  <td className={`num ${l.fundBalance < 0 ? "negative" : ""}`}>
                    {formatMoney(l.fundBalance)}
                    {l.fundBalance < 0 && <span className="status over"> Short</span>}
                  </td>
                </tr>
              ))}
              <AddBudgetRow type="non_monthly" existing={b.nonMonthly.lines.map((l) => l.categoryId)} onSaved={reload} />
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel tight">
        <div className="group-head">
          <h2>Savings</h2>
          <span>
            {formatMoney(b.savings.actual, { cents: false })} <span className="muted small">of {formatMoney(b.savings.planned, { cents: false })} planned</span>
          </span>
        </div>
        <p className="muted small">
          Money moved from everyday accounts into savings, investment and retirement accounts (linked transfers). Payroll 401(k)
          contributions don't pass through your accounts, so they aren't counted here.
        </p>
        <p className="small">
          This month you kept <strong>{formatMoney(b.totals.net, { cents: false })}</strong> of your income (savings rate{" "}
          <strong>{pct(b.totals.savingsRate)}</strong>).
        </p>
      </section>

      {suggesting && (
        <SuggestionsModal
          onClose={() => setSuggesting(false)}
          onApplied={() => {
            setSuggesting(false);
            reload();
          }}
        />
      )}
    </>
  );
}

function SettingsRow({
  settings,
  onSave,
  onSuggest,
}: {
  settings: BudgetResponse["settings"];
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onSuggest: () => void;
}) {
  const [income, setIncome] = useState(settings.expectedIncome);
  const [savings, setSavings] = useState<number | null>(settings.plannedSavings);
  return (
    <section className="panel tight settings-row">
      <label className="field">
        <span className="field-label">Expected monthly income (take-home)</span>
        <span onBlur={() => income !== settings.expectedIncome && void onSave({ expectedIncome: income })}>
          <MoneyInput value={income} onChange={setIncome} placeholder="Set" ariaLabel="Expected monthly income (take-home)" />
        </span>
      </label>
      <label className="field">
        <span className="field-label">Planned savings per month</span>
        <span onBlur={() => (savings ?? 0) !== settings.plannedSavings && void onSave({ plannedSavings: savings ?? 0 })}>
          <MoneyInput value={savings} onChange={setSavings} ariaLabel="Planned savings per month" />
        </span>
      </label>
      <label className="field">
        <span className="field-label">Sinking funds start</span>
        <input
          type="month"
          value={settings.fundStart ?? ""}
          onChange={(e) => e.target.value && void onSave({ fundStart: e.target.value })}
        />
      </label>
      <button type="button" className="secondary small" onClick={onSuggest}>
        Suggest from history
      </button>
    </section>
  );
}

function AddBudgetRow({ type, existing, onSaved }: { type: "fixed" | "non_monthly"; existing: number[]; onSaved: () => void }) {
  const categories = useApi<{ id: number; name: string; budgetType: string }[]>("/api/categories");
  const options = (categories.data ?? []).filter((c) => c.budgetType === type && !existing.includes(c.id));
  if (options.length === 0) return null;
  return (
    <tr className="add-row">
      <td colSpan={5}>
        <select
          aria-label={`Add a ${type === "fixed" ? "Fixed" : "Non-monthly"} category`}
          value=""
          onChange={async (e) => {
            if (!e.target.value) return;
            await api("PUT", "/api/budget/categories", { items: [{ categoryId: Number(e.target.value), amount: 0 }] });
            onSaved();
          }}
        >
          <option value="">+ Budget another category…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}

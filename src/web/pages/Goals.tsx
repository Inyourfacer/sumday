import { useState } from "react";
import type { AccountView, GoalView } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { Meter } from "../components/charts.tsx";
import { ErrorNote, Field, Loading, Modal, MoneyInput, PageHeader } from "../components/ui.tsx";
import { formatDate, formatMoney } from "../format.ts";
import { Link } from "../router.tsx";

function GoalForm({ goal, onClose, onSaved }: { goal?: GoalView; onClose: () => void; onSaved: () => void }) {
  const emergency = goal?.kind === "emergency";
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState<number | null>(goal && !goal.targetIsAuto ? goal.targetAmount : null);
  const [date, setDate] = useState(goal?.targetDate ?? "");
  const [error, setError] = useState<string>();

  const save = async () => {
    try {
      if (goal) await api("PATCH", `/api/goals/${goal.id}`, { name, targetAmount: target, ...(emergency ? {} : { targetDate: date || null }) });
      else await api("POST", "/api/goals", { name, targetAmount: target ?? 0, targetDate: date || null });
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title={goal ? `Edit ${goal.name}` : "New goal"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. House down payment" />
        </Field>
        <Field label="Target" hint={emergency ? `Leave blank to use ${goal?.emergency?.months} months of essential spending` : undefined}>
          <MoneyInput value={target} onChange={setTarget} placeholder={emergency ? "Automatic" : "$0"} ariaLabel="Target amount" />
        </Field>
        {!emergency && (
          <Field label="Target date" hint="Optional, but needed for a monthly amount">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
      </div>
      <ErrorNote message={error} />
    </Modal>
  );
}

function EarmarkForm({ goal, all, onClose, onSaved }: { goal: GoalView; all: GoalView[]; onClose: () => void; onSaved: () => void }) {
  const accounts = useApi<AccountView[]>("/api/accounts");
  const [amounts, setAmounts] = useState<Map<number, number | null>>(new Map(goal.allocations.map((a) => [a.accountId, a.amount])));
  const [error, setError] = useState<string>();
  const eligible = (accounts.data ?? []).filter((a) => !a.isClosed && !a.isLiability);

  const save = async () => {
    try {
      const items = [...amounts].filter(([, v]) => v !== null && v > 0).map(([accountId, amount]) => ({ accountId, amount }));
      await api("PUT", `/api/goals/${goal.id}/allocations`, { items });
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      wide
      title={`Set aside for ${goal.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="muted small">
        Say how much of each account belongs to this goal. Nothing moves: it's a label, so the plan knows what's already saved.
        {goal.kind === "emergency" && " With nothing set aside here, all savings-account money not claimed by other goals counts as the emergency fund."}
      </p>
      {!accounts.data && <Loading />}
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Balance</th>
              <th className="num">Other goals</th>
              <th className="num">For {goal.name}</th>
            </tr>
          </thead>
          <tbody>
            {eligible.map((a) => {
              const others = all
                .filter((g) => g.id !== goal.id)
                .flatMap((g) => g.allocations)
                .filter((x) => x.accountId === a.id)
                .reduce((s, x) => s + x.amount, 0);
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td className="num">{formatMoney(a.balance, { cents: false })}</td>
                  <td className="num muted">{others ? formatMoney(others, { cents: false }) : "—"}</td>
                  <td className="num">
                    <span className="budget-input">
                      <MoneyInput
                        value={amounts.get(a.id) ?? null}
                        onChange={(v) => setAmounts(new Map(amounts).set(a.id, v))}
                        ariaLabel={`Amount in ${a.name} for ${goal.name}`}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorNote message={error} />
    </Modal>
  );
}

function GoalCard({
  goal,
  all,
  canMove,
  onMove,
  onChanged,
}: {
  goal: GoalView;
  all: GoalView[];
  canMove: { up: boolean; down: boolean };
  onMove: (delta: -1 | 1) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [earmarking, setEarmarking] = useState(false);
  const p = goal.progress;
  const required = p.requiredMonthly;
  const behind = required !== null && required > 0 && goal.plannedMonthly < required;

  const remove = async () => {
    if (!window.confirm(`Delete the goal “${goal.name}”? The money stays where it is.`)) return;
    await api("DELETE", `/api/goals/${goal.id}`);
    notifyDataChanged();
    onChanged();
  };

  return (
    <article className="panel goal">
      <div className="goal-head">
        <div>
          <h2>{goal.name}</h2>
          <span className="muted small">
            {goal.kind === "emergency"
              ? goal.targetIsAuto
                ? `${goal.emergency?.months} months of essential spending (${formatMoney(goal.emergency?.essentialMonthly ?? 0, { cents: false })}/mo)`
                : "Target set by hand"
              : goal.targetDate
                ? `By ${formatDate(goal.targetDate)}`
                : "No target date"}
          </span>
        </div>
        <div className="row">
          {goal.kind === "custom" && (
            <>
              <button type="button" className="icon" aria-label={`Move ${goal.name} up`} disabled={!canMove.up} onClick={() => onMove(-1)}>
                ↑
              </button>
              <button type="button" className="icon" aria-label={`Move ${goal.name} down`} disabled={!canMove.down} onClick={() => onMove(1)}>
                ↓
              </button>
            </>
          )}
          <button type="button" className="secondary small" onClick={() => setEarmarking(true)}>
            Set aside
          </button>
          <button type="button" className="secondary small" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      </div>
      <div className="goal-numbers">
        <strong>{formatMoney(p.saved, { cents: false })}</strong>
        <span className="muted"> of {formatMoney(p.target, { cents: false })}</span>
        <span className="muted small"> · {Math.round(p.percent * 100)}%</span>
      </div>
      <Meter used={p.saved} total={Math.max(p.target, 1)} label={`${goal.name} progress`} />
      <p className="small">
        {p.status === "funded" && <span className="status ok">Funded</span>}
        {p.status === "no_date" && goal.kind === "custom" && <span className="muted">Add a target date to get a monthly amount.</span>}
        {(p.status === "in_progress" || p.status === "overdue") && required !== null && (
          <>
            Needs <strong>{formatMoney(required, { cents: false })}/mo</strong>
            {p.status === "overdue" ? " (past the date)" : ` for ${p.monthsLeft} months`}.{" "}
          </>
        )}
        {goal.kind === "emergency" && p.status !== "funded" && (
          <>
            The plan puts <strong>{formatMoney(goal.plannedMonthly, { cents: false })}/mo</strong> here.
          </>
        )}
        {goal.kind === "custom" && required !== null && required > 0 && (
          <span className={behind ? "status over" : "status ok"}>
            {behind ? ` Plan has ${formatMoney(goal.plannedMonthly, { cents: false })}/mo for it: behind` : " On track"}
          </span>
        )}
      </p>
      {goal.allocations.length > 0 ? (
        <p className="muted small">Held in {goal.allocations.map((a) => `${a.accountName} (${formatMoney(a.amount, { cents: false })})`).join(", ")}</p>
      ) : goal.kind === "emergency" && goal.emergency?.basis === "savings_accounts" ? (
        <p className="muted small">Counting your savings accounts (not claimed by other goals).</p>
      ) : (
        <p className="muted small">Nothing set aside yet.</p>
      )}
      {goal.kind === "custom" && (
        <button type="button" className="link danger small" onClick={() => void remove()}>
          Delete goal
        </button>
      )}
      {editing && (
        <GoalForm
          goal={goal}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
      {earmarking && (
        <EarmarkForm
          goal={goal}
          all={all}
          onClose={() => setEarmarking(false)}
          onSaved={() => {
            setEarmarking(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

export function GoalsPage() {
  const goals = useApi<GoalView[]>("/api/goals");
  const [adding, setAdding] = useState(false);
  if (!goals.data) return goals.error ? <ErrorNote message={goals.error} /> : <Loading />;
  const list = goals.data;
  const custom = list.filter((g) => g.kind === "custom");

  const move = async (goal: GoalView, delta: -1 | 1) => {
    const ids = custom.map((g) => g.id);
    const i = ids.indexOf(goal.id);
    ids.splice(i, 1);
    ids.splice(i + delta, 0, goal.id);
    await api("POST", "/api/goals/reorder", { ids });
    notifyDataChanged();
    await goals.reload();
  };

  return (
    <>
      <PageHeader
        title="Goals"
        subtitle={
          <>
            Money for things ahead: an emergency fund, a house, a car. Goals are funded in this order after the steps above them in{" "}
            <Link to="/plan">Next best moves</Link>.
          </>
        }
        actions={
          <button type="button" onClick={() => setAdding(true)}>
            New goal
          </button>
        }
      />
      <div className="goals">
        {list.map((g) => (
          <GoalCard
            key={g.id}
            goal={g}
            all={list}
            canMove={{ up: custom.indexOf(g) > 0, down: custom.indexOf(g) >= 0 && custom.indexOf(g) < custom.length - 1 }}
            onMove={(d) => void move(g, d)}
            onChanged={() => void goals.reload()}
          />
        ))}
      </div>
      {adding && (
        <GoalForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void goals.reload();
          }}
        />
      )}
    </>
  );
}

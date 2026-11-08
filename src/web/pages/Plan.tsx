import { useState } from "react";
import type { PlanResponse, Recommendation } from "../../shared/api.ts";
import { STEP_TITLES } from "../../engine/plan/waterfall.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { monthTitle } from "../chartMath.ts";
import { ErrorNote, Field, Loading, MoneyInput, NumberInput, PageHeader } from "../components/ui.tsx";
import { formatFact } from "../facts.ts";
import { formatMoney } from "../format.ts";
import { Link } from "../router.tsx";

const STATUS_LABEL: Record<Recommendation["status"], string> = {
  act: "Do this",
  partial: "Partly funded",
  done: "Done",
  waiting: "Next in line",
  not_applicable: "Doesn't apply",
  disabled: "Off",
};

function Move({ rec, index }: { rec: Recommendation; index: number }) {
  return (
    <li className={`move ${rec.status}`}>
      <span className="move-num" aria-hidden>
        {index}
      </span>
      <div className="move-body">
        <div className="move-head">
          <span className="muted small">
            Step {rec.order} · {rec.title}
          </span>
          <span className={`chip-status ${rec.status}`}>{STATUS_LABEL[rec.status]}</span>
        </div>
        <p className="move-action">{rec.action}</p>
        <p className="muted small">{rec.why}</p>
        {rec.facts.length > 0 && (
          <details className="facts">
            <summary>The numbers behind it</summary>
            <dl>
              {rec.facts.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{formatFact(f)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
      <span className="move-amount">
        {formatMoney(rec.amount, { cents: false })}
        <span className="muted small">/mo</span>
      </span>
    </li>
  );
}

export function PlanPage() {
  const plan = useApi<PlanResponse>("/api/plan");
  const [error, setError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!plan.data) return plan.error ? <ErrorNote message={plan.error} /> : <Loading />;
  const p = plan.data;
  const { result, basis } = p;
  const moves = result.recommendations.filter((r) => r.status === "act" || r.status === "partial");
  const rest = result.recommendations.filter((r) => r.status !== "act" && r.status !== "partial");

  const save = async (patch: Record<string, unknown>) => {
    try {
      await api("PUT", "/api/plan/settings", patch);
      setError(undefined);
      notifyDataChanged();
      await plan.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Next best moves"
        subtitle="Where this month's spare money should go, in priority order. Each step takes what it needs and the rest flows to the next."
      />
      <ErrorNote message={error} />
      {p.warnings.map((w) => (
        <div className="note" key={w}>
          {w}
        </div>
      ))}

      {result.available === null ? (
        <div className="suggestion">
          <div>
            <strong>Set your expected monthly income first.</strong> The plan needs it to know how much is left after spending.
          </div>
          <Link to="/budget" className="button small">
            Go to Budget
          </Link>
        </div>
      ) : (
        <section className="panel available">
          <div>
            <span className="field-label">Available to put to work this month</span>
            <div className="hero">{formatMoney(result.available, { cents: false })}</div>
          </div>
          <details className="facts">
            <summary>{basis.override !== null ? "Set by hand" : "How this is worked out"}</summary>
            <dl>
              <div>
                <dt>Expected income</dt>
                <dd>{basis.expectedIncome === null ? "—" : formatMoney(basis.expectedIncome, { cents: false })}</dd>
              </div>
              <div>
                <dt>− Fixed bills</dt>
                <dd>{formatMoney(basis.fixed, { cents: false })}</dd>
              </div>
              <div>
                <dt>− Non-monthly set-aside</dt>
                <dd>{formatMoney(basis.nonMonthly, { cents: false })}</dd>
              </div>
              <div>
                <dt>
                  − Flex spending
                  {basis.averagedMonths.length > 0 && (
                    <span className="muted small"> (average of {basis.averagedMonths.map((m) => monthTitle(m).split(" ")[0]).join(", ")})</span>
                  )}
                </dt>
                <dd>{formatMoney(basis.flex, { cents: false })}</dd>
              </div>
              <div>
                <dt>= Available</dt>
                <dd>{basis.computed === null ? "—" : formatMoney(basis.computed, { cents: false })}</dd>
              </div>
            </dl>
            <p className="muted small">
              Fixed and non-monthly use your budgets where set, otherwise recent averages. Debt minimums are assumed to be in your
              Fixed bills or card payments.
            </p>
          </details>
        </section>
      )}

      {moves.length > 0 && (
        <section>
          <h2 className="section-title">This month</h2>
          <ol className="moves">
            {moves.map((r, i) => (
              <Move key={`${r.step}-${r.subject?.id ?? 0}`} rec={r} index={i + 1} />
            ))}
          </ol>
        </section>
      )}

      {p.alerts.length > 0 && (
        <section>
          <h2 className="section-title">Also worth a look</h2>
          {p.alerts.map((a) => (
            <div className="panel tight alert" key={a.title}>
              <strong>{a.title}</strong>
              <p className="small">{a.message}</p>
            </div>
          ))}
        </section>
      )}

      <section className="panel tight">
        <h2>The whole plan</h2>
        <ul className="plan-steps">
          {rest.map((r) => (
            <li key={`${r.step}-${r.subject?.id ?? 0}`} className={r.status}>
              <span className={`chip-status ${r.status}`}>{STATUS_LABEL[r.status]}</span>
              <span>
                <strong>{r.title}</strong> <span className="muted small">{r.action || r.why}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <PlanSettingsPanel key={JSON.stringify(p.settings)} plan={p} onSave={save} open={settingsOpen} onToggle={setSettingsOpen} />
    </>
  );
}

function PlanSettingsPanel({
  plan,
  onSave,
  open,
  onToggle,
}: {
  plan: PlanResponse;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const s = plan.settings;
  // Shown immediately; the panel remounts with the saved settings after each recalculation.
  const [steps, setSteps] = useState(s.steps);
  const saveSteps = (next: PlanResponse["settings"]["steps"]) => {
    setSteps(next);
    void onSave({ steps: next });
  };
  const [starter, setStarter] = useState<number | null>(s.starterAmount);
  const [apr, setApr] = useState<number | null>(s.highInterestApr);
  const [months, setMonths] = useState<number | null>(s.emergencyMonths);
  const [override, setOverride] = useState<number | null>(s.availableOverride);

  const move = (i: number, delta: -1 | 1) => {
    const next = [...steps];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item!);
    saveSteps(next);
  };

  return (
    <details className="panel tight" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>Plan settings</summary>
      <p className="muted small">Change the order, turn steps off, or adjust the thresholds. Every change recalculates the plan.</p>
      <ol className="step-order">
        {steps.map((step, i) => (
          <li key={step.id}>
            <label className="check">
              <input
                type="checkbox"
                checked={step.enabled}
                onChange={(e) => saveSteps(steps.map((x) => (x.id === step.id ? { ...x, enabled: e.target.checked } : x)))}
              />
              {i + 1}. {STEP_TITLES[step.id]}
            </label>
            <span>
              <button type="button" className="icon" aria-label={`Move ${STEP_TITLES[step.id]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                className="icon"
                aria-label={`Move ${STEP_TITLES[step.id]} down`}
                disabled={i === steps.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="form-grid">
        <Field label="Starter emergency fund">
          <span onBlur={() => starter !== null && starter !== s.starterAmount && void onSave({ starterAmount: starter })}>
            <MoneyInput value={starter} onChange={setStarter} ariaLabel="Starter emergency fund" />
          </span>
        </Field>
        <Field label="High-interest debt starts at">
          <span onBlur={() => apr !== null && apr !== s.highInterestApr && void onSave({ highInterestApr: apr })}>
            <NumberInput value={apr} onChange={setApr} min={0} max={100} step={0.5} suffix="% APR" ariaLabel="High-interest debt APR" />
          </span>
        </Field>
        <Field label="Emergency fund size" hint={`Blank = automatic (${plan.basis.emergencyMonths} months for your household)`}>
          <span onBlur={() => months !== s.emergencyMonths && void onSave({ emergencyMonths: months })}>
            <NumberInput value={months} onChange={setMonths} min={1} max={24} suffix="months of essentials" ariaLabel="Emergency fund months" />
          </span>
        </Field>
        <Field label="Amount to allocate each month" hint="Blank = work it out from your budget">
          <span onBlur={() => override !== s.availableOverride && void onSave({ availableOverride: override })}>
            <MoneyInput value={override} onChange={setOverride} placeholder="Automatic" ariaLabel="Amount to allocate each month" />
          </span>
        </Field>
      </div>
      <p className="muted small">
        Contribution limits: {plan.limits.year}
        {!plan.limits.exact && ` (${plan.limits.requestedYear} not published yet)`}. Source: {plan.limits.source}
      </p>
    </details>
  );
}

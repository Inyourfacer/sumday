import { useState } from "react";
import type { MoveImpactsResponse, PlanPreviewResponse, PlanResponse, Recommendation, RetirementResponse } from "../../shared/api.ts";
import { STEP_TEMPLATES, STEP_TITLES } from "../../engine/plan/waterfall.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { monthTitle } from "../chartMath.ts";
import { MoneyFlow, type FlowSegment } from "../components/MoneyFlow.tsx";
import { ErrorNote, Field, Loading, MoneyInput, NumberInput, PageHeader } from "../components/ui.tsx";
import { formatFact } from "../facts.ts";
import { formatDate, formatMoney } from "../format.ts";
import { Link } from "../router.tsx";

const STATUS_LABEL: Record<Recommendation["status"], string> = {
  act: "Do this",
  partial: "Partly funded",
  done: "Done",
  waiting: "Next in line",
  not_applicable: "Doesn't apply",
  disabled: "Off",
};

type MoveAction = "done" | "snooze" | "dismiss" | "restore";
type Impact = MoveImpactsResponse["impacts"][number];

/** Bills, everyday spending, each step that takes money, and what's left. */
function flowSegments(p: PlanResponse): FlowSegment[] {
  const { basis, result } = p;
  const out: FlowSegment[] = [
    { label: "Fixed bills", amount: basis.fixed, tone: "bills" },
    { label: "Non-monthly set-aside", amount: basis.nonMonthly, tone: "bills" },
    { label: "Everyday spending", amount: basis.flex, tone: "flex" },
  ];
  // Fold per-person and per-debt lines of one step into a single segment.
  const byStep = new Map<string, number>();
  for (const r of result.recommendations) if (r.amount > 0) byStep.set(r.step, (byStep.get(r.step) ?? 0) + r.amount);
  for (const [step, amount] of byStep) out.push({ label: STEP_TITLES[step as keyof typeof STEP_TITLES], amount, tone: "step" });
  if (basis.override === null) {
    const left = result.leftover;
    if (left > 0) out.push({ label: "Not allocated", amount: left, tone: "left" });
  }
  return out;
}

function Move({ rec, index, impact, onAct }: { rec: Recommendation; index: number; impact?: Impact; onAct: (key: string, action: MoveAction) => void }) {
  const away = rec.userState;
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
        {impact && impact.successPoints >= 0.1 && (
          <p className="small move-impact">
            Doing this adds about {impact.successPoints} points to the chance your money lasts
            {impact.medianAtEnd > 0 && <> and about {formatMoney(impact.medianAtEnd, { cents: false })} to the median portfolio at the end (today's dollars)</>}.
          </p>
        )}
        {rec.deadline && (
          <p className="muted small">
            {rec.deadline.label}: {formatDate(rec.deadline.date)}
          </p>
        )}
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
        <div className="move-actions">
          {away ? (
            <>
              <span className="muted small">
                {away.state === "done" ? "Marked done" : away.state === "snoozed" ? "Snoozed" : "Set aside"}
                {away.until ? ` until ${formatDate(away.until)}` : " until it changes"}
              </span>
              <button type="button" className="link small" onClick={() => onAct(rec.key, "restore")}>
                Bring it back
              </button>
            </>
          ) : (
            (rec.status === "act" || rec.status === "partial") && (
              <>
                <button type="button" className="link small" onClick={() => onAct(rec.key, "done")}>
                  I did this
                </button>
                <button type="button" className="link small" onClick={() => onAct(rec.key, "snooze")}>
                  Remind me in 2 weeks
                </button>
                <button type="button" className="link small" onClick={() => onAct(rec.key, "dismiss")}>
                  Not for me
                </button>
              </>
            )
          )}
        </div>
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
  const retirement = useApi<RetirementResponse>("/api/retirement");
  const impacts = useApi<MoveImpactsResponse>("/api/plan/impacts");
  const [showAway, setShowAway] = useState(false);
  const [error, setError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!plan.data) return plan.error ? <ErrorNote message={plan.error} /> : <Loading />;
  const p = plan.data;
  const { result, basis } = p;
  const actionable = result.recommendations.filter((r) => r.status === "act" || r.status === "partial");
  const moves = actionable.filter((r) => !r.userState);
  const setAside = actionable.filter((r) => r.userState);
  const impactOf = new Map((impacts.data?.impacts ?? []).map((i) => [i.key, i]));
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

  const actOn = async (key: string, action: MoveAction) => {
    try {
      await api("POST", "/api/plan/moves", { key, action });
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
            {basis.range && (
              <p className="muted small">
                Usually between {formatMoney(Math.max(0, basis.range.low), { cents: false })} and {formatMoney(Math.max(0, basis.range.high), { cents: false })} a month
                (the typical swing in Flex spending over {basis.range.months} months). Commit automatic transfers at the low end and sweep the rest when it shows up.
              </p>
            )}
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
              {basis.range && (
                <div>
                  <dt>Usual range ({basis.range.months} months of Flex spending)</dt>
                  <dd>
                    {formatMoney(basis.range.low, { cents: false })} to {formatMoney(basis.range.high, { cents: false })}
                  </dd>
                </div>
              )}
            </dl>
            <p className="muted small">
              Fixed and non-monthly use your budgets where set, otherwise recent averages. Debt minimums are assumed to be in your
              Fixed bills or card payments.
            </p>
          </details>
        </section>
      )}

      {result.available !== null && basis.expectedIncome !== null && (
        <section className="panel tight">
          <h2>Where this month's income goes</h2>
          <MoneyFlow income={basis.expectedIncome} segments={flowSegments(p)} />
        </section>
      )}

      {moves.length > 0 && (
        <section>
          <h2 className="section-title">This month</h2>
          <ol className="moves">
            {moves.map((r, i) => (
              <Move key={r.key} rec={r} index={i + 1} impact={impactOf.get(r.key)} onAct={(k, a) => void actOn(k, a)} />
            ))}
          </ol>
        </section>
      )}
      {moves.length === 0 && setAside.length > 0 && <p className="muted">Everything left is set aside for now.</p>}
      {setAside.length > 0 && (
        <section>
          <button type="button" className="link small" onClick={() => setShowAway(!showAway)}>
            {showAway ? "Hide" : "Show"} {setAside.length} set aside
          </button>
          {showAway && (
            <ol className="moves">
              {setAside.map((r, i) => (
                <Move key={r.key} rec={r} index={i + 1} impact={impactOf.get(r.key)} onAct={(k, a) => void actOn(k, a)} />
              ))}
            </ol>
          )}
        </section>
      )}

      {(p.alerts.length > 0 || (retirement.data?.result && retirement.data.result.successRate < retirement.data.settings.successTarget)) && (
        <section>
          <h2 className="section-title">Also worth a look</h2>
          {retirement.data?.result && retirement.data.whatIfs && retirement.data.result.successRate < retirement.data.settings.successTarget && (
            <div className="panel tight alert">
              <strong>Retirement: {Math.round(retirement.data.result.successRate * 100)}% chance, below your {Math.round(retirement.data.settings.successTarget * 100)}% target</strong>
              <p className="small">
                {[
                  retirement.data.whatIfs.toReachTarget.extraMonthlySavings !== null &&
                    `save ${formatMoney(retirement.data.whatIfs.toReachTarget.extraMonthlySavings, { cents: false })}/mo more`,
                  retirement.data.whatIfs.toReachTarget.retireLaterYears !== null && `retire ${retirement.data.whatIfs.toReachTarget.retireLaterYears} year(s) later`,
                  retirement.data.whatIfs.toReachTarget.spendLessPerYear !== null &&
                    `spend ${formatMoney(retirement.data.whatIfs.toReachTarget.spendLessPerYear, { cents: false })}/yr less in retirement`,
                ]
                  .filter(Boolean)
                  .join(", or ")
                  .replace(/^./, (c) => c.toUpperCase())}
                . <Link to="/retirement">See the projection →</Link>
              </p>
            </div>
          )}
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

/** The two tax rates behind the Roth-or-pre-tax advice, and which way they point. */
function TaxViewNote({ view }: { view: PlanResponse["taxView"] }) {
  if (view.nowPct === null) return null;
  const verdict =
    view.lean === "traditional"
      ? "Pre-tax (traditional) money is favored: the deduction is worth more now than later."
      : view.lean === "roth"
        ? "Roth money is favored: tax now is cheaper than tax later."
        : view.lean === "either"
          ? "The two rates are close, so either works; a mix gives you more control later."
          : null;
  return (
    <div className="note">
      <strong>Roth or pre-tax?</strong> Your next dollar is taxed at about {view.nowPct}% now ({view.nowBasis === "you" ? "the rate you entered" : "estimated from your income"}).
      {view.retirementPct !== null && view.retirementRange ? (
        <>
          {" "}
          In retirement an extra pre-tax dollar is expected to be taxed at about {view.retirementPct}% (middle half of simulated futures: {view.retirementRange[0]}% to {view.retirementRange[1]}%).{" "}
          {verdict}
        </>
      ) : (
        <> The retirement side needs your household setup and a bracket tax model on the Retirement page.</>
      )}
    </div>
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
    setPending(undefined);
    void onSave({ steps: next });
  };
  // Changing the order or turning a step on or off is previewed first: what each move becomes, before anything is saved.
  const [pending, setPending] = useState<PlanPreviewResponse["changes"]>();
  const [dragFrom, setDragFrom] = useState<number>();
  const propose = async (next: PlanResponse["settings"]["steps"]) => {
    setSteps(next);
    try {
      const res = await api<PlanPreviewResponse>("POST", "/api/plan/preview", { steps: next });
      setPending(res.changes);
      setPreviewError(undefined);
    } catch (err) {
      setPreviewError(errorMessage(err));
    }
  };
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = [...steps];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    void propose(next);
  };
  const [starter, setStarter] = useState<number | null>(s.starterAmount);
  const [apr, setApr] = useState<number | null>(s.highInterestApr);
  const [months, setMonths] = useState<number | null>(s.emergencyMonths);
  const [override, setOverride] = useState<number | null>(s.availableOverride);
  const [taxPct, setTaxPct] = useState<number | null>(s.marginalTaxPct);

  // Previewing a template shows what changes before anything is saved.
  const [preview, setPreview] = useState<{ template: keyof typeof STEP_TEMPLATES; changes: PlanPreviewResponse["changes"] }>();
  const [previewError, setPreviewError] = useState<string>();
  const currentTemplate = (Object.keys(STEP_TEMPLATES) as (keyof typeof STEP_TEMPLATES)[]).find(
    (k) => JSON.stringify(STEP_TEMPLATES[k].steps) === JSON.stringify(steps),
  );
  const showPreview = async (template: keyof typeof STEP_TEMPLATES) => {
    try {
      const res = await api<PlanPreviewResponse>("POST", "/api/plan/preview", { steps: STEP_TEMPLATES[template].steps });
      setPreview({ template, changes: res.changes });
      setPreviewError(undefined);
    } catch (err) {
      setPreviewError(errorMessage(err));
    }
  };

  const move = (i: number, delta: -1 | 1) => {
    reorder(i, i + delta);
  };

  return (
    <details className="panel tight" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>Plan settings</summary>
      <p className="muted small">Change the order, turn steps off, or adjust the thresholds. Every change recalculates the plan.</p>
      <div className="templates">
        <span className="field-label">Start from a template</span>
        <ul>
          {(Object.keys(STEP_TEMPLATES) as (keyof typeof STEP_TEMPLATES)[]).map((k) => (
            <li key={k}>
              <strong>{STEP_TEMPLATES[k].label}</strong>
              {currentTemplate === k && <span className="chip-status done"> In use</span>}
              <span className="muted small"> {STEP_TEMPLATES[k].summary}</span>{" "}
              {currentTemplate !== k && (
                <button type="button" className="link small" onClick={() => void showPreview(k)}>
                  See what changes
                </button>
              )}
            </li>
          ))}
        </ul>
        <ErrorNote message={previewError} />
        {preview && (
          <div className="panel tight">
            <strong>{STEP_TEMPLATES[preview.template].label}: what changes this month</strong>
            {preview.changes.length === 0 ? (
              <p className="muted small">Nothing changes this month with your current numbers.</p>
            ) : (
              <ul className="mini-list">
                {preview.changes.map((c) => (
                  <li key={c.key}>
                    <span>
                      {c.title} <span className="muted small">· {STEP_TITLES[c.step]}</span>
                    </span>
                    <span>
                      {formatMoney(c.before, { cents: false })} → {formatMoney(c.after, { cents: false })}/mo
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => {
                saveSteps(STEP_TEMPLATES[preview.template].steps);
                setPreview(undefined);
              }}
            >
              Use this order
            </button>{" "}
            <button type="button" className="link" onClick={() => setPreview(undefined)}>
              Cancel
            </button>
          </div>
        )}
      </div>
      <ol className="step-order">
        {steps.map((step, i) => (
          <li
            key={step.id}
            className={dragFrom === i ? "dragging" : undefined}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragEnd={() => setDragFrom(undefined)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== undefined) reorder(dragFrom, i);
              setDragFrom(undefined);
            }}
          >
            <span className="drag-handle" aria-hidden title="Drag to reorder">
              ⋮⋮
            </span>
            <label className="check">
              <input
                type="checkbox"
                checked={step.enabled}
                onChange={(e) => void propose(steps.map((x) => (x.id === step.id ? { ...x, enabled: e.target.checked } : x)))}
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
      {pending && (
        <div className="panel tight" role="status">
          <strong>With this order, this month</strong>
          {pending.length === 0 ? (
            <p className="muted small">Nothing changes with your current numbers.</p>
          ) : (
            <ul className="mini-list">
              {pending.map((c) => (
                <li key={c.key}>
                  <span>
                    {c.title} <span className="muted small">· {STEP_TITLES[c.step]}</span>
                  </span>
                  <span>
                    {formatMoney(c.before, { cents: false })} → {formatMoney(c.after, { cents: false })}/mo
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => saveSteps(steps)}>
            Use this order
          </button>{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setSteps(s.steps);
              setPending(undefined);
            }}
          >
            Undo
          </button>
        </div>
      )}
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
        <Field
          label="Your marginal tax rate"
          hint={
            plan.taxView.nowBasis === "income" && plan.taxView.nowPct !== null
              ? `Optional. Blank = estimated from your income (${plan.taxView.nowPct}% now). Used for pre-tax take-home cost and the Roth or pre-tax advice.`
              : "Optional. Used for pre-tax take-home cost and the Roth or pre-tax advice. Blank = estimated from your income once it is entered."
          }
        >
          <span onBlur={() => taxPct !== s.marginalTaxPct && void onSave({ marginalTaxPct: taxPct })}>
            <NumberInput value={taxPct} onChange={setTaxPct} min={0} max={60} step={1} suffix="%" ariaLabel="Marginal tax rate" />
          </span>
        </Field>
      </div>
      <TaxViewNote view={plan.taxView} />
      <p className="muted small">
        Contribution limits: {plan.limits.year}
        {!plan.limits.exact && ` (${plan.limits.requestedYear} not published yet)`}. Source: {plan.limits.source}
      </p>
    </details>
  );
}

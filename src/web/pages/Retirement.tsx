import { useState } from "react";
import type { RetirementResponse } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { compactMoney, pct } from "../chartMath.ts";
import { FanChart } from "../components/charts.tsx";
import { Empty, ErrorNote, Field, Loading, MoneyInput, NumberInput, PageHeader } from "../components/ui.tsx";
import { formatMoney } from "../format.ts";
import { Link } from "../router.tsx";

type Inputs = NonNullable<RetirementResponse["inputs"]>;
type Spending = Pick<Inputs["spending"], "items" | "oneOffs"> & { overrides: Record<string, number | null> };

const money = (c: number) => formatMoney(c, { cents: false });

function SpendingEditor({ inputs, onSaved }: { inputs: Inputs; onSaved: () => void }) {
  const s = inputs.spending;
  const [draft, setDraft] = useState<Spending>({
    overrides: Object.fromEntries(s.categories.map((c) => [String(c.categoryId), c.retirement])),
    items: s.items,
    oneOffs: s.oneOffs,
  });
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const total = s.categories.reduce((sum, c) => sum + (draft.overrides[String(c.categoryId)] ?? c.current), 0);

  const save = async () => {
    try {
      await api("PUT", "/api/retirement/settings", {
        spending: {
          categoryOverrides: Object.fromEntries(Object.entries(draft.overrides).filter(([, v]) => v !== null)),
          items: draft.items,
          oneOffs: draft.oneOffs,
        },
      });
      setError(undefined);
      setSaved(true);
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const primary = inputs.people[0]!.name;

  return (
    <details className="panel tight">
      <summary>Retirement spending: {money(s.firstYear)} a year when you retire{s.oneOffs.length > 0 ? ", plus one-off costs" : ""}</summary>
      <p className="muted small">
        Starts from what you spend now (budgets where set, otherwise recent averages). Change any category for retirement; blank means
        the same as today. All amounts are per year in today's dollars.
      </p>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Today</th>
              <th className="num">In retirement</th>
            </tr>
          </thead>
          <tbody>
            {s.categories.map((c) => (
              <tr key={c.categoryId}>
                <td>{c.name}</td>
                <td className="num muted">{money(c.current)}</td>
                <td className="num">
                  <span className="budget-input">
                    <MoneyInput
                      value={draft.overrides[String(c.categoryId)] ?? null}
                      placeholder={money(c.current).replace("$", "")}
                      ariaLabel={`${c.name} in retirement`}
                      onChange={(v) => setDraft({ ...draft, overrides: { ...draft.overrides, [String(c.categoryId)]: v } })}
                    />
                  </span>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td className="num muted">{money(s.categories.reduce((sum, c) => sum + c.current, 0))}</td>
              <td className="num">
                <strong>{money(total)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h4>Changes over time</h4>
      <p className="muted small">By {primary}'s age. Use a negative amount for a cut, e.g. a mortgage that ends.</p>
      {draft.items.map((item, i) => (
        <div className="inline-form item-row" key={i}>
          <Field label="What">
            <input value={item.label} onChange={(e) => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
          </Field>
          <Field label="Per year">
            <MoneyInput
              allowNegative
              value={item.amount}
              ariaLabel={`${item.label || "Change"} per year`}
              onChange={(v) => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? { ...x, amount: v ?? 0 } : x)) })}
            />
          </Field>
          <Field label="From age">
            <NumberInput value={item.fromAge} min={18} max={120} ariaLabel="From age" onChange={(v) => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? { ...x, fromAge: v } : x)) })} />
          </Field>
          <Field label="To age">
            <NumberInput value={item.toAge} min={18} max={120} ariaLabel="To age" onChange={(v) => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? { ...x, toAge: v } : x)) })} />
          </Field>
          <button type="button" className="link danger small" onClick={() => setDraft({ ...draft, items: draft.items.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        <button
          type="button"
          className="secondary small"
          onClick={() => setDraft({ ...draft, items: [...draft.items, { label: "", amount: 0, fromAge: null, toAge: null }] })}
        >
          Add a change
        </button>
        <button
          type="button"
          className="secondary small"
          onClick={() =>
            setDraft({
              ...draft,
              items: [...draft.items, { label: "Health insurance before Medicare", amount: 1_200_000, fromAge: null, toAge: 64 }],
            })
          }
        >
          + Pre-Medicare health insurance
        </button>
      </div>

      <h4>One-off costs</h4>
      {draft.oneOffs.map((o, i) => (
        <div className="inline-form item-row" key={i}>
          <Field label="What">
            <input value={o.label} onChange={(e) => setDraft({ ...draft, oneOffs: draft.oneOffs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
          </Field>
          <Field label="Amount">
            <MoneyInput value={o.amount} ariaLabel={`${o.label || "One-off"} amount`} onChange={(v) => setDraft({ ...draft, oneOffs: draft.oneOffs.map((x, j) => (j === i ? { ...x, amount: v ?? 0 } : x)) })} />
          </Field>
          <Field label="At age">
            <NumberInput value={o.age} min={18} max={120} ariaLabel="At age" onChange={(v) => setDraft({ ...draft, oneOffs: draft.oneOffs.map((x, j) => (j === i ? { ...x, age: v ?? 65 } : x)) })} />
          </Field>
          <Field label="Every (years)">
            <NumberInput value={o.everyYears} min={1} max={40} ariaLabel="Repeat every years" onChange={(v) => setDraft({ ...draft, oneOffs: draft.oneOffs.map((x, j) => (j === i ? { ...x, everyYears: v } : x)) })} />
          </Field>
          <button type="button" className="link danger small" onClick={() => setDraft({ ...draft, oneOffs: draft.oneOffs.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary small"
        onClick={() => setDraft({ ...draft, oneOffs: [...draft.oneOffs, { label: "", amount: 0, age: inputs.people[0]!.retirementAge, everyYears: null }] })}
      >
        Add a one-off cost
      </button>
      <ErrorNote message={error} />
      <div className="row end">
        {saved && <span className="ok-text small">Saved and recalculated.</span>}
        <button type="button" onClick={() => void save()}>
          Save spending plan
        </button>
      </div>
    </details>
  );
}

function Assumptions({ data, onSaved }: { data: RetirementResponse; onSaved: () => void }) {
  const s = data.settings;
  const [target, setTarget] = useState<number | null>(Math.round(s.successTarget * 100));
  const [ord, setOrd] = useState<number | null>(s.ordinaryTaxPct);
  const [cg, setCg] = useState<number | null>(s.capitalGainsPct);
  const [error, setError] = useState<string>();
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api("PUT", "/api/retirement/settings", patch);
      setError(undefined);
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <details className="panel tight">
      <summary>Assumptions and data</summary>
      <div className="form-grid">
        <Field label="Aim for a chance of success of">
          <span onBlur={() => target !== null && target / 100 !== s.successTarget && void save({ successTarget: target / 100 })}>
            <NumberInput value={target} min={50} max={99} suffix="%" ariaLabel="Success target" onChange={setTarget} />
          </span>
        </Field>
        <Field label="Tax on pre-tax withdrawals" hint="Your expected average rate in retirement">
          <span onBlur={() => ord !== null && ord !== s.ordinaryTaxPct && void save({ ordinaryTaxPct: ord })}>
            <NumberInput value={ord} min={0} max={60} suffix="%" ariaLabel="Tax on pre-tax withdrawals" onChange={setOrd} />
          </span>
        </Field>
        <Field label="Tax on investment gains">
          <span onBlur={() => cg !== null && cg !== s.capitalGainsPct && void save({ capitalGainsPct: cg })}>
            <NumberInput value={cg} min={0} max={40} suffix="%" ariaLabel="Tax on investment gains" onChange={setCg} />
          </span>
        </Field>
        <label className="check wide">
          <input type="checkbox" checked={s.includePlanSavings} onChange={(e) => void save({ includePlanSavings: e.target.checked })} />
          Include the savings Next best moves recommends ({money((data.inputs?.extraSavings.total ?? 0) / 12)}/mo now)
        </label>
      </div>
      <ErrorNote message={error} />
      <ul className="small muted assumptions">
        <li>
          {s.runs.toLocaleString("en-US")} simulated futures, each replaying history in random {s.blockLength}-year blocks: stock, bond and cash
          returns and inflation come from the same real year, so crashes and inflation spikes keep their real company.
        </li>
        <li>Everything is in today's dollars. Social Security keeps up with inflation; pensions without a COLA don't.</li>
        <li>
          Your portfolio is rebalanced to your target mix each year ({pct(data.inputs?.allocation.stocks ?? 0)} stocks), less fund fees of{" "}
          {(data.inputs?.feePct ?? 0).toFixed(3)}%. Withdrawals: required minimums, then taxable, pre-tax, Roth, HSA.
        </li>
        <li>
          Spending starts when everyone with a paycheck has retired; until then, pay covers spending and contributions continue. Cash
          accounts (your emergency fund) aren't counted.
        </li>
        <li>
          Market data: {data.sources.returns} ({data.sources.returnsYears}). Required minimums: {data.sources.rmd}
        </li>
        <li>Not included yet: tax brackets, Roth conversions, Medicare surcharges, spousal Social Security benefits.</li>
      </ul>
    </details>
  );
}

export function RetirementPage() {
  const data = useApi<RetirementResponse>("/api/retirement");
  if (!data.data) return data.error ? <ErrorNote message={data.error} /> : <Loading />;
  const d = data.data;
  const reload = () => void data.reload();

  if (!d.ready || !d.result || !d.inputs || !d.whatIfs) {
    return (
      <>
        <PageHeader title="Retirement" />
        <Empty>
          <p>A few details are needed first:</p>
          <ul>
            {d.missing.map((m) => (
              <li key={m}>
                <Link to="/settings/household">{m}</Link>
              </li>
            ))}
          </ul>
        </Empty>
      </>
    );
  }

  const r = d.result;
  const i = d.inputs;
  const w = d.whatIfs;
  const primary = i.people[0]!;
  const target = d.settings.successTarget;
  const onTrack = r.successRate >= target;
  const ageOf = (year: number) => year - primary.birthYear;
  const fan = r.bands.map((b) => ({ ...b, label: String(ageOf(b.year)) }));
  const change = w.toReachTarget;

  return (
    <>
      <PageHeader
        title="Retirement"
        subtitle={`${i.people.map((p) => `${p.name} retires at ${p.retirementAge}`).join(", ")} · planning to age ${ageOf(i.endYear)} for ${primary.name}`}
      />

      <section className="panel retire-hero">
        <div>
          <span className="field-label">Chance your money lasts</span>
          <div className={`hero ${onTrack ? "" : "over"}`}>{pct(r.successRate)}</div>
          <p className="small">
            {onTrack ? <span className="status ok">On track</span> : <span className="status over">Below your {pct(target)} target</span>}{" "}
            <span className="muted">
              {Math.round(r.successRate * r.runs).toLocaleString("en-US")} of {r.runs.toLocaleString("en-US")} simulated futures last to{" "}
              {i.endYear}.
            </span>
          </p>
          <span className="mix-bar hero-bar" role="img" aria-label={`${pct(r.successRate)} chance of success; target ${pct(target)}`}>
            <span className="mix-fill" style={{ width: `${r.successRate * 100}%` }} />
            <span className="mix-target" style={{ left: `${target * 100}%` }} />
          </span>
        </div>
        <dl className="hero-facts">
          <div>
            <dt>Portfolio when you retire ({r.retireYear})</dt>
            <dd>{money(r.medianAtRetirement)} median</dd>
          </div>
          <div>
            <dt>Spending you can afford at {pct(target)}</dt>
            <dd>
              {w.sustainableSpending === null ? "—" : `${money(w.sustainableSpending)}/yr`}{" "}
              <span className="muted small">vs {money(i.spending.firstYear)} planned</span>
            </dd>
          </div>
          <div>
            <dt>In the runs that fall short</dt>
            <dd>{r.medianDepletionYear === null ? "None do" : `money runs out around age ${ageOf(r.medianDepletionYear)} (median)`}</dd>
          </div>
        </dl>
      </section>

      {!onTrack && (change.extraMonthlySavings !== null || change.retireLaterYears !== null || change.spendLessPerYear !== null) && (
        <section className="panel">
          <h2>Smallest changes that reach {pct(target)}</h2>
          <p className="muted small">Any one of these, on its own:</p>
          <ul className="lines">
            {change.extraMonthlySavings !== null && (
              <li>
                <span>Save more each month until you retire</span>
                <strong>+{money(change.extraMonthlySavings)}/mo</strong>
              </li>
            )}
            {change.retireLaterYears !== null && (
              <li>
                <span>Retire later</span>
                <strong>
                  {change.retireLaterYears} year{change.retireLaterYears === 1 ? "" : "s"} (at {primary.retirementAge + change.retireLaterYears})
                </strong>
              </li>
            )}
            {change.spendLessPerYear !== null && (
              <li>
                <span>Spend less in retirement</span>
                <strong>−{money(change.spendLessPerYear)}/yr</strong>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Your portfolio over time</h2>
        <p className="muted small">In today's dollars. Half of the simulated futures end above the median line.</p>
        <FanChart
          points={fan}
          markerYear={r.retireYear}
          axisLabel={`${primary.name}'s age`}
          label={`Projected portfolio in today's dollars, ${i.startYear} to ${i.endYear}`}
        />
        <details className="table-toggle">
          <summary>Show as table</summary>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>{primary.name}'s age</th>
                  <th className="num">Low (10th)</th>
                  <th className="num">Median</th>
                  <th className="num">High (90th)</th>
                </tr>
              </thead>
              <tbody>
                {r.bands
                  .filter((b, k) => k % 5 === 0 || b.year === r.retireYear || k === r.bands.length - 1)
                  .map((b) => (
                    <tr key={b.year}>
                      <td>{b.year}</td>
                      <td>{ageOf(b.year)}</td>
                      <td className="num">{money(b.p10)}</td>
                      <td className="num">{money(b.p50)}</td>
                      <td className="num">{money(b.p90)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="panel tight">
        <h2>Can I retire at…?</h2>
        <ul className="retire-at">
          {w.retireAt.map((x) => (
            <li key={x.shift} className={x.shift === 0 ? "current" : ""}>
              <span className="ra-age">
                {primary.retirementAge + x.shift}
                {x.shift === 0 && <span className="muted small"> (your plan)</span>}
              </span>
              <span className="mix-bar" role="img" aria-label={`Retire at ${primary.retirementAge + x.shift}: ${pct(x.successRate)}`}>
                <span className="mix-fill" style={{ width: `${x.successRate * 100}%` }} />
                <span className="mix-target" style={{ left: `${target * 100}%` }} />
              </span>
              <strong className="ra-pct">{pct(x.successRate)}</strong>
            </li>
          ))}
        </ul>
        <p className="muted small">The tick marks your {pct(target)} target. Retiring later means more years of saving and fewer of spending.</p>
      </section>

      <section className="panel tight">
        <h2>What goes in</h2>
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Invested today</span>
            <span className="tile-value">{compactMoney(i.balances.total)}</span>
            <span className="muted small">
              {compactMoney(i.balances.traditional)} pre-tax · {compactMoney(i.balances.roth)} Roth · {compactMoney(i.balances.taxable)} taxable
              {i.balances.hsa > 0 && ` · ${compactMoney(i.balances.hsa)} HSA`}
            </span>
          </div>
          {i.people.map((p) => (
            <div className="tile" key={p.id}>
              <span className="tile-label">{p.name}</span>
              <span className="small">
                Retires at {p.retirementAge}. Social Security {p.socialSecurityMonthly === null ? "not entered" : `${money(p.socialSecurityMonthly)}/mo from ${p.claimAge}`}.
                {p.pension && ` Pension ${money(p.pension.monthly)}/mo from ${p.pension.startAge}.`} Required withdrawals from {p.rmdStartAge}.
              </span>
            </div>
          ))}
        </div>
        <p className="muted small">
          Change ages, income and Social Security in <Link to="/settings/household">Settings → Household</Link>; the mix on{" "}
          <Link to="/investments">Investments</Link>.
        </p>
      </section>

      <SpendingEditor key={JSON.stringify(i.spending)} inputs={i} onSaved={reload} />
      <Assumptions key={JSON.stringify(d.settings)} data={d} onSaved={reload} />
    </>
  );
}

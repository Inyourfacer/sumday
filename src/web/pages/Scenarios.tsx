import { useState } from "react";
import { describeOverride } from "../../engine/retire/overrides.ts";
import type { HouseholdResponse, ScenarioComparison, ScenarioView } from "../../shared/api.ts";
import type { OverrideInput } from "../../shared/schemas.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { MultiLineChart } from "../components/charts.tsx";
import { Empty, ErrorNote, Field, Loading, Modal, MoneyInput, NumberInput, PageHeader } from "../components/ui.tsx";
import { formatMoney } from "../format.ts";
import { Link } from "../router.tsx";

type Kind = OverrideInput["type"];
const KINDS: { type: Kind; label: string }[] = [
  { type: "retirement_age", label: "Retire at a different age" },
  { type: "income", label: "Change someone's pay" },
  { type: "extra_savings", label: "Save more (or less) each month" },
  { type: "retirement_spending", label: "Spend more or less in retirement" },
  { type: "lump_sum", label: "A one-time amount (inheritance, wedding)" },
  { type: "home_purchase", label: "Buy a home" },
  { type: "allocation", label: "A different asset mix" },
];

const money = (c: number) => formatMoney(c, { cents: false });

function ChangeEditor({ people, onAdd }: { people: HouseholdResponse["people"]; onAdd: (o: OverrideInput) => void }) {
  const [year] = useState(() => new Date().getFullYear());
  const [type, setType] = useState<Kind>("retirement_age");
  const [personId, setPersonId] = useState<number>(people[0]?.id ?? 0);
  const [num, setNum] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [amount2, setAmount2] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [direction, setDirection] = useState<"in" | "out" | "more" | "less">("in");
  const [mix, setMix] = useState({ stocks: 60, bonds: 40, cash: 0 });
  const [problem, setProblem] = useState<string>();

  const reset = (t: Kind) => {
    setType(t);
    setNum(null);
    setAmount(null);
    setAmount2(null);
    setLabel("");
    setDirection(t === "lump_sum" ? "in" : "more");
    setProblem(undefined);
  };

  const build = (): OverrideInput | string => {
    const sign = direction === "out" || direction === "less" ? -1 : 1;
    switch (type) {
      case "retirement_age":
        return num === null || num < 30 || num > 85 ? "Enter an age from 30 to 85." : { type, personId, age: num };
      case "income":
        return amount === null ? "Enter the yearly pay (0 if they stop working)." : { type, personId, income: amount, pretaxPct: num };
      case "extra_savings":
        return amount === null ? "Enter a monthly amount." : { type, monthly: sign * amount };
      case "retirement_spending":
        return amount === null ? "Enter a yearly amount." : { type, annualChange: sign * amount };
      case "lump_sum":
        if (!label.trim()) return "Name it.";
        if (!amount) return "Enter an amount.";
        return num === null ? "Enter the year." : { type, label: label.trim(), year: num, amount: sign * amount };
      case "home_purchase":
        return num === null ? "Enter the year." : { type, year: num, downPayment: amount ?? 0, monthlyCostChange: sign * (amount2 ?? 0) };
      case "allocation": {
        const total = mix.stocks + mix.bonds + mix.cash;
        return total !== 100 ? `The mix adds up to ${total}%, not 100%.` : { type, stocks: mix.stocks / 100, bonds: mix.bonds / 100, cash: mix.cash / 100 };
      }
    }
  };
  const add = () => {
    const o = build();
    if (typeof o === "string") return setProblem(o);
    onAdd(o);
    reset(type);
  };

  const who = (
    <Field label="Who">
      <select value={personId} onChange={(e) => setPersonId(Number(e.target.value))}>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
  const moreLess = (more: string, less: string) => (
    <Field label="Direction">
      <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
        <option value="more">{more}</option>
        <option value="less">{less}</option>
      </select>
    </Field>
  );

  return (
    <div className="change-editor">
      <Field label="Add a change" wide>
        <select value={type} onChange={(e) => reset(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k.type} value={k.type}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-grid">
        {type === "retirement_age" && (
          <>
            {who}
            <Field label="Retirement age">
              <NumberInput value={num} onChange={setNum} min={30} max={85} ariaLabel="Retirement age" />
            </Field>
          </>
        )}
        {type === "income" && (
          <>
            {who}
            <Field label="Yearly pay" hint="Today's dollars. 0 means they stop working.">
              <MoneyInput value={amount} onChange={setAmount} ariaLabel="Yearly pay" />
            </Field>
            <Field label="Saved at work (pre-tax)" hint="Optional">
              <NumberInput value={num} onChange={setNum} min={0} max={100} suffix="%" ariaLabel="Pre-tax savings percent" />
            </Field>
          </>
        )}
        {type === "extra_savings" && (
          <>
            {moreLess("Save more", "Save less")}
            <Field label="Per month">
              <MoneyInput value={amount} onChange={setAmount} ariaLabel="Monthly amount" />
            </Field>
          </>
        )}
        {type === "retirement_spending" && (
          <>
            {moreLess("Spend more", "Spend less")}
            <Field label="Per year">
              <MoneyInput value={amount} onChange={setAmount} ariaLabel="Yearly amount" />
            </Field>
          </>
        )}
        {type === "lump_sum" && (
          <>
            <Field label="What">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Inheritance" />
            </Field>
            <Field label="Direction">
              <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
                <option value="in">Money in</option>
                <option value="out">Money out</option>
              </select>
            </Field>
            <Field label="Amount">
              <MoneyInput value={amount} onChange={setAmount} ariaLabel="Amount" />
            </Field>
            <Field label="Year">
              <NumberInput value={num} onChange={setNum} min={year} max={year + 80} ariaLabel="Year" />
            </Field>
          </>
        )}
        {type === "home_purchase" && (
          <>
            <Field label="Year">
              <NumberInput value={num} onChange={setNum} min={year} max={year + 80} ariaLabel="Year" />
            </Field>
            <Field label="Down payment and costs">
              <MoneyInput value={amount} onChange={setAmount} ariaLabel="Down payment" />
            </Field>
            {moreLess("Housing costs more", "Housing costs less")}
            <Field label="By, per month" hint="Mortgage, tax and insurance vs your rent now">
              <MoneyInput value={amount2} onChange={setAmount2} ariaLabel="Monthly housing change" />
            </Field>
          </>
        )}
        {type === "allocation" &&
          (["stocks", "bonds", "cash"] as const).map((k) => (
            <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}>
              <NumberInput value={mix[k]} onChange={(v) => setMix({ ...mix, [k]: v ?? 0 })} min={0} max={100} suffix="%" ariaLabel={`${k} percent`} />
            </Field>
          ))}
      </div>
      <ErrorNote message={problem} />
      <button type="button" className="secondary" onClick={add}>
        Add change
      </button>
    </div>
  );
}

function ScenarioForm({ scenario, people, onClose, onSaved }: { scenario?: ScenarioView; people: HouseholdResponse["people"]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(scenario?.name ?? "");
  const [overrides, setOverrides] = useState<OverrideInput[]>(scenario?.overrides ?? []);
  const [error, setError] = useState<string>();
  const names = new Map(people.map((p) => [p.id, p.name]));

  const save = async () => {
    try {
      if (scenario) await api("PATCH", `/api/scenarios/${scenario.id}`, { name, overrides });
      else await api("POST", "/api/scenarios", { name, overrides });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      wide
      title={scenario ? `Edit ${scenario.name}` : "New scenario"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={overrides.length === 0}>
            Save scenario
          </button>
        </>
      }
    >
      <Field label="Name" wide>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Retire at 60 and downsize" />
      </Field>
      <h3>Changes</h3>
      {overrides.length === 0 ? (
        <p className="muted">Add one or more changes below. Everything else stays as in your plan today.</p>
      ) : (
        <ul className="change-list">
          {overrides.map((o, i) => (
            <li key={`${o.type}-${i}`}>
              <span>{describeOverride(o, names)}</span>
              <button type="button" className="link" onClick={() => setOverrides(overrides.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <ChangeEditor people={people} onAdd={(o) => setOverrides([...overrides, o])} />
      <ErrorNote message={error} />
    </Modal>
  );
}

function Comparison({ ids }: { ids: number[] }) {
  const c = useApi<ScenarioComparison>(ids.length ? `/api/scenarios/compare?ids=${ids.join(",")}` : "/api/scenarios/compare");
  const [table, setTable] = useState(false);
  if (!c.data) return c.error ? <ErrorNote message={c.error} /> : <Loading />;
  const d = c.data;
  if (!d.ready) {
    return (
      <div className="note">
        <p>Retirement projections need a few details first:</p>
        <ul>
          {d.missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    );
  }
  const years = [...new Set(d.rows.flatMap((r) => r.median.map((m) => m.year)))].sort((a, b) => a - b);
  const best = Math.max(...d.rows.map((r) => r.successRate));
  const metrics: { label: string; value: (r: ScenarioComparison["rows"][number]) => string; hint?: string }[] = [
    { label: "Chance money lasts", value: (r) => `${Math.round(r.successRate * 100)}%` },
    { label: "Retirement starts", value: (r) => String(r.retireYear) },
    { label: "Spending in retirement", value: (r) => `${money(r.ongoingSpending)}/yr` },
    { label: `Affordable at ${Math.round(d.target * 100)}%`, value: (r) => `${money(r.affordableSpending)}/yr`, hint: "The yearly spending that keeps the chance at your target" },
    { label: "Saving beyond today", value: (r) => (r.extraSavingsMonthly ? `${money(r.extraSavingsMonthly)}/mo` : "–") },
    { label: "Median at retirement", value: (r) => money(r.medianAtRetirement) },
    { label: "Median at the end", value: (r) => money(r.medianAtEnd) },
    { label: "Median runs out", value: (r) => (r.medianDepletionYear === null ? "Never" : String(r.medianDepletionYear)) },
  ];
  return (
    <section className="panel" aria-busy={c.loading}>
      <h2>Side by side</h2>
      <div className="table-wrap">
        <table className="table compact compare">
          <thead>
            <tr>
              <th scope="col" />
              {d.rows.map((r, k) => (
                <th key={r.id ?? "base"} scope="col">
                  <span className="compare-head">
                    <i className={`key s${k + 1}`} aria-hidden /> {r.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.label}>
                <th scope="row" title={m.hint}>
                  {m.label}
                </th>
                {d.rows.map((r) => (
                  <td key={r.id ?? "base"} className={m.label === "Chance money lasts" ? (r.successRate >= d.target ? "good" : "short") : undefined}>
                    {m.value(r)}
                    {m.label === "Chance money lasts" && r.successRate === best && d.rows.length > 1 ? <span className="badge">best</span> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Median portfolio, today's dollars</h3>
      <MultiLineChart
        label="Median portfolio by year for each scenario"
        xLabels={years.map(String)}
        series={d.rows.map((r) => {
          const by = new Map(r.median.map((m) => [m.year, m.value]));
          return { name: r.name, values: years.map((y) => by.get(y) ?? null) };
        })}
      />
      <button type="button" className="link table-toggle" onClick={() => setTable(!table)}>
        {table ? "Hide" : "Show"} the numbers
      </button>
      {table && (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th scope="col">Year</th>
                {d.rows.map((r) => (
                  <th key={r.id ?? "base"} scope="col" className="num">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr key={y}>
                  <th scope="row">{y}</th>
                  {d.rows.map((r) => {
                    const v = r.median.find((m) => m.year === y)?.value;
                    return (
                      <td key={r.id ?? "base"} className="num">
                        {v === undefined ? "–" : money(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Each scenario runs the same historical simulation as <Link to="/retirement">Retirement</Link>, with only the listed changes applied.
      </p>
    </section>
  );
}

export function ScenariosPage() {
  const scenarios = useApi<ScenarioView[]>("/api/scenarios");
  const household = useApi<HouseholdResponse>("/api/household");
  const [selected, setSelected] = useState<number[]>([]);
  const [editing, setEditing] = useState<ScenarioView | "new" | null>(null);
  const [promoting, setPromoting] = useState<ScenarioView | null>(null);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const people = household.data?.people ?? [];
  const list = scenarios.data ?? [];
  // Only compare scenarios that still exist.
  const ids = selected.filter((id) => list.some((s) => s.id === id));

  const toggle = (id: number) => setSelected(ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < 3 ? [...ids, id] : ids);
  const remove = async (s: ScenarioView) => {
    if (!window.confirm(`Delete "${s.name}"?`)) return;
    await api("DELETE", `/api/scenarios/${s.id}`);
    void scenarios.reload();
  };
  const promote = async (s: ScenarioView) => {
    try {
      const r = await api<{ applied: string[] }>("POST", `/api/scenarios/${s.id}/promote`);
      setPromoting(null);
      setMessage(`"${s.name}" is now your plan: ${r.applied.join("; ")}.`);
      notifyDataChanged();
      void scenarios.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Scenarios"
        subtitle="What if you retired earlier, bought a house, or one of you stopped working? Compare up to three against your plan today."
        actions={
          <button type="button" onClick={() => setEditing("new")} disabled={people.length === 0}>
            New scenario
          </button>
        }
      />
      {message && (
        <p className="note ok" role="status">
          {message} <Link to="/retirement">See the projection →</Link>
        </p>
      )}
      <ErrorNote message={error} />
      {!scenarios.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>
          <p>No scenarios yet.</p>
          {people.length === 0 ? (
            <p>
              <Link to="/settings/household">Add your household</Link> first.
            </p>
          ) : (
            <button type="button" onClick={() => setEditing("new")}>
              Make your first scenario
            </button>
          )}
        </Empty>
      ) : (
        <section className="scenario-list">
          {list.map((s) => {
            const k = ids.indexOf(s.id);
            return (
              <article key={s.id} className={`panel scenario${k >= 0 ? " selected" : ""}`}>
                <label className="compare-pick">
                  <input type="checkbox" checked={k >= 0} disabled={k < 0 && ids.length >= 3} onChange={() => toggle(s.id)} />
                  {k >= 0 && <i className={`key s${k + 2}`} aria-hidden />}
                  <strong>{s.name}</strong>
                </label>
                <ul>
                  {s.summary.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                <div className="row-actions">
                  <button type="button" className="link" onClick={() => setEditing(s)}>
                    Edit
                  </button>
                  <button type="button" className="link" onClick={() => setPromoting(s)}>
                    Make this my plan
                  </button>
                  <button type="button" className="link danger" onClick={() => void remove(s)}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
      {list.length > 0 && (ids.length === 0 ? <p className="muted">Tick up to three scenarios to compare them with your plan.</p> : <Comparison ids={ids} />)}

      {editing && (
        <ScenarioForm
          scenario={editing === "new" ? undefined : editing}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void scenarios.reload();
          }}
        />
      )}
      {promoting && (
        <Modal
          title={`Make "${promoting.name}" your plan?`}
          onClose={() => setPromoting(null)}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setPromoting(null)}>
                Cancel
              </button>
              <button type="button" onClick={() => void promote(promoting)}>
                Make it my plan
              </button>
            </>
          }
        >
          <p>These changes become part of your real plan:</p>
          <ul>
            {promoting.summary.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="muted small">
            Retirement ages and pay update your household, a new mix updates your investment target, and everything else is kept as an event on the
            Retirement page, where you can remove it.
          </p>
        </Modal>
      )}
    </>
  );
}

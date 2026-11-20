import { useEffect, useState } from "react";
import type { ClaimingResponse, ConversionsResponse, ExploreResponse, RetirementResponse, WithdrawalOrderResponse } from "../../shared/api.ts";
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
      <summary>
        Retirement spending: {money(s.firstYear)} a year when you retire{s.oneOffs.length > 0 ? ", plus one-off costs" : ""}
        <span className="muted small"> (today's budget with healthcare costs grown to then)</span>
      </summary>
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
  const [hair, setHair] = useState<number | null>(s.returnHaircutPct);
  const [cg, setCg] = useState<number | null>(s.capitalGainsPct);
  const [state, setState] = useState<number | null>(s.stateTaxPct);
  const [mode, setMode] = useState<number | null>(s.lifeMode);
  const [spread, setSpread] = useState<number | null>(s.lifeSpread);
  const [survivor, setSurvivor] = useState<number | null>(s.survivorSpendingPct);
  const [rails, setRails] = useState(s.guardrails);
  const [rothBasis, setRothBasis] = useState<number | null>(s.rothBasisPct);
  const [cut, setCut] = useState(s.ssShortfall);
  const [hcShare, setHcShare] = useState<number | null>(s.healthcareSharePct);
  const [hcGrowth, setHcGrowth] = useState<number | null>(s.healthcareGrowthPct);
  const [drift, setDrift] = useState<number | null>(s.otherSpendingDriftPct);
  const [care, setCare] = useState(s.longTermCare);
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
        <Field label="How taxes are worked out" hint="Brackets use the federal tax code for your filing status. A flat rate is a simple average.">
          <select value={s.taxMode} onChange={(e) => void save({ taxMode: e.target.value })} aria-label="How taxes are worked out">
            <option value="brackets">Federal brackets (recommended)</option>
            <option value="flat">Flat rates</option>
          </select>
        </Field>
        {s.taxMode === "brackets" ? (
          <Field label="State income tax" hint="A flat rate on withdrawals and gains. Leave at 0 if your state doesn't tax them.">
            <span onBlur={() => state !== null && state !== s.stateTaxPct && void save({ stateTaxPct: state })}>
              <NumberInput value={state} min={0} max={15} step={0.5} suffix="%" ariaLabel="State income tax" onChange={setState} />
            </span>
          </Field>
        ) : (
          <>
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
          </>
        )}
        <Field label="Investment mix" hint="Target: your aim, rebalanced every year. What I hold: today's mix, left to drift.">
          <select value={s.allocationSource} onChange={(e) => void save({ allocationSource: e.target.value })} aria-label="Investment mix used">
            <option value="target">My target mix</option>
            <option value="actual">What I hold today</option>
          </select>
        </Field>
        <Field label="Returns stress" hint="Take this many points off every stock and bond return, every year, to plan for a worse future than history">
          <span onBlur={() => hair !== null && hair !== s.returnHaircutPct && void save({ returnHaircutPct: hair })}>
            <NumberInput value={hair} min={0} max={5} step={0.5} suffix="points" ariaLabel="Returns stress" onChange={setHair} />
          </span>
        </Field>
        <Field label="How long you live" hint="Random: each future draws its own lifespans, so money has to last only as long as you do. Fixed: plan to the household planning age in every future.">
          <select value={s.longevity} onChange={(e) => void save({ longevity: e.target.value })} aria-label="How long you live">
            <option value="modeled">Drawn at random (recommended)</option>
            <option value="fixed">Fixed planning age</option>
          </select>
        </Field>
        {s.longevity === "modeled" && (
          <>
            <Field label="Most common age at death" hint="The peak of the curve. Lower it for poor health, raise it for long-lived family.">
              <span onBlur={() => mode !== null && mode !== s.lifeMode && void save({ lifeMode: mode })}>
                <NumberInput value={mode} min={70} max={100} ariaLabel="Most common age at death" onChange={setMode} />
              </span>
            </Field>
            <Field label="Spread of lifespans" hint="Years. Bigger means more very short and very long lives.">
              <span onBlur={() => spread !== null && spread !== s.lifeSpread && void save({ lifeSpread: spread })}>
                <NumberInput value={spread} min={5} max={15} suffix="years" ariaLabel="Spread of lifespans" onChange={setSpread} />
              </span>
            </Field>
            {(data.inputs?.people.length ?? 0) > 1 && (
              <Field label="Spending after one of you dies" hint="Percent of the plan. Housing and insurance don't halve, food and travel mostly do.">
                <span onBlur={() => survivor !== null && survivor !== s.survivorSpendingPct && void save({ survivorSpendingPct: survivor })}>
                  <NumberInput value={survivor} min={40} max={100} suffix="%" ariaLabel="Spending after one of you dies" onChange={setSurvivor} />
                </span>
              </Field>
            )}
          </>
        )}
        <label className="check wide">
          <input type="checkbox" checked={rails.enabled} onChange={(e) => { const next = { ...rails, enabled: e.target.checked }; setRails(next); void save({ guardrails: next }); }} />
          Cut spending after bad markets (guardrails) instead of spending the same every year
        </label>
        {rails.enabled && (
          <>
            <Field label="Cut when the withdrawal rate is this far above where it started" hint="Percent">
              <span onBlur={() => rails !== s.guardrails && void save({ guardrails: rails })}>
                <NumberInput value={rails.upperPct} min={5} max={50} suffix="%" ariaLabel="Guardrail cut trigger" onChange={(v) => setRails({ ...rails, upperPct: v ?? rails.upperPct })} />
              </span>
            </Field>
            <Field label="Restore when it is this far below" hint="Percent">
              <span onBlur={() => rails !== s.guardrails && void save({ guardrails: rails })}>
                <NumberInput value={rails.lowerPct} min={5} max={50} suffix="%" ariaLabel="Guardrail restore trigger" onChange={(v) => setRails({ ...rails, lowerPct: v ?? rails.lowerPct })} />
              </span>
            </Field>
            <Field label="Size of each cut or restore" hint="Percent of the plan">
              <span onBlur={() => rails !== s.guardrails && void save({ guardrails: rails })}>
                <NumberInput value={rails.adjustPct} min={1} max={25} suffix="%" ariaLabel="Guardrail step" onChange={(v) => setRails({ ...rails, adjustPct: v ?? rails.adjustPct })} />
              </span>
            </Field>
            <Field label="Never spend less than" hint="Percent of the plan">
              <span onBlur={() => rails !== s.guardrails && void save({ guardrails: rails })}>
                <NumberInput value={rails.floorPct} min={40} max={100} suffix="%" ariaLabel="Guardrail floor" onChange={(v) => setRails({ ...rails, floorPct: v ?? rails.floorPct })} />
              </span>
            </Field>
          </>
        )}
        {s.taxMode === "brackets" && (
          <>
            <label className="check wide">
              <input type="checkbox" checked={s.earlyWithdrawalRules} onChange={(e) => void save({ earlyWithdrawalRules: e.target.checked })} />
              Charge the 10% early-withdrawal penalty (pre-tax money before 60, Roth growth, conversions inside five years)
            </label>
            {s.earlyWithdrawalRules && (
              <>
                <label className="check wide">
                  <input type="checkbox" checked={s.ruleOf55} onChange={(e) => void save({ ruleOf55: e.target.checked })} />
                  Workplace plans are open without penalty if you stop working in or after the year you turn 55
                </label>
                <Field label="Share of today's Roth that is your own contributions" hint="Contributions come out tax- and penalty-free. If much of the balance is growth, enter less.">
                  <span onBlur={() => rothBasis !== null && rothBasis !== s.rothBasisPct && void save({ rothBasisPct: rothBasis })}>
                    <NumberInput value={rothBasis} min={0} max={100} suffix="%" ariaLabel="Roth contributions share" onChange={setRothBasis} />
                  </span>
                </Field>
              </>
            )}
          </>
        )}
        {(data.inputs?.people.length ?? 0) === 2 && (
          <label className="check wide">
            <input type="checkbox" checked={s.spousalBenefits} onChange={(e) => void save({ spousalBenefits: e.target.checked })} />
            Spousal Social Security: a spouse with a smaller benefit gets up to half of the other's
          </label>
        )}
        <label className="check wide">
          <input type="checkbox" checked={cut.enabled} onChange={(e) => { const next = { ...cut, enabled: e.target.checked }; setCut(next); void save({ ssShortfall: next }); }} />
          Assume Social Security is cut when its trust fund runs short
        </label>
        {cut.enabled && (
          <>
            <Field label="Cut starts in" hint="The 2026 Trustees Report has the retirement fund short in late 2032.">
              <span onBlur={() => cut !== s.ssShortfall && void save({ ssShortfall: cut })}>
                <NumberInput value={cut.startYear} min={2026} max={2100} ariaLabel="Social Security cut start year" onChange={(v) => setCut({ ...cut, startYear: v ?? cut.startYear })} />
              </span>
            </Field>
            <Field label="Share of scheduled benefits still paid" hint="About 78% at first in the Trustees Report, falling later.">
              <span onBlur={() => cut !== s.ssShortfall && void save({ ssShortfall: cut })}>
                <NumberInput value={cut.payablePct} min={30} max={100} suffix="%" ariaLabel="Share of benefits paid" onChange={(v) => setCut({ ...cut, payablePct: v ?? cut.payablePct })} />
              </span>
            </Field>
          </>
        )}
        <Field label="Healthcare share of spending" hint="The part of retirement spending that is medical costs and insurance.">
          <span onBlur={() => hcShare !== null && hcShare !== s.healthcareSharePct && void save({ healthcareSharePct: hcShare })}>
            <NumberInput value={hcShare} min={0} max={60} suffix="%" ariaLabel="Healthcare share of spending" onChange={setHcShare} />
          </span>
        </Field>
        <Field label="Healthcare cost growth above inflation" hint="Per year, starting today. Healthcare has usually outpaced prices.">
          <span onBlur={() => hcGrowth !== null && hcGrowth !== s.healthcareGrowthPct && void save({ healthcareGrowthPct: hcGrowth })}>
            <NumberInput value={hcGrowth} min={0} max={5} step={0.5} suffix="% a year" ariaLabel="Healthcare growth above inflation" onChange={setHcGrowth} />
          </span>
        </Field>
        <Field label="Other spending change after retiring" hint="Real change per year. Many retirees spend a little less each year; try -1 to see.">
          <span onBlur={() => drift !== null && drift !== s.otherSpendingDriftPct && void save({ otherSpendingDriftPct: drift })}>
            <NumberInput value={drift} min={-3} max={3} step={0.5} suffix="% a year" ariaLabel="Other spending change" onChange={setDrift} />
          </span>
        </Field>
        <label className="check wide">
          <input type="checkbox" checked={care.enabled} onChange={(e) => { const next = { ...care, enabled: e.target.checked }; setCare(next); void save({ longTermCare: next }); }} />
          Include a chance of paid long-term care near the end of life
        </label>
        {care.enabled && (
          <>
            <Field label="Chance each person needs paid care" hint="Percent. These are rough defaults to adjust, not a quote.">
              <span onBlur={() => care !== s.longTermCare && void save({ longTermCare: care })}>
                <NumberInput value={care.probabilityPct} min={0} max={100} suffix="%" ariaLabel="Chance of long-term care" onChange={(v) => setCare({ ...care, probabilityPct: v ?? care.probabilityPct })} />
              </span>
            </Field>
            <Field label="Years of care, on average" hint="Spells run up to ten years.">
              <span onBlur={() => care !== s.longTermCare && void save({ longTermCare: care })}>
                <NumberInput value={care.meanYears} min={1} max={8} step={0.5} suffix="years" ariaLabel="Years of care" onChange={(v) => setCare({ ...care, meanYears: v ?? care.meanYears })} />
              </span>
            </Field>
            <Field label="Cost per year of care" hint="In today's dollars, on top of regular spending.">
              <span onBlur={() => care !== s.longTermCare && void save({ longTermCare: care })}>
                <MoneyInput value={care.annualCost} ariaLabel="Yearly cost of care" onChange={(v) => setCare({ ...care, annualCost: v ?? care.annualCost })} />
              </span>
            </Field>
          </>
        )}
        <label className="check wide">
          <input type="checkbox" checked={s.includePlanSavings} onChange={(e) => void save({ includePlanSavings: e.target.checked })} />
          Include the savings Next best moves recommends ({money((data.inputs?.extraSavings.total ?? 0) / 12)}/mo now)
        </label>
      </div>
      <ErrorNote message={error} />
      <ul className="small muted assumptions">
        <li>
          {s.runs.toLocaleString("en-US")} simulated futures, each replaying history in random {s.blockLength}-year blocks: stock, bond and cash
          returns and inflation come from the same real year, so crashes and inflation spikes keep their real company. A block that reaches the
          end of the data starts over; no run jumps from the latest year back to 1928.
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
        <li>
          {s.taxMode === "brackets"
            ? `Taxes follow the federal brackets, standard deduction, 0/15/20% gains rates and partial taxation of Social Security (${data.sources.tax}).`
            : "Taxes use the two flat rates above."}
        </li>
        <li>
          {s.longevity === "modeled"
            ? `Lifespans are drawn from a smooth curve peaking at ${s.lifeMode}, not a life table. After a first death the household spends ${s.survivorSpendingPct}% of the plan, the survivor keeps the larger Social Security benefit, pensions stop and taxes switch to single filing the next year.`
            : "Every future plans to the same fixed age."}
        </li>
        <li>
          {s.taxMode === "brackets"
            ? `Medicare surcharges (IRMAA) are added from 65, set by income two years earlier. ${data.sources.medicare ?? ""}`
            : "Medicare surcharges are only counted with the bracket tax model."}
        </li>
        <li>
          While one of two earners has stopped working, the other's pay (less payroll tax, contributions and income tax) goes toward spending and the rest comes from savings; the
          spare-money savings from Next best moves stop then. Healthcare spending grows {s.healthcareGrowthPct}% a year above inflation from today.
        </li>
        <li>
          People 65 and over get the extra standard deduction and, through 2028, the $6,000 senior deduction. Not included yet: tax drag while saving, penalty exceptions such as
          72(t) payments, Part D surcharges, and the cost of losing health-insurance subsidies.
        </li>
      </ul>
    </details>
  );
}

/** Three dials, answered live with the same random years as the headline. */
function TryPanel({ endYear, birthYear }: { endYear: number; birthYear: number }) {
  const [shift, setShift] = useState(0);
  const [spend, setSpend] = useState(100);
  const [extra, setExtra] = useState(0);
  const [res, setRes] = useState<ExploreResponse>();
  const [error, setError] = useState<string>();
  const untouched = shift === 0 && spend === 100 && extra === 0;

  useEffect(() => {
    if (untouched) return;
    let current = true;
    const t = setTimeout(async () => {
      try {
        const r = await api<ExploreResponse>("POST", "/api/retirement/explore", { retireShiftYears: shift, spendingPct: spend, extraMonthly: extra * 100 });
        if (current) {
          setRes(r);
          setError(undefined);
        }
      } catch (err) {
        if (current) setError(errorMessage(err));
      }
    }, 350);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [shift, spend, extra, untouched]);

  const c = !untouched && res && res.ready ? res : undefined;
  const delta = c ? Math.round((c.changed.successRate - c.base.successRate) * 1000) / 10 : 0;
  return (
    <section className="panel tight">
      <h2>Try a change</h2>
      <p className="muted small">Move a dial to see what it would do. Nothing is saved.</p>
      <div className="dials">
        <label className="dial">
          <span className="field-label">Retire {shift === 0 ? "as planned" : shift > 0 ? `${shift} year${shift === 1 ? "" : "s"} later` : `${-shift} year${shift === -1 ? "" : "s"} earlier`}</span>
          <input type="range" min={-5} max={5} step={1} value={shift} onChange={(e) => setShift(Number(e.target.value))} aria-label="Years earlier or later" />
        </label>
        <label className="dial">
          <span className="field-label">Spend {spend === 100 ? "as planned" : `${spend}% of plan`} in retirement</span>
          <input type="range" min={70} max={130} step={5} value={spend} onChange={(e) => setSpend(Number(e.target.value))} aria-label="Retirement spending as a percent of the plan" />
        </label>
        <label className="dial">
          <span className="field-label">Save {extra === 0 ? "nothing extra" : `$${extra.toLocaleString("en-US")} more`} a month</span>
          <input type="range" min={0} max={3000} step={100} value={extra} onChange={(e) => setExtra(Number(e.target.value))} aria-label="Extra monthly saving" />
        </label>
      </div>
      <ErrorNote message={error} />
      {untouched && <p className="muted small">Planning to age {endYear - birthYear}.</p>}
      {c && (
        <p className="dial-result" aria-live="polite">
          <strong>{pct(c.changed.successRate)}</strong> chance your money lasts{" "}
          <span className={`delta ${delta >= 0 ? "up" : "down"}`}>
            ({delta >= 0 ? "+" : ""}
            {delta} points)
          </span>
          . Median portfolio at {endYear - birthYear}: {money(c.changed.medianAtEnd)}. Retirement starts {c.changed.retireYear}.{" "}
          <span className="muted small">
            ±{Math.round(((c.changed.successInterval[1] - c.changed.successInterval[0]) / 2) * 100)} points from the number of runs.
          </span>
        </p>
      )}
    </section>
  );
}

function ClaimingPanel() {
  const claiming = useApi<ClaimingResponse>("/api/retirement/claiming");
  const c = claiming.data;
  if (!c || !c.ready || c.people.length === 0) return null;
  return (
    <section className="panel tight">
      <h2>When to claim Social Security</h2>
      <p className="muted small">
        Chance your money lasts for each claim age, with everything else unchanged. Waiting pays more each month but means drawing on savings
        longer first. It does not include spousal or survivor benefits yet.
      </p>
      {c.people.map((p) => {
        const best = Math.max(...p.options.map((o) => o.successRate));
        return (
          <div key={p.id}>
            <strong>{p.name}</strong> <span className="muted small">plans to claim at {p.planned}</span>
            <table className="table">
              <thead>
                <tr>
                  <th>Claim at</th>
                  <th className="num">Monthly</th>
                  <th className="num">Chance it lasts</th>
                </tr>
              </thead>
              <tbody>
                {p.options.map((o) => (
                  <tr key={o.age} className={o.age === p.planned ? "current" : undefined}>
                    <td>
                      {o.age}
                      {o.age === p.planned && <span className="muted small"> (planned)</span>}
                    </td>
                    <td className="num">{money(o.monthly)}</td>
                    <td className="num">
                      {pct(o.successRate)}
                      {o.successRate === best && o.successRate > 0 && <span className="muted small"> best</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}

/** Which money is spent first: taxable savings, or pre-tax money up to the top of a bracket. */
function WithdrawalOrderPanel({ onChanged }: { onChanged: () => void }) {
  const order = useApi<WithdrawalOrderResponse>("/api/retirement/withdrawal-order");
  const [error, setError] = useState<string>();
  const o = order.data;
  if (!o) return null;
  if (!o.ready || !o.options) {
    return (
      <section className="panel tight">
        <h2>Which money to spend first</h2>
        <p className="muted small">{o.reason ?? "Not available yet."}</p>
      </section>
    );
  }
  const none = o.options[0]!;
  const choose = async (ratePct: number) => {
    try {
      await api("PUT", "/api/retirement/settings", { withdrawalFillRatePct: ratePct });
      setError(undefined);
      notifyDataChanged();
      onChanged();
      order.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <section className="panel tight">
      <h2>Which money to spend first</h2>
      <p className="muted small">
        The usual order spends taxable savings first and leaves pre-tax money to grow, which can push required minimums into a high bracket later. The other rows spend
        pre-tax money first, only as far as the top of the bracket shown, then taxable savings. Every row replays the same random futures, so the last column compares each
        row with "Taxable first" one future at a time.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Spend first</th>
            <th className="num">Chance it lasts</th>
            <th className="num">Income tax over retirement</th>
            <th className="num">Medicare surcharges</th>
            <th className="num">End value after heirs' tax</th>
            <th className="num">Better off than taxable first</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {o.options.map((opt) => (
            <tr key={opt.ratePct} className={opt.ratePct === o.chosen ? "current" : undefined}>
              <td>{opt.ratePct === 0 ? "Taxable savings first" : `Pre-tax up to the ${opt.ratePct}% bracket`}</td>
              <td className="num">{pct(opt.successRate)}</td>
              <td className="num">
                {opt.medianLifetimeTax === null ? "—" : money(opt.medianLifetimeTax)}
                {opt.ratePct !== 0 && none.medianLifetimeTax !== null && opt.medianLifetimeTax !== null && (
                  <span className="muted small"> ({opt.medianLifetimeTax >= none.medianLifetimeTax ? "+" : "−"}{money(Math.abs(opt.medianLifetimeTax - none.medianLifetimeTax))})</span>
                )}
              </td>
              <td className="num">{opt.medianMedicareSurcharge === null ? "—" : money(opt.medianMedicareSurcharge)}</td>
              <td className="num">{money(opt.medianEndAfterTax)}</td>
              <td className="num">
                {opt.paired === null ? (
                  "—"
                ) : (
                  <>
                    {pct(opt.paired.better)} of futures{" "}
                    <span className="muted small">
                      (worse in {pct(opt.paired.worse)}; typical {opt.paired.medianEndDifference >= 0 ? "+" : "−"}
                      {money(Math.abs(opt.paired.medianEndDifference))})
                    </span>
                  </>
                )}
              </td>
              <td>
                {opt.ratePct !== o.chosen && (
                  <button type="button" className="btn small" onClick={() => void choose(opt.ratePct)}>
                    Use in plan
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorNote message={error} />
      <p className="muted small">
        Filling a low bracket early usually cuts lifetime tax, but it also uses up room that Roth conversions would use, so check the two panels together. If the rows
        look alike, there is little pre-tax money to draw or little taxable money to hold back. Only pre-tax money that can come out without penalty is used, and the
        brackets are today's, assumed to hold in real terms.
      </p>
    </section>
  );
}

/** Fill a tax bracket with Roth conversions before required minimums start. */
function ConversionPanel({ onChanged }: { onChanged: () => void }) {
  const conv = useApi<ConversionsResponse>("/api/retirement/conversions");
  const [error, setError] = useState<string>();
  const c = conv.data;
  if (!c) return null;
  if (!c.ready || !c.options || !c.window) {
    return (
      <section className="panel tight">
        <h2>Roth conversions</h2>
        <p className="muted small">{c.reason ?? "Not available yet."}</p>
      </section>
    );
  }
  const none = c.options[0]!;
  const choose = async (ratePct: number) => {
    try {
      await api("PUT", "/api/retirement/settings", { rothConversionRatePct: ratePct });
      setError(undefined);
      notifyDataChanged();
      onChanged();
      conv.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <section className="panel tight">
      <h2>Roth conversions</h2>
      <p className="muted small">
        Each year from {c.window.from} to {c.window.to}, before required minimums start, move pre-tax money to Roth until your taxable income reaches the top of the
        bracket below. You pay the tax now, from taxable savings, to owe less later. Every row replays the same random futures, so the last column compares each row with
        "No conversions" one future at a time.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Fill this bracket</th>
            <th className="num">Chance it lasts</th>
            <th className="num">Converted</th>
            <th className="num">Income tax over retirement</th>
            <th className="num">Medicare surcharges</th>
            <th className="num">End value after heirs' tax</th>
            <th className="num">Better off than no conversions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {c.options.map((o) => (
            <tr key={o.ratePct} className={o.ratePct === c.chosen ? "current" : undefined}>
              <td>{o.ratePct === 0 ? "No conversions" : `${o.ratePct}%`}</td>
              <td className="num">{pct(o.successRate)}</td>
              <td className="num">{o.medianConverted ? money(o.medianConverted) : "—"}</td>
              <td className="num">
                {o.medianLifetimeTax === null ? "—" : money(o.medianLifetimeTax)}
                {o.ratePct !== 0 && none.medianLifetimeTax !== null && o.medianLifetimeTax !== null && (
                  <span className="muted small"> ({o.medianLifetimeTax >= none.medianLifetimeTax ? "+" : "−"}{money(Math.abs(o.medianLifetimeTax - none.medianLifetimeTax))})</span>
                )}
              </td>
              <td className="num">{o.medianMedicareSurcharge === null ? "—" : money(o.medianMedicareSurcharge)}</td>
              <td className="num">{money(o.medianEndAfterTax)}</td>
              <td className="num">
                {o.paired === null ? (
                  "—"
                ) : (
                  <>
                    {pct(o.paired.better)} of futures{" "}
                    <span className="muted small">
                      (worse in {pct(o.paired.worse)}; typical {o.paired.medianEndDifference >= 0 ? "+" : "−"}
                      {money(Math.abs(o.paired.medianEndDifference))})
                    </span>
                    {(o.paired.saved > 0 || o.paired.lost > 0) && (
                      <div className="muted small">
                        Saves {pct(o.paired.saved)} of futures, loses {pct(o.paired.lost)}
                      </div>
                    )}
                  </>
                )}
              </td>
              <td>
                {o.ratePct !== c.chosen && (
                  <button type="button" className="btn small" onClick={() => void choose(o.ratePct)}>
                    Use in plan
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorNote message={error} />
      <p className="muted small">
        Look for the row where the chance it lasts and the end value rise without a jump in Medicare surcharges. Conversions raise income now, which can
        also cost health-insurance subsidies before 65 and state tax, neither of which is counted here. The comparison is paired, so a share of futures
        near 50% means no clear difference. This is a comparison to take to a tax professional, not a recommendation to convert.
      </p>
    </section>
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
        subtitle={`${i.people.map((p) => `${p.name} retires at ${p.retirementAge}`).join(", ")} · ${d.settings.longevity === "modeled" ? "lifespans drawn at random" : `planning to age ${ageOf(i.endYear)} for ${primary.name}`}`}
      />

      <section className="panel retire-hero">
        <div>
          <span className="field-label">Chance your money lasts</span>
          <div className={`hero ${onTrack ? "" : "over"}`}>{pct(r.successRate)}</div>
          <p className="small">
            {onTrack ? <span className="status ok">On track</span> : <span className="status over">Below your {pct(target)} target</span>}{" "}
            <span className="muted">
              {Math.round(r.successRate * r.runs).toLocaleString("en-US")} of {r.runs.toLocaleString("en-US")} simulated futures last{" "}
              {d.settings.longevity === "modeled" ? "as long as the people in them do" : `to ${i.endYear}`}.
            </span>
          </p>
          <p className="muted small">
            With this many runs the number is good to about ±{Math.round(((r.successInterval[1] - r.successInterval[0]) / 2) * 100)} points
            ({pct(r.successInterval[0])}–{pct(r.successInterval[1])}). The history it draws on is short, so treat small gaps as ties.
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
            <dd>
              {r.medianDepletionYear === null
                ? "None do"
                : `money runs out around age ${ageOf(r.medianDepletionYear)} (median)${r.earlyDepletionYear !== null ? `, as early as ${ageOf(r.earlyDepletionYear)} in the worst tenth` : ""}`}
            </dd>
          </div>
          {r.shortfall.failedMedian !== null && (
            <div>
              <dt>How big the shortfall is</dt>
              <dd>
                {money(r.shortfall.failedMedian)} of spending goes unfunded in the typical failing future
                {r.shortfall.failedMedianYears !== null && ` (about ${r.shortfall.failedMedianYears} years of spending)`}
                {r.shortfall.failedP90 !== null && `, ${money(r.shortfall.failedP90)} in the worst tenth of failures`}
                <span className="muted small"> · {money(r.shortfall.expected)} on average across all futures</span>
              </dd>
            </div>
          )}
          {r.penalties && r.penalties.share >= 0.01 && (
            <div>
              <dt>Early-withdrawal penalties</dt>
              <dd>
                {pct(r.penalties.share)} of futures pay some; {money(r.penalties.median)} median
              </dd>
            </div>
          )}
          {r.longTermCare && (
            <div>
              <dt>Long-term care</dt>
              <dd>{pct(r.longTermCare.share)} of futures include paid care for at least one of you</dd>
            </div>
          )}
          {r.guardrails && (
            <div>
              <dt>Spending cuts under your guardrails</dt>
              <dd>
                {r.guardrails.cutShare === 0
                  ? "None needed in any future"
                  : `${pct(r.guardrails.cutShare)} of futures cut spending at least once, to ${r.guardrails.medianLowestPct}% of plan at the lowest (typical)`}
              </dd>
            </div>
          )}
          {r.medianLifetimeTax !== null && (
            <div>
              <dt>Income tax over retirement</dt>
              <dd>
                {money(r.medianLifetimeTax)} median
                {r.medianMedicareSurcharge !== null && r.medianMedicareSurcharge > 0 && <span className="muted small"> plus {money(r.medianMedicareSurcharge)} in Medicare surcharges</span>}
              </dd>
            </div>
          )}
          {r.fragileRate >= 0.01 && (
            <div>
              <dt>Close calls</dt>
              <dd>{pct(r.fragileRate)} of futures last but end with under 3 years of spending left</dd>
            </div>
          )}
        </dl>
      </section>

      {d.checks && (
        <section className="panel tight">
          <h2>Other ways to look at it</h2>
          <dl className="hero-facts">
            <div>
              <dt>Living each real start year in order</dt>
              <dd>
                {pct(d.checks.replay.successRate)}{" "}
                <span className="muted small">of {d.checks.replay.startYears} historical starts (the classic safe-withdrawal method)</span>
              </dd>
            </div>
            <div>
              <dt>If returns are {d.checks.stress.haircutPct} point a year lower</dt>
              <dd>{pct(d.checks.stress.successRate)}</dd>
            </div>
            {d.checks.fixedHorizon && (
              <div>
                <dt>If everyone lives to {d.checks.fixedHorizon.age}</dt>
                <dd>
                  {pct(d.checks.fixedHorizon.successRate)} <span className="muted small">no random lifespans</span>
                </dd>
              </div>
            )}
            {d.checks.ssShortfall && (
              <div>
                <dt>
                  {d.checks.ssShortfall.applied
                    ? "If Social Security pays in full"
                    : `If Social Security pays ${d.checks.ssShortfall.payablePct}% from ${d.checks.ssShortfall.startYear}`}
                </dt>
                <dd>{pct(d.checks.ssShortfall.otherSuccessRate)}</dd>
              </div>
            )}
            {d.checks.longTermCare && (
              <div>
                <dt>{d.checks.longTermCare.applied ? "If no one needs long-term care" : "If long-term care is needed"}</dt>
                <dd>{pct(d.checks.longTermCare.otherSuccessRate)}</dd>
              </div>
            )}
            {d.checks.withoutGuardrails && (
              <div>
                <dt>If spending never changed</dt>
                <dd>{pct(d.checks.withoutGuardrails.successRate)}</dd>
              </div>
            )}
          </dl>
          <p className="muted small">
            Different methods answer slightly different questions. If they agree, trust the number more; if they split, the plan is more
            sensitive to what the future looks like than one figure suggests. What-if answers below use {d.checks.whatIfRuns.toLocaleString("en-US")} runs, so
            they are approximate near the target.
          </p>
        </section>
      )}

      <TryPanel endYear={i.endYear} birthYear={primary.birthYear} />

      <ClaimingPanel />

      <WithdrawalOrderPanel onChanged={reload} />

      <ConversionPanel onChanged={reload} />

      {d.events.length > 0 && (
        <section className="panel">
          <div className="group-head">
            <h2>Changes from scenarios</h2>
            <Link to="/scenarios">Scenarios →</Link>
          </div>
          <ul className="lines">
            {d.events.map((e, idx) => (
              <li key={`${e}-${idx}`}>
                <span>{e}</span>
                <button
                  type="button"
                  className="link"
                  onClick={async () => {
                    await api("DELETE", `/api/retirement/events/${idx}`);
                    notifyDataChanged();
                    void data.reload();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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

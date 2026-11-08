import { useState } from "react";
import { addMonths } from "../../engine/dates.ts";
import type { DebtsResponse, StrategyComparison } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { monthLabel, monthTitle } from "../chartMath.ts";
import { LineChart } from "../components/charts.tsx";
import { Empty, ErrorNote, Loading, MoneyInput, PageHeader } from "../components/ui.tsx";
import { formatDate, formatMoney } from "../format.ts";
import { Link } from "../router.tsx";

type Strategy = "avalanche" | "snowball";

function StrategyTile({ c, s, chosen, onChoose }: { c: StrategyComparison; s: Strategy; chosen: boolean; onChoose: () => void }) {
  const p = c[s];
  const better = s === "avalanche" ? c.interestSaved > 0 : c.interestSaved < 0;
  return (
    <button type="button" className={`tile strategy${chosen ? " chosen" : ""}`} aria-pressed={chosen} onClick={onChoose}>
      <span className="tile-label">
        {s === "avalanche" ? "Avalanche: highest rate first" : "Snowball: smallest balance first"}
        {better && <span className="status ok"> Least interest</span>}
      </span>
      <span className="tile-value">{p.debtFreeDate ? monthTitle(p.debtFreeDate.slice(0, 7)) : "Never"}</span>
      <span className="muted small">
        {p.months === null ? "Minimums don't cover the interest" : `${p.months} months · ${formatMoney(p.totalInterest, { cents: false })} interest`}
      </span>
    </button>
  );
}

export function DebtPage() {
  const [extra, setExtra] = useState<number | null>(null);
  const [strategy, setStrategy] = useState<Strategy>("avalanche");
  const data = useApi<DebtsResponse>(`/api/debts${extra === null ? "" : `?extra=${extra}`}`);

  if (!data.data) return data.error ? <ErrorNote message={data.error} /> : <Loading />;
  const d = data.data;
  const c = d.comparison;
  const plan = c?.[strategy];
  const toPay = d.debts.filter((x) => !x.paysInFull);

  return (
    <>
      <PageHeader title="Debt" subtitle="What you owe, and the fastest way out. Cards you pay in full every month aren't counted as debt to pay down." />
      {d.debts.length === 0 ? (
        <Empty>
          <p>No debts. Loans and card balances show up here from your accounts.</p>
        </Empty>
      ) : (
        <>
          <section className="panel tight">
            <h2>Your debts</h2>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="num">Owed</th>
                    <th className="num">APR</th>
                    <th className="num">Minimum</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.debts.map((x) => (
                    <tr key={x.id} className={x.paysInFull ? "muted" : ""}>
                      <td>
                        <Link to={`/accounts/${x.id}`}>{x.name}</Link>
                        {x.paysInFull && <span className="muted small block">Paid in full monthly</span>}
                        {x.promoEnds && (
                          <span className="muted small block">
                            {x.promoApr ?? 0}% intro rate until {formatDate(x.promoEnds)}
                          </span>
                        )}
                      </td>
                      <td className="num">{formatMoney(x.balance)}</td>
                      <td className="num">{x.aprMissing ? <span className="status over">Add rate</span> : `${x.apr}%`}</td>
                      <td className="num">
                        {formatMoney(x.minPayment)}
                        {x.minimumEstimated && <span className="muted small block">estimated</span>}
                      </td>
                      <td className="num">
                        <Link to={`/accounts/${x.id}`} className="small">
                          Edit
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {c && toPay.length > 0 && (
            <>
              <section className="panel">
                <div className="group-head">
                  <h2>Payoff plan</h2>
                  <label className="inline-field">
                    <span className="field-label">Extra per month</span>
                    <span className="budget-input">
                      <MoneyInput value={extra ?? d.extra} onChange={(v) => setExtra(v ?? 0)} ariaLabel="Extra per month" />
                    </span>
                  </label>
                </div>
                <p className="muted small">
                  Your plan currently puts <strong>{formatMoney(d.suggestedExtra, { cents: false })}/mo</strong> on top of the minimums
                  {extra !== null && extra !== d.suggestedExtra && (
                    <>
                      {" "}
                      ·{" "}
                      <button type="button" className="link small" onClick={() => setExtra(null)}>
                        use that
                      </button>
                    </>
                  )}
                  . Starting {monthTitle(d.start.slice(0, 7))}.
                </p>
                <div className="tiles two">
                  <StrategyTile c={c} s="avalanche" chosen={strategy === "avalanche"} onChoose={() => setStrategy("avalanche")} />
                  <StrategyTile c={c} s="snowball" chosen={strategy === "snowball"} onChoose={() => setStrategy("snowball")} />
                </div>
                {c.interestSaved !== 0 && (
                  <p className="small">
                    Avalanche saves <strong>{formatMoney(Math.max(0, c.interestSaved), { cents: false })}</strong> in interest
                    {c.monthsSaved ? ` and finishes ${c.monthsSaved} months sooner` : ""}. Snowball pays off a whole debt sooner, which
                    some people find keeps them going.
                  </p>
                )}
                {plan && plan.growing.length > 0 && (
                  <div className="note">
                    {plan.growing.length === 1 ? "One minimum doesn't" : "Some minimums don't"} cover the monthly interest: paid at the
                    minimum alone, that balance would grow. Raise the minimum on the account page if your statement shows a higher one.
                  </div>
                )}
                {plan && plan.balances.length > 1 && (
                  <LineChart
                    label={`Total owed by month, ${strategy}`}
                    points={[toPay.reduce((s, x) => s + x.balance, 0), ...plan.balances].map((v, i) => {
                      const date = addMonths(d.start, i - 1);
                      return { key: String(i), label: monthLabel(date.slice(0, 7)), title: monthTitle(date.slice(0, 7)), value: v };
                    })}
                  />
                )}
              </section>

              {plan && (
                <section className="panel tight">
                  <h2>Payoff order ({strategy})</h2>
                  <div className="table-wrap">
                    <table className="table compact">
                      <thead>
                        <tr>
                          <th>Debt</th>
                          <th>Paid off</th>
                          <th className="num">Interest</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...plan.debts]
                          .sort((a, b) => (a.months ?? 1e9) - (b.months ?? 1e9))
                          .map((x) => (
                            <tr key={x.id}>
                              <td>{x.name}</td>
                              <td>{x.payoffDate ? `${monthTitle(x.payoffDate.slice(0, 7))} (${x.months} mo)` : "Not within 50 years"}</td>
                              <td className="num">{formatMoney(x.interest, { cents: false })}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

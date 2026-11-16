import { useState } from "react";
import type { MonthlyReport, ReportsResponse } from "../../shared/api.ts";
import { api, errorMessage, useApi } from "../api.ts";
import { monthTitle, pct } from "../chartMath.ts";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { formatMoney } from "../format.ts";
import { navigate } from "../navigation.ts";
import { Link } from "../router.tsx";

const money = (c: number) => formatMoney(c, { cents: false });
const signed = (c: number) => formatMoney(c, { cents: false, signed: true });

export function ReportsPage() {
  const r = useApi<ReportsResponse>("/api/reports");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const make = async (month: string) => {
    setBusy(true);
    try {
      await api("POST", `/api/reports/${month}`);
      navigate(`/reports/${month}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  const d = r.data;
  const hasLast = d?.reports.some((x) => x.month === d.lastMonth);

  return (
    <>
      <PageHeader
        title="Monthly reports"
        subtitle="A review of each month: budget, net worth, goals, retirement and what to do next. Sumday makes one on the 1st for the month before."
        actions={
          d && !hasLast ? (
            <button type="button" onClick={() => void make(d.lastMonth)} disabled={busy}>
              Make {monthTitle(d.lastMonth)} report
            </button>
          ) : null
        }
      />
      <ErrorNote message={error} />
      {!d ? (
        <Loading />
      ) : d.reports.length === 0 ? (
        <Empty>No reports yet. The first one appears on the 1st, or make it now.</Empty>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col" className="num">
                    Income
                  </th>
                  <th scope="col" className="num">
                    Spending
                  </th>
                  <th scope="col" className="num">
                    Savings rate
                  </th>
                  <th scope="col" className="num">
                    Net worth change
                  </th>
                  <th scope="col" className="num">
                    Retirement chance
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.reports.map((x) => (
                  <tr key={x.month}>
                    <td>
                      <Link to={`/reports/${x.month}`}>{monthTitle(x.month)}</Link>
                    </td>
                    <td className="num">{money(x.income)}</td>
                    <td className="num">{money(x.spending)}</td>
                    <td className="num">{pct(x.savingsRate)}</td>
                    <td className="num">{x.netWorthChange === null ? "–" : signed(x.netWorthChange)}</td>
                    <td className="num">{x.successRate === null ? "–" : `${Math.round(x.successRate * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="report-stat">
      <span className="field-label">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

export function ReportPage({ month }: { month: string }) {
  const r = useApi<MonthlyReport>(`/api/reports/${month}`);
  const [busy, setBusy] = useState(false);
  if (r.error) return <ErrorNote message={r.error} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  const b = d.budget;
  const regenerate = async () => {
    setBusy(true);
    await api("POST", `/api/reports/${month}`);
    await r.reload();
    setBusy(false);
  };

  return (
    <article className="report">
      <PageHeader
        title={`${monthTitle(month)} review`}
        subtitle={`Made ${new Date(d.generatedAt).toLocaleDateString()} · goals, plan and retirement as of ${d.asOf}`}
        actions={
          <span className="no-print">
            <button type="button" className="secondary" onClick={() => void regenerate()} disabled={busy}>
              {busy ? "Updating…" : "Update"}
            </button>{" "}
            <button type="button" onClick={() => window.print()}>
              Print or save PDF
            </button>
          </span>
        }
      />

      <section className="panel">
        <h2>1. Income, spending and saving</h2>
        <div className="report-stats">
          <Row label="Income" value={money(b.income)} sub={b.expectedIncome !== null ? `expected ${money(b.expectedIncome)}` : undefined} />
          <Row label="Spending" value={money(b.spending)} />
          <Row label="Left over" value={signed(b.net)} />
          <Row label="Savings rate" value={pct(b.savingsRate)} />
        </div>
        <table className="table compact report-table">
          <thead>
            <tr>
              <th scope="col">Budget</th>
              <th scope="col" className="num">
                Planned
              </th>
              <th scope="col" className="num">
                Actual
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Fixed</th>
              <td className="num">{money(b.fixed.budget)}</td>
              <td className="num">{money(b.fixed.actual)}</td>
            </tr>
            <tr>
              <th scope="row">Flex</th>
              <td className="num">{b.flex.budget === null ? "–" : money(b.flex.budget)}</td>
              <td className={`num${b.flex.budget !== null && b.flex.actual > b.flex.budget ? " over" : ""}`}>{money(b.flex.actual)}</td>
            </tr>
            <tr>
              <th scope="row">Non-monthly (set aside / spent)</th>
              <td className="num">{money(b.nonMonthly.budget)}</td>
              <td className="num">{money(b.nonMonthly.actual)}</td>
            </tr>
            <tr>
              <th scope="row">Moved to savings</th>
              <td className="num">{money(b.savings.planned)}</td>
              <td className="num">{money(b.savings.actual)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>2. Where the money went</h2>
        {d.topCategories.length === 0 ? (
          <p className="muted">No categorized spending this month.</p>
        ) : (
          <table className="table compact report-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="num">
                  This month
                </th>
                <th scope="col" className="num">
                  {d.averageMonths >= 12 ? "12-month average" : d.averageMonths > 0 ? `${d.averageMonths}-month average` : "Average"}
                </th>
                <th scope="col" className="num">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {d.topCategories.map((c) => (
                <tr key={c.name}>
                  <th scope="row">{c.name}</th>
                  <td className="num">{money(c.actual)}</td>
                  <td className="num">{money(c.average)}</td>
                  <td className="num">{signed(c.change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.changes.length > 0 && (
          <>
            <h3>Biggest changes</h3>
            <ul>
              {d.changes.map((c) => (
                <li key={c.name}>
                  {c.name}: {money(c.actual)}, {c.change > 0 ? `${money(c.change)} more` : `${money(-c.change)} less`} than usual
                </li>
              ))}
            </ul>
          </>
        )}
        {d.newRecurring.length > 0 && (
          <>
            <h3>New recurring charges</h3>
            <ul>
              {d.newRecurring.map((n) => (
                <li key={`${n.payee}-${n.accountName}`}>
                  {n.payee}: {money(n.amount)} {n.frequency}, from {n.accountName}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <h2>3. Net worth</h2>
        {d.netWorth ? (
          <div className="report-stats">
            <Row label="End of month" value={money(d.netWorth.end)} sub={`from ${money(d.netWorth.start)}`} />
            <Row label="Change" value={signed(d.netWorth.change)} />
            <Row label="From income minus spending" value={signed(d.netWorth.fromCashFlow)} />
            <Row label="Markets and other changes" value={signed(d.netWorth.marketAndOther)} sub="investment returns, new accounts, balance fixes" />
            {d.netWorth.debtPaidDown >= 0 ? (
              <Row label="Debt paid down" value={money(d.netWorth.debtPaidDown)} sub="part of what you saved" />
            ) : (
              <Row label="Debt went up" value={money(-d.netWorth.debtPaidDown)} sub="new borrowing or debt accounts added" />
            )}
          </div>
        ) : (
          <p className="muted">Not enough balance history for this month yet.</p>
        )}
      </section>

      <section className="panel">
        <h2>4. Goals, debt and investments</h2>
        {d.goals.length > 0 && (
          <table className="table compact report-table">
            <thead>
              <tr>
                <th scope="col">Goal</th>
                <th scope="col" className="num">
                  Saved
                </th>
                <th scope="col" className="num">
                  Target
                </th>
                <th scope="col" className="num">
                  Progress
                </th>
              </tr>
            </thead>
            <tbody>
              {d.goals.map((g) => (
                <tr key={g.name}>
                  <th scope="row">
                    {g.name}
                    {g.targetDate ? <span className="muted small"> by {g.targetDate}</span> : null}
                  </th>
                  <td className="num">{money(g.saved)}</td>
                  <td className="num">{money(g.target)}</td>
                  <td className={`num${g.status === "overdue" ? " over" : ""}`}>{Math.round(g.percent * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          Debt: <strong>{money(d.debt.total)}</strong>
          {d.debt.paidDown !== null && d.debt.paidDown > 0 ? `, ${money(d.debt.paidDown)} paid down this month` : ""}.
        </p>
        {d.drift && (
          <p>
            Investments:{" "}
            {d.drift.outOfBand
              ? `off target (${d.drift.rows
                  .filter((x) => x.status !== "in")
                  .map((x) => `${x.assetClass.replace("_", " ")} ${Math.round(x.current * 100)}% vs ${Math.round(x.target * 100)}%`)
                  .join("; ")}).`
              : "within your target mix."}
          </p>
        )}
      </section>

      <section className="panel">
        <h2>5. Retirement</h2>
        {d.retirement ? (
          <div className="report-stats">
            <Row
              label="Chance money lasts"
              value={`${Math.round(d.retirement.successRate * 100)}%`}
              sub={d.retirement.successRate >= d.retirement.target ? "on track" : `below your ${Math.round(d.retirement.target * 100)}% target`}
            />
            {d.retirement.previous && (
              <Row
                label={`Since ${monthTitle(d.retirement.previous.month)}`}
                value={`${d.retirement.successRate >= d.retirement.previous.successRate ? "+" : ""}${Math.round((d.retirement.successRate - d.retirement.previous.successRate) * 100)} points`}
                sub={`portfolio ${signed(d.retirement.portfolio - d.retirement.previous.portfolio)}`}
              />
            )}
            <Row label="Portfolio" value={money(d.retirement.portfolio)} sub={`retiring in ${d.retirement.retireYear}`} />
          </div>
        ) : (
          <p className="muted">Retirement isn't set up yet.</p>
        )}
      </section>

      <section className="panel">
        <h2>6. Next best moves</h2>
        {d.moves.length === 0 ? (
          <p className="muted">Nothing to move: every step was done or waiting for room in the budget.</p>
        ) : (
          <ol className="report-moves">
            {d.moves.map((m) => (
              <li key={m.title}>
                <strong>
                  {m.action || m.title}
                  {m.amount > 0 ? ` (${money(m.amount)}/mo)` : ""}
                </strong>
                <p className="muted small">{m.why}</p>
              </li>
            ))}
          </ol>
        )}
        {d.alerts.length > 0 && (
          <>
            <h3>Alerts</h3>
            <ul>
              {d.alerts.map((a) => (
                <li key={a.title}>
                  <strong>{a.title}.</strong> {a.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <h2>7. Data health</h2>
        <ul>
          <li>
            {d.dataHealth.uncategorized === 0
              ? "Every transaction this month is categorized."
              : `${d.dataHealth.uncategorized} uncategorized transaction${d.dataHealth.uncategorized === 1 ? "" : "s"} this month.`}
          </li>
          {d.dataHealth.stale.map((s) => (
            <li key={s}>{s}.</li>
          ))}
        </ul>
      </section>
      <p className="no-print">
        <Link to="/reports">← All reports</Link>
      </p>
    </article>
  );
}

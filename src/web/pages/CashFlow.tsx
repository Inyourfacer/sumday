import { useState } from "react";
import type { CashFlowResponse, TrendsResponse } from "../../shared/api.ts";
import { BUDGET_TYPE_LABELS } from "../../shared/schemas.ts";
import { useApi } from "../api.ts";
import { monthLabel, monthTitle, pct } from "../chartMath.ts";
import { ColumnChart } from "../components/charts.tsx";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { formatMoney } from "../format.ts";

const RANGES = [6, 12, 24] as const;

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

export function CashFlowPage() {
  const [months, setMonths] = useState<number>(12);
  const cf = useApi<CashFlowResponse>(`/api/cashflow?months=${months}`);
  const trends = useApi<TrendsResponse>(`/api/trends?months=${months}`);

  if (!cf.data) return cf.error ? <ErrorNote message={cf.error} /> : <Loading />;
  const rows = cf.data.months;
  const avg = cf.data.averages;
  const hasData = rows.some((r) => r.income !== 0 || r.spending !== 0);

  return (
    <>
      <PageHeader title="Cash flow" subtitle="Money in and out each month. Transfers between your own accounts aren't counted." />
      <div className="filters">
        <select aria-label="Range" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              Last {r} months
            </option>
          ))}
        </select>
      </div>

      {!hasData ? (
        <Empty>
          <p>No income or spending yet. Import some transactions and categorize them.</p>
        </Empty>
      ) : (
        <>
          <div className="tiles">
            <Tile label="Average income" value={formatMoney(avg.income, { cents: false })} note="per complete month" />
            <Tile label="Average spending" value={formatMoney(avg.spending, { cents: false })} note="per complete month" />
            <Tile label="Savings rate" value={pct(avg.savingsRate)} note="income kept, on average" />
            <Tile label="Moved to savings" value={formatMoney(avg.movedToSavings, { cents: false })} note="per month, into savings & investments" />
          </div>

          <section className="panel">
            <h2>Income vs spending</h2>
            <ColumnChart
              label={`Income and spending by month, last ${months} months`}
              categories={rows.map((r) => monthLabel(r.month))}
              titles={rows.map((r) => monthTitle(r.month))}
              series={[
                { name: "Income", className: "s1", values: rows.map((r) => r.income) },
                { name: "Spending", className: "s2", values: rows.map((r) => r.spending) },
              ]}
            />
          </section>

          <section className="panel tight">
            <h2>By month</h2>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Income</th>
                    <th className="num">Fixed</th>
                    <th className="num">Flex</th>
                    <th className="num">Non-monthly</th>
                    <th className="num">Uncategorized</th>
                    <th className="num">Net</th>
                    <th className="num">Savings rate</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r, i) => (
                    <tr key={r.month}>
                      <td className="nowrap">
                        {monthTitle(r.month)}
                        {i === 0 && <span className="muted small"> (so far)</span>}
                      </td>
                      <td className="num">{formatMoney(r.income, { cents: false })}</td>
                      <td className="num">{formatMoney(r.fixed, { cents: false })}</td>
                      <td className="num">{formatMoney(r.flex, { cents: false })}</td>
                      <td className="num">{formatMoney(r.nonMonthly, { cents: false })}</td>
                      <td className="num muted">{r.uncategorized ? formatMoney(r.uncategorized, { cents: false }) : "—"}</td>
                      <td className={`num ${r.net < 0 ? "negative" : ""}`}>{formatMoney(r.net, { cents: false, signed: true })}</td>
                      <td className="num">{pct(r.savingsRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {trends.data && <TrendsTable data={trends.data} />}
        </>
      )}
    </>
  );
}

function TrendsTable({ data }: { data: TrendsResponse }) {
  const groups = ["income", "fixed", "flex", "non_monthly", "uncategorized"] as const;
  return (
    <section className="panel tight">
      <h2>Trends by category</h2>
      <p className="muted small">Spending per category each month. The average leaves out the current month.</p>
      <div className="table-wrap">
        <table className="table compact trends">
          <thead>
            <tr>
              <th>Category</th>
              {data.months.map((m) => (
                <th key={m} className="num">
                  {monthLabel(m)}
                </th>
              ))}
              <th className="num">Average</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const rows = data.rows.filter((r) => r.budgetType === g);
              if (rows.length === 0) return null;
              return [
                <tr key={g} className="group-row">
                  <td colSpan={data.months.length + 2}>{g === "uncategorized" ? "Uncategorized" : BUDGET_TYPE_LABELS[g]}</td>
                </tr>,
                ...rows
                  .sort((a, b) => b.average - a.average)
                  .map((r) => (
                    <tr key={`${g}-${r.categoryId}`}>
                      <td className="nowrap">{r.name}</td>
                      {r.values.map((v, i) => (
                        <td key={data.months[i]} className="num muted-zero">
                          {v === 0 ? "–" : formatMoney(v, { cents: false })}
                        </td>
                      ))}
                      <td className="num">
                        <strong>{formatMoney(r.average, { cents: false })}</strong>
                      </td>
                    </tr>
                  )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

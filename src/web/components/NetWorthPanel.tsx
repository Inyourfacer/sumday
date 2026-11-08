import { useState } from "react";
import type { NetWorthResponse } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { monthLabel, monthTitle } from "../chartMath.ts";
import { formatMoney } from "../format.ts";
import { LineChart } from "./charts.tsx";

const RANGES = [12, 24, 60] as const;

export function NetWorthPanel() {
  const [months, setMonths] = useState<number>(24);
  const data = useApi<NetWorthResponse>(`/api/networth?months=${months}`);
  const points = data.data?.points ?? [];

  return (
    <section className="panel">
      <div className="group-head">
        <h2>Net worth over time</h2>
        <select aria-label="Net worth range" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {r === 60 ? "5 years" : `${r} months`}
            </option>
          ))}
        </select>
      </div>
      {data.data && data.data.change !== null && (
        <p className="muted small">
          {formatMoney(data.data.change, { cents: false, signed: true })} since last month
        </p>
      )}
      {points.length < 2 ? (
        <p className="muted">The chart appears once there's more than a month of balances or transactions.</p>
      ) : (
        <>
          <LineChart
            label="Net worth by month"
            points={points.map((p) => ({ key: p.month, label: monthLabel(p.month), title: monthTitle(p.month), value: p.netWorth }))}
          />
          <details className="table-toggle">
            <summary>Show as table</summary>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Assets</th>
                    <th className="num">Debts</th>
                    <th className="num">Net worth</th>
                  </tr>
                </thead>
                <tbody>
                  {[...points].reverse().map((p) => (
                    <tr key={p.month}>
                      <td>{monthTitle(p.month)}</td>
                      <td className="num">{formatMoney(p.assets, { cents: false })}</td>
                      <td className="num">{formatMoney(p.liabilities, { cents: false })}</td>
                      <td className="num">
                        <strong>{formatMoney(p.netWorth, { cents: false })}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="muted small">
            Built from transactions and the balances you've entered or imported. Accounts without a balance entry start from zero,
            so add a starting balance on each account page for accurate history.
          </p>
        </>
      )}
    </section>
  );
}

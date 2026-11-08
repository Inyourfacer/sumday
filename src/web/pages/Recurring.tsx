import { addDays, parseIsoDate } from "../../engine/dates.ts";
import type { RecurringResponse, RecurringView } from "../../shared/api.ts";
import { api, errorMessage, useApi } from "../api.ts";
import { Amount, Empty, ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { formatDate, formatMoney } from "../format.ts";
import { useState } from "react";

const FREQ = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
} as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekday(date: string): number {
  const { year, month, day } = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Five weeks starting on the Sunday of this week, with expected items per day. */
function Calendar({ data }: { data: RecurringResponse }) {
  const start = addDays(data.today, -weekday(data.today));
  const days = Array.from({ length: 35 }, (_, i) => addDays(start, i));
  const byDate = new Map<string, RecurringResponse["upcoming"]>();
  for (const u of data.upcoming) byDate.set(u.date, [...(byDate.get(u.date) ?? []), u]);
  return (
    <div className="calendar" role="grid" aria-label="Expected bills and deposits, next five weeks">
      {WEEKDAYS.map((d) => (
        <div key={d} className="cal-head" role="columnheader">
          {d}
        </div>
      ))}
      {days.map((d) => {
        const items = byDate.get(d) ?? [];
        const past = d < data.today;
        return (
          <div key={d} role="gridcell" className={`cal-day${d === data.today ? " today" : ""}${past ? " past" : ""}`}>
            <span className="cal-date">{parseIsoDate(d).day === 1 || d === start ? formatDate(d).replace(/, \d{4}$/, "") : parseIsoDate(d).day}</span>
            {items.map((u) => (
              <span key={u.key} className={`cal-item ${u.amount > 0 ? "in" : "out"}${u.isTransfer ? " transfer" : ""}`} title={`${u.payee}: ${formatMoney(u.amount)}`}>
                <span className="cal-payee">{u.payee}</span>
                <span className="cal-amount">{formatMoney(Math.abs(u.amount), { cents: false })}</span>
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function RecurringPage() {
  const data = useApi<RecurringResponse>("/api/recurring");
  const [error, setError] = useState<string>();

  if (!data.data) return data.error ? <ErrorNote message={data.error} /> : <Loading />;
  const d = data.data;
  const active = d.series.filter((s) => s.active && !s.ignored);
  const inactive = d.series.filter((s) => !s.active && !s.ignored);
  const ignored = d.series.filter((s) => s.ignored);
  const next30 = d.upcoming.filter((u) => u.date <= addDays(d.today, 30));
  // Card payments and savings moves aren't bills: the card's own charges already are.
  const out30 = next30.filter((u) => u.amount < 0 && !u.isTransfer).reduce((s, u) => s - u.amount, 0);
  const in30 = next30.filter((u) => u.amount > 0).reduce((s, u) => s + u.amount, 0);

  const toggle = async (s: RecurringView) => {
    try {
      if (s.ignored) await api("DELETE", `/api/recurring/ignore?key=${encodeURIComponent(s.key)}`);
      else await api("POST", "/api/recurring/ignore", { key: s.key });
      await data.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const table = (list: RecurringView[], action: string) => (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Payee</th>
            <th>How often</th>
            <th>Account</th>
            <th>Category</th>
            <th className="num">Amount</th>
            <th>Next</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.key}>
              <td>
                {s.payee}
                <span className="muted small block">{s.occurrences} times since {formatDate(s.firstDate)}</span>
              </td>
              <td>{FREQ[s.frequency]}</td>
              <td className="muted">{s.accountName}</td>
              <td className="muted">{s.categoryName ?? "Uncategorized"}</td>
              <td className="num">
                {s.amountVaries && <span className="muted small">about </span>}
                <Amount cents={s.amount} />
              </td>
              <td className="nowrap">{s.active ? formatDate(s.nextDate) : <span className="muted">Stopped?</span>}</td>
              <td className="num">
                <button type="button" className="link small" onClick={() => void toggle(s)}>
                  {action}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Recurring"
        subtitle="Bills, subscriptions and paychecks Sumday found in your history: the same payee, at a regular interval, for a similar amount."
      />
      <ErrorNote message={error} />
      {d.series.length === 0 ? (
        <Empty>
          <p>Nothing recurring found yet. It takes about three months of transactions to spot a monthly bill.</p>
        </Empty>
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Bills, next 30 days</span>
              <span className="tile-value">{formatMoney(out30, { cents: false })}</span>
              <span className="muted small">not counting transfers</span>
            </div>
            <div className="tile">
              <span className="tile-label">Deposits, next 30 days</span>
              <span className="tile-value">{formatMoney(in30, { cents: false })}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Active recurring</span>
              <span className="tile-value">{active.length}</span>
            </div>
          </div>
          <section className="panel">
            <h2>Calendar</h2>
            <Calendar data={d} />
          </section>
          <section className="panel tight">
            <h2>Active</h2>
            {active.length > 0 ? table(active, "Not recurring") : <p className="muted">None right now.</p>}
          </section>
          {inactive.length > 0 && (
            <section className="panel tight">
              <h2>Seem to have stopped</h2>
              <p className="muted small">Haven't shown up when expected. Worth checking if a subscription was cancelled or moved to another card.</p>
              {table(inactive, "Not recurring")}
            </section>
          )}
          {ignored.length > 0 && (
            <details className="panel tight">
              <summary>Marked not recurring ({ignored.length})</summary>
              {table(ignored, "Restore")}
            </details>
          )}
        </>
      )}
    </>
  );
}

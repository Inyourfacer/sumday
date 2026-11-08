import { addDays } from "../../engine/dates.ts";
import type { AccountView, BudgetResponse, NetWorthResponse, RecurringResponse, SummaryResponse } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { Meter } from "../components/charts.tsx";
import { Amount, PageHeader } from "../components/ui.tsx";
import { formatDate, formatMoney, plural } from "../format.ts";
import { Link } from "../router.tsx";

const LATER = [
  { title: "Next best moves", body: "Where this month's surplus should go, and the rule behind each step.", phase: 3 },
  { title: "Retirement", body: "Chance of success across 10,000 simulated futures.", phase: 5 },
] as const;

export function DashboardPage({ summary }: { summary: SummaryResponse | undefined }) {
  const accounts = useApi<AccountView[]>("/api/accounts");
  const budget = useApi<BudgetResponse>("/api/budget");
  const networth = useApi<NetWorthResponse>("/api/networth?months=2");
  const recurring = useApi<RecurringResponse>("/api/recurring");
  const b = budget.data?.budget;
  const bills = (recurring.data?.upcoming ?? []).filter((u) => u.amount < 0 && !u.isTransfer && u.date <= addDays(recurring.data!.today, 7));
  const open = (accounts.data ?? []).filter((a) => !a.isClosed);
  const netWorth = open.reduce((s, a) => s + a.balance, 0);

  const steps = summary
    ? [
        { done: summary.setupComplete && summary.setupGaps.length === 0, label: "Describe your household", to: summary.setupComplete ? "/settings/household" : "/setup" },
        { done: summary.accountCount > 0, label: "Add your accounts", to: "/accounts" },
        { done: summary.transactionCount > 0, label: "Import transactions", to: "/import" },
        {
          done: summary.transactionCount > 0 && summary.uncategorizedCount === 0,
          label: "Categorize everything",
          to: "/transactions?uncategorized=true",
        },
      ]
    : [];
  const allDone = steps.length > 0 && steps.every((s) => s.done);

  return (
    <>
      <PageHeader title="Dashboard" />

      {summary && !allDone && (
        <section className="panel">
          <h2>Getting started</h2>
          <ol className="checklist">
            {steps.map((s) => (
              <li key={s.label} className={s.done ? "done" : ""}>
                <span className="tick" aria-hidden>
                  {s.done ? "✓" : ""}
                </span>
                {s.done ? s.label : <Link to={s.to}>{s.label}</Link>}
              </li>
            ))}
          </ol>
          {summary.setupComplete && summary.setupGaps.length > 0 && (
            <div className="gaps">
              <span className="field-label">Finish setup</span>
              <ul>
                {summary.setupGaps.map((g) => (
                  <li key={g}>
                    <Link to="/settings/household">{g}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="cards">
        <article className="card live">
          <h2>Net worth</h2>
          {open.length > 0 ? (
            <>
              <p className="big">
                <Amount cents={netWorth} />
              </p>
              {networth.data?.change != null && (
                <p className="small">{formatMoney(networth.data.change, { cents: false, signed: true })} since last month</p>
              )}
              <Link to="/accounts">{plural(open.length, "account")} →</Link>
            </>
          ) : (
            <p>
              <Link to="/accounts">Add accounts</Link> to see it.
            </p>
          )}
        </article>
        <article className="card live">
          <h2>This month</h2>
          {b && b.flex.budget !== null && b.flex.left !== null ? (
            <>
              <p className="big">{formatMoney(Math.abs(b.flex.left), { cents: false })}</p>
              <p className="small">{b.flex.left < 0 ? "over the Flex budget" : "left to spend (Flex)"}</p>
              <Meter used={b.flex.actual} total={b.flex.budget} label="Flex budget used" />
              <Link to="/budget">Budget →</Link>
            </>
          ) : (
            <p>
              <Link to="/budget">Set up a budget</Link> to see what's left to spend.
            </p>
          )}
        </article>
        <article className="card live">
          <h2>Bills this week</h2>
          {bills.length > 0 ? (
            <>
              <ul className="mini-list">
                {bills.slice(0, 4).map((u) => (
                  <li key={`${u.key}-${u.date}`}>
                    <span>
                      {u.payee} <span className="muted small">{formatDate(u.date).replace(/, \d{4}$/, "")}</span>
                    </span>
                    <span>{formatMoney(-u.amount, { cents: false })}</span>
                  </li>
                ))}
              </ul>
              <Link to="/recurring">All recurring →</Link>
            </>
          ) : (
            <p>
              Nothing due in the next 7 days. <Link to="/recurring">Recurring →</Link>
            </p>
          )}
        </article>
        <article className="card live">
          <h2>Uncategorized</h2>
          <p className="big">{summary?.uncategorizedCount ?? "–"}</p>
          {summary && summary.uncategorizedCount > 0 ? (
            <Link to="/transactions?uncategorized=true">Open the inbox →</Link>
          ) : (
            <span className="muted">All caught up.</span>
          )}
        </article>
        {summary && summary.stagedImportCount > 0 && (
          <article className="card live attention">
            <h2>Imports waiting</h2>
            <p className="big">{summary.stagedImportCount}</p>
            <Link to="/import">Review and finish →</Link>
          </article>
        )}
        {LATER.map((c) => (
          <article key={c.title} className="card">
            <h2>{c.title}</h2>
            <p>{c.body}</p>
            <span className="badge-corner">Phase {c.phase}</span>
          </article>
        ))}
      </section>
    </>
  );
}

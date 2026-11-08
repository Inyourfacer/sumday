import type { AccountView, SummaryResponse } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { Amount, PageHeader } from "../components/ui.tsx";
import { plural } from "../format.ts";
import { Link } from "../router.tsx";

const LATER = [
  { title: "Next best moves", body: "Where this month's surplus should go, and the rule behind each step.", phase: 3 },
  { title: "This month", body: "Fixed bills, non-monthly set-asides and what's left in the flex pool.", phase: 2 },
  { title: "Retirement", body: "Chance of success across 10,000 simulated futures.", phase: 5 },
] as const;

export function DashboardPage({ summary }: { summary: SummaryResponse | undefined }) {
  const accounts = useApi<AccountView[]>("/api/accounts");
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
              <Link to="/accounts">{plural(open.length, "account")} →</Link>
            </>
          ) : (
            <p>
              <Link to="/accounts">Add accounts</Link> to see it.
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

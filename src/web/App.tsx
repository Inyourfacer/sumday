import { useEffect, useState } from "react";
import type { HealthResponse } from "../shared/api.ts";

type Health = { state: "loading" } | { state: "ok"; data: HealthResponse } | { state: "error"; message: string };

const SECTIONS = [
  { name: "Dashboard", phase: 0 },
  { name: "Transactions", phase: 1 },
  { name: "Budget", phase: 2 },
  { name: "Goals", phase: 3 },
  { name: "Debt", phase: 3 },
  { name: "Investments", phase: 4 },
  { name: "Retirement", phase: 5 },
  { name: "Scenarios", phase: 6 },
  { name: "Settings", phase: 1 },
] as const;

const CARDS = [
  {
    title: "Next best moves",
    body: "Where this month's surplus should go, and the rule behind each step.",
    phase: 3,
  },
  { title: "This month", body: "Fixed bills, non-monthly set-asides and what's left in the flex pool.", phase: 2 },
  { title: "Net worth", body: "Assets minus debts, over time.", phase: 2 },
  { title: "Retirement", body: "Chance of success across 10,000 simulated futures.", phase: 5 },
] as const;

function useHealth(): Health {
  const [health, setHealth] = useState<Health>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(async (res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return (await res.json()) as HealthResponse;
      })
      .then((data) => !cancelled && setHealth({ state: "ok", data }))
      .catch((err: unknown) => {
        if (!cancelled) setHealth({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return health;
}

export function App() {
  const health = useHealth();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Sum<span>day</span>
        </div>
        <nav aria-label="Sections">
          {SECTIONS.map((s) => (
            <a
              key={s.name}
              href="#"
              className={s.phase === 0 ? "active" : "soon"}
              aria-current={s.phase === 0 ? "page" : undefined}
              aria-disabled={s.phase === 0 ? undefined : true}
              title={s.phase === 0 ? undefined : `Coming in Phase ${s.phase}`}
              onClick={(e) => e.preventDefault()}
            >
              {s.name}
              {s.phase > 0 && <small>P{s.phase}</small>}
            </a>
          ))}
        </nav>
      </aside>

      <main>
        <header>
          <h1>Dashboard</h1>
          <p className="lede">Nothing here yet. Add your household and import some transactions to get started.</p>
        </header>

        <section className="cards">
          {CARDS.map((c) => (
            <article key={c.title} className="card">
              <h2>{c.title}</h2>
              <p>{c.body}</p>
              <span className="badge">Phase {c.phase}</span>
            </article>
          ))}
        </section>

        <footer className="status" role="status">
          {health.state === "loading" && "Connecting to the local server…"}
          {health.state === "ok" && (
            <>
              <span className="dot ok" aria-hidden /> Local server v{health.data.version} · database schema v
              {health.data.schemaVersion} · {health.data.setupComplete ? "setup complete" : "setup not started"}
            </>
          )}
          {health.state === "error" && (
            <>
              <span className="dot err" aria-hidden /> Can't reach the local server ({health.message}). Is{" "}
              <code>npm start</code> running?
            </>
          )}
        </footer>
      </main>
    </div>
  );
}

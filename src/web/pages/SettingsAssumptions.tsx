import type { AssumptionRow, AssumptionsResponse } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { Link } from "../router.tsx";

const SOURCE_LABEL: Record<AssumptionRow["source"], string> = {
  you: "You entered",
  default: "Starting value",
  estimated: "Worked out from your data",
  guess: "Inferred",
  missing: "Needed",
};

export function SettingsAssumptionsPage() {
  const data = useApi<AssumptionsResponse>("/api/assumptions");
  if (!data.data) return data.error ? <ErrorNote message={data.error} /> : <Loading />;
  const { rows, sensitivity } = data.data;
  const areas = [...new Set(rows.map((r) => r.area))];
  const biggest = Math.max(1, ...sensitivity.map((s) => Math.abs(s.successPoints)));
  const needed = rows.filter((r) => r.source === "missing").length;

  return (
    <>
      <PageHeader
        title="Assumptions"
        subtitle="Everything the recommendations rest on, where each value came from, and which ones the retirement answer depends on most."
      />
      {needed > 0 && (
        <div className="note" role="status">
          {needed} item{needed === 1 ? " is" : "s are"} missing. Recommendations that need {needed === 1 ? "it" : "them"} are skipped or rough until you fill {needed === 1 ? "it" : "them"} in.
        </div>
      )}

      {sensitivity.length > 0 && (
        <section className="panel">
          <h2>What moves the retirement answer</h2>
          <p className="muted small">Change in the chance your money lasts, in points, when one thing changes and everything else stays. Spend your attention on the top rows.</p>
          <ul className="tornado">
            {sensitivity.map((s) => (
              <li key={s.label}>
                <span>{s.label}</span>
                <span className="bar-track" role="img" aria-label={`${s.label}: ${s.successPoints >= 0 ? "+" : ""}${s.successPoints} points`}>
                  <span className="mid" />
                  <span className={`bar ${s.successPoints >= 0 ? "up" : "down"}`} style={{ width: `${(Math.abs(s.successPoints) / biggest) * 50}%` }} />
                </span>
                <span className="num">
                  {s.successPoints >= 0 ? "+" : ""}
                  {s.successPoints} pts
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {areas.map((area) => (
        <section className="panel tight" key={area}>
          <h2>{area}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Assumption</th>
                  <th>Value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => r.area === area)
                  .map((r) => (
                    <tr key={r.label}>
                      <td>
                        <Link to={r.link}>{r.label}</Link>
                        {r.note && <div className="muted small">{r.note}</div>}
                      </td>
                      <td>{r.value}</td>
                      <td>
                        <span className={`src ${r.source}`}>{SOURCE_LABEL[r.source]}</span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

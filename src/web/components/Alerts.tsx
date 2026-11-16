import { useState } from "react";
import type { AlertsResponse } from "../../shared/api.ts";
import { api, errorMessage, useApi } from "../api.ts";
import { Link } from "../router.tsx";
import { ErrorNote } from "./ui.tsx";

/** Alerts on the dashboard, with dismiss. */
export function AlertsPanel() {
  const loaded = useApi<AlertsResponse>("/api/alerts");
  const [data, setData] = useState<AlertsResponse>();
  const [error, setError] = useState<string>();
  const view = data ?? loaded.data;
  if (!view) return null;

  const dismiss = async (key: string) => {
    try {
      setData(await api<AlertsResponse>("POST", "/api/alerts/dismiss", { key }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const restore = async () => setData(await api<AlertsResponse>("POST", "/api/alerts/restore"));

  if (view.alerts.length === 0 && view.dismissedCount === 0) return null;
  return (
    <section className="panel alerts" aria-labelledby="alerts-head">
      <div className="group-head">
        <h2 id="alerts-head">Alerts</h2>
        <Link to="/settings/alerts">Thresholds →</Link>
      </div>
      {view.alerts.length === 0 ? (
        <p className="muted">Nothing needs a look right now.</p>
      ) : (
        <ul className="alert-list">
          {view.alerts.map((a) => (
            <li key={a.key} className={`alert ${a.severity}`}>
              <span className="alert-icon" aria-hidden>
                {a.severity === "warning" ? "!" : "i"}
              </span>
              <div>
                <strong>{a.link ? <Link to={a.link}>{a.title}</Link> : a.title}</strong>
                <p>{a.message}</p>
              </div>
              <button type="button" className="link" onClick={() => void dismiss(a.key)} aria-label={`Dismiss: ${a.title}`}>
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.dismissedCount > 0 && (
        <button type="button" className="link small" onClick={() => void restore()}>
          Show {view.dismissedCount} dismissed
        </button>
      )}
      <ErrorNote message={error} />
    </section>
  );
}

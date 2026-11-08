import { useState } from "react";
import type { BackupsResponse } from "../../shared/api.ts";
import { api, errorMessage, useApi } from "../api.ts";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui.tsx";

const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function SettingsDataPage() {
  const backups = useApi<BackupsResponse>("/api/backups");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const b = backups.data;

  const backupNow = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/backups");
      await backups.reload();
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Your data" subtitle="Everything lives in one SQLite file on this computer. Back it up, or take it with you." />
      <section className="panel">
        <div className="group-head">
          <h2>Backups</h2>
          <button type="button" onClick={() => void backupNow()} disabled={busy || !b?.dir}>
            {busy ? "Backing up…" : "Back up now"}
          </button>
        </div>
        {!b ? (
          <Loading />
        ) : !b.dir ? (
          <p className="muted">Backups are off for this database.</p>
        ) : (
          <>
            <p className="muted small">
              Sumday makes a backup every day it runs and keeps the newest {b.keep}, in <code>{b.dir}</code>. To restore one, stop Sumday and copy it
              over your database file.
            </p>
            {b.backups.length === 0 ? (
              <Empty>No backups yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Made</th>
                      <th scope="col" className="num">
                        Size
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.backups.map((x) => (
                      <tr key={x.name}>
                        <td>
                          <code>{x.name}</code>
                        </td>
                        <td>{new Date(x.createdAt).toLocaleString()}</td>
                        <td className="num">{size(x.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <ErrorNote message={error} />
      </section>
      <section className="panel">
        <h2>Export</h2>
        <ul className="export-links">
          <li>
            <a href="/api/export/transactions.csv" download>
              Transactions (CSV)
            </a>
            <span className="muted small">Every posted transaction with account, category and notes. Opens in any spreadsheet.</span>
          </li>
          <li>
            <a href="/api/export/json" download>
              Everything (JSON)
            </a>
            <span className="muted small">Accounts, balances, transactions, budgets, goals, holdings, settings, scenarios and reports. Amounts in cents.</span>
          </li>
        </ul>
      </section>
    </>
  );
}

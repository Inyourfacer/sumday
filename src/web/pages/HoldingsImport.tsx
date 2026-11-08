import { useState } from "react";
import { applyHoldingsMapping, type HoldingsMapping } from "../../engine/invest/positions.ts";
import type { AccountView, HoldingsImportResult, HoldingsInspectResult } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { Empty, ErrorNote, Field, Loading, PageHeader } from "../components/ui.tsx";
import { formatMoney } from "../format.ts";
import { useLocation } from "../navigation.ts";
import { Link } from "../router.tsx";

const TYPES = ["brokerage", "401k", "403b", "457", "ira", "roth_ira", "hsa", "529"];

const FIELDS: { key: keyof HoldingsMapping; label: string; optional: boolean }[] = [
  { key: "symbolColumn", label: "Symbol / ticker", optional: true },
  { key: "nameColumn", label: "Description / fund name", optional: true },
  { key: "quantityColumn", label: "Quantity / shares", optional: false },
  { key: "priceColumn", label: "Price", optional: true },
  { key: "valueColumn", label: "Value", optional: true },
  { key: "costBasisColumn", label: "Cost basis", optional: true },
];

export function HoldingsImportPage() {
  const { query } = useLocation();
  const accounts = useApi<AccountView[]>("/api/accounts");
  const [accountId, setAccountId] = useState(query.get("accountId") ?? "");
  const [file, setFile] = useState<{ name: string; content: string }>();
  const [inspected, setInspected] = useState<HoldingsInspectResult>();
  const [mapping, setMapping] = useState<HoldingsMapping>();
  const [result, setResult] = useState<HoldingsImportResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!accounts.data) return accounts.error ? <ErrorNote message={accounts.error} /> : <Loading />;
  const eligible = accounts.data.filter((a) => TYPES.includes(a.type) && !a.isClosed);
  const selected = accountId || (eligible.length === 1 ? String(eligible[0]!.id) : "");

  const inspect = async (f: { name: string; content: string }, account: string) => {
    setInspected(undefined);
    setResult(undefined);
    setError(undefined);
    if (!account) return;
    try {
      const r = await api<HoldingsInspectResult>("POST", "/api/holdings/import/inspect", { accountId: Number(account), fileName: f.name, content: f.content });
      setInspected(r);
      setMapping(r.mapping ?? { hasHeader: true, quantityColumn: 0 });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const run = async () => {
    if (!file || !mapping) return;
    setBusy(true);
    try {
      setResult(await api<HoldingsImportResult>("POST", "/api/holdings/import", { accountId: Number(selected), fileName: file.name, content: file.content, mapping }));
      notifyDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = inspected?.sampleRows ?? [];
  const width = Math.max(0, ...rows.map((r) => r.length));
  // With a header row, show the file's own column names; otherwise number them.
  const headerRow =
    mapping?.hasHeader && mapping.symbolColumn === undefined
      ? rows[0]
      : mapping?.hasHeader
        ? rows.find((r) => /symbol|ticker/i.test(r[mapping.symbolColumn!] ?? ""))
        : undefined;
  const columns = Array.from({ length: width }, (_, i) => headerRow?.[i]?.trim() || inspected?.columns[i] || `Column ${i + 1}`);
  const preview = mapping && inspected ? applyHoldingsMapping(rows, mapping) : undefined;

  return (
    <>
      <PageHeader
        title="Import positions"
        subtitle="Download your current positions (holdings) as a CSV from your brokerage or 401(k) website. The file replaces this account's holdings: anything not in it is treated as sold."
      />
      {eligible.length === 0 ? (
        <Empty>
          <p>
            Add a brokerage, retirement or HSA account first. <Link to="/accounts">Accounts</Link>
          </p>
        </Empty>
      ) : (
        <section className="panel">
          <div className="form-grid">
            <Field label="Account">
              <select
                value={selected}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  if (file) void inspect(file, e.target.value);
                }}
              >
                <option value="">Choose an account…</option>
                {eligible.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Positions file" hint="CSV">
              <input
                type="file"
                accept=".csv,text/csv,.txt"
                disabled={!selected}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const next = { name: f.name, content: await f.text() };
                  setFile(next);
                  await inspect(next, selected);
                }}
              />
            </Field>
          </div>

          {inspected && mapping && (
            <>
              <h3>Columns</h3>
              {inspected.mappingSource === "saved" && <p className="muted small">Using the mapping saved for this account.</p>}
              {inspected.notes.map((n) => (
                <div className="note" key={n}>
                  {n}
                </div>
              ))}
              <div className="form-grid">
                <label className="check wide">
                  <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => setMapping({ ...mapping, hasHeader: e.target.checked })} />
                  First row is column names
                </label>
                {FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <select
                      value={(mapping[f.key] as number | undefined) ?? ""}
                      onChange={(e) => {
                        const next = { ...mapping } as Record<string, unknown>;
                        if (e.target.value === "") delete next[f.key];
                        else next[f.key] = Number(e.target.value);
                        setMapping(next as unknown as HoldingsMapping);
                      }}
                    >
                      {f.optional && <option value="">None</option>}
                      {columns.map((c, i) => (
                        <option key={i} value={i}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>

              <h4>Preview</h4>
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Name</th>
                      <th className="num">Shares</th>
                      <th className="num">Price</th>
                      <th className="num">Value</th>
                      <th className="num">Cost basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview?.positions.map((p) => (
                      <tr key={p.line}>
                        <td>{p.ticker ?? <span className="muted">none</span>}</td>
                        <td>{p.name}</td>
                        <td className="num">{p.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                        <td className="num">{p.price === null ? "—" : `$${p.price.toFixed(2)}`}</td>
                        <td className="num">{p.value === null ? "—" : formatMoney(p.value)}</td>
                        <td className="num">{p.costBasis === null ? "—" : formatMoney(p.costBasis)}</td>
                      </tr>
                    ))}
                    {preview?.skipped.map((s) => (
                      <tr key={`s${s.line}`} className="error-row">
                        <td colSpan={6}>
                          Line {s.line}: {s.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ErrorNote message={error} />
              <div className="row end">
                <button type="button" onClick={() => void run()} disabled={busy || !preview?.positions.length}>
                  Replace holdings with these {preview?.positions.length ?? 0}
                </button>
              </div>
            </>
          )}
          {!inspected && <ErrorNote message={error} />}
          {result && (
            <div className="note ok">
              Done: {result.added} added, {result.updated} updated, {result.removed} removed. Account value{" "}
              {formatMoney(result.value, { cents: false })}. <Link to="/investments">See Investments →</Link>
            </div>
          )}
        </section>
      )}
    </>
  );
}

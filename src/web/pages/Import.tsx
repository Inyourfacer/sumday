import { useState } from "react";
import { applyMapping, type CsvMapping } from "../../engine/import/mapping.ts";
import type { AccountView, ImportBatchDetail, ImportBatchView, ImportInspectResult } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { Amount, Empty, ErrorNote, Field, Loading, PageHeader } from "../components/ui.tsx";
import { formatDate, plural } from "../format.ts";
import { Link } from "../router.tsx";
import { navigate, useLocation } from "../navigation.ts";

const DATE_ORDER_LABELS = { MDY: "Month/Day/Year", DMY: "Day/Month/Year", YMD: "Year-Month-Day" } as const;

const STATUS_LABELS: Record<ImportBatchView["status"], string> = {
  staged: "Waiting for review",
  committed: "Imported",
  undone: "Undone",
  discarded: "Discarded",
};

function emptyMapping(): CsvMapping {
  return { hasHeader: true, dateColumn: 0, dateOrder: "MDY", payeeColumn: 1, amount: { mode: "single", column: 2, negate: false } };
}

function ColumnSelect({
  label,
  columns,
  value,
  onChange,
  optional,
}: {
  label: string;
  columns: string[];
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  optional?: boolean;
}) {
  return (
    <Field label={label}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}>
        {optional && <option value="">None</option>}
        {columns.map((c, i) => (
          <option key={i} value={i}>
            {c}
          </option>
        ))}
      </select>
    </Field>
  );
}

function MappingEditor({
  inspected,
  mapping,
  onChange,
}: {
  inspected: ImportInspectResult;
  mapping: CsvMapping;
  onChange: (m: CsvMapping) => void;
}) {
  const rows = inspected.sampleRows ?? [];
  const width = Math.max(0, ...rows.map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) =>
    mapping.hasHeader && rows[0]?.[i]?.trim() ? rows[0][i]!.trim() : `Column ${i + 1}`,
  );
  const preview = applyMapping(rows, mapping);
  const amount = mapping.amount;

  return (
    <div className="stack">
      <div className="form-grid">
        <label className="check">
          <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => onChange({ ...mapping, hasHeader: e.target.checked })} />
          First row is column names
        </label>
        <ColumnSelect label="Date column" columns={columns} value={mapping.dateColumn} onChange={(v) => onChange({ ...mapping, dateColumn: v ?? 0 })} />
        <Field label="Date format">
          <select value={mapping.dateOrder} onChange={(e) => onChange({ ...mapping, dateOrder: e.target.value as CsvMapping["dateOrder"] })}>
            {Object.entries(DATE_ORDER_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <ColumnSelect label="Description column" columns={columns} value={mapping.payeeColumn} onChange={(v) => onChange({ ...mapping, payeeColumn: v ?? 0 })} />
        <ColumnSelect
          label="Memo column"
          optional
          columns={columns}
          value={mapping.memoColumn}
          onChange={(v) => {
            const { memoColumn: _drop, ...rest } = mapping;
            onChange(v === undefined ? rest : { ...mapping, memoColumn: v });
          }}
        />
        <Field label="Amounts are in">
          <select
            value={amount.mode}
            onChange={(e) =>
              onChange({
                ...mapping,
                amount:
                  e.target.value === "single"
                    ? { mode: "single", column: 0, negate: false }
                    : { mode: "debitCredit", debitColumn: 0, creditColumn: Math.min(1, width - 1) },
              })
            }
          >
            <option value="single">One column (+/−)</option>
            <option value="debitCredit">Separate debit and credit columns</option>
          </select>
        </Field>
        {amount.mode === "single" ? (
          <>
            <ColumnSelect label="Amount column" columns={columns} value={amount.column} onChange={(v) => onChange({ ...mapping, amount: { ...amount, column: v ?? 0 } })} />
            <label className="check">
              <input type="checkbox" checked={amount.negate} onChange={(e) => onChange({ ...mapping, amount: { ...amount, negate: e.target.checked } })} />
              Purchases show as positive (flip signs)
            </label>
          </>
        ) : (
          <>
            <ColumnSelect label="Debit (money out)" columns={columns} value={amount.debitColumn} onChange={(v) => onChange({ ...mapping, amount: { ...amount, debitColumn: v ?? 0 } })} />
            <ColumnSelect label="Credit (money in)" columns={columns} value={amount.creditColumn} onChange={(v) => onChange({ ...mapping, amount: { ...amount, creditColumn: v ?? 0 } })} />
          </>
        )}
      </div>

      <h4>Preview</h4>
      <p className="muted small">Check that dates look right and that purchases are negative (money out).</p>
      <div className="table-wrap">
<table className="table compact">
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((r) => (
            <tr key={r.line}>
              <td>{formatDate(r.date)}</td>
              <td>{r.payee}</td>
              <td className="num">
                <Amount cents={r.amount} />
              </td>
            </tr>
          ))}
          {preview.errors.map((e) => (
            <tr key={`e${e.line}`} className="error-row">
              <td colSpan={3}>
                Line {e.line}: {e.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
</div>
    </div>
  );
}

export function ImportPage() {
  const { query } = useLocation();
  const accounts = useApi<AccountView[]>("/api/accounts");
  const history = useApi<ImportBatchView[]>("/api/imports");
  const [accountId, setAccountId] = useState<string>(query.get("accountId") ?? "");
  const [file, setFile] = useState<{ name: string; content: string }>();
  const [inspected, setInspected] = useState<ImportInspectResult>();
  const [mapping, setMapping] = useState<CsvMapping>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const accts = (accounts.data ?? []).filter((a) => !a.isClosed);
  const selectedAccount = accountId || (accts.length === 1 ? String(accts[0]!.id) : "");

  const inspect = async (target: { name: string; content: string }, account: string) => {
    setInspected(undefined);
    setMapping(undefined);
    setError(undefined);
    if (!account) return;
    try {
      const result = await api<ImportInspectResult>("POST", "/api/imports/inspect", {
        accountId: Number(account),
        fileName: target.name,
        content: target.content,
      });
      setInspected(result);
      setMapping(result.mapping ?? (result.format === "csv" ? emptyMapping() : undefined));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const next = { name: f.name, content: await f.text() };
    setFile(next);
    await inspect(next, selectedAccount);
  };

  const stage = async () => {
    if (!file || !selectedAccount) return;
    setBusy(true);
    try {
      const batch = await api<ImportBatchDetail>("POST", "/api/imports", {
        accountId: Number(selectedAccount),
        fileName: file.name,
        content: file.content,
        ...(inspected?.format === "csv" && mapping ? { mapping } : {}),
      });
      notifyDataChanged();
      navigate(`/import/${batch.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (batch: ImportBatchView) => {
    if (!window.confirm(`Undo the import of ${batch.fileName}? Its ${plural(batch.newCount, "transaction")} will be removed.`)) return;
    await api("POST", `/api/imports/${batch.id}/undo`);
    notifyDataChanged();
    await history.reload();
  };

  if (accounts.loading && !accounts.data) return <Loading />;

  return (
    <>
      <PageHeader
        title="Import transactions"
        subtitle="Download a CSV, OFX or QFX file from your bank's website and bring it in here. Nothing is saved until you review it."
      />

      {accts.length === 0 ? (
        <Empty>
          <p>
            Add the account first, so Sumday knows where the transactions belong. <Link to="/accounts">Add an account</Link>
          </p>
        </Empty>
      ) : (
        <section className="panel">
          <div className="form-grid">
            <Field label="Account">
              <select
                value={selectedAccount}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  if (file) void inspect(file, e.target.value);
                }}
              >
                <option value="">Choose an account…</option>
                {accts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="File" hint="CSV, OFX or QFX">
              <input
                type="file"
                accept=".csv,.ofx,.qfx,.txt,text/csv"
                disabled={!selectedAccount}
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </Field>
          </div>

          {inspected?.format === "ofx" && inspected.ofx && (
            <div className="note">
              Found {plural(inspected.ofx.transactionCount, "transaction")}
              {inspected.ofx.accountIdLast4 && <> for the account ending in {inspected.ofx.accountIdLast4}</>}.
              {inspected.ofx.ledgerBalance && (
                <>
                  {" "}
                  Statement balance <Amount cents={inspected.ofx.ledgerBalance.amount} /> on {formatDate(inspected.ofx.ledgerBalance.date)}.
                </>
              )}
            </div>
          )}

          {inspected?.format === "csv" && mapping && (
            <>
              <h3>Columns</h3>
              {inspected.mappingSource === "saved" && <p className="muted small">Using the column mapping saved for this account.</p>}
              {inspected.mappingSource === "suggested" && <p className="muted small">Sumday guessed the columns. Check the preview below.</p>}
              {inspected.notes?.map((n) => (
                <div key={n} className="note">
                  {n}
                </div>
              ))}
              <MappingEditor inspected={inspected} mapping={mapping} onChange={setMapping} />
            </>
          )}

          <ErrorNote message={error} />
          {inspected && (
            <div className="row end">
              <button type="button" onClick={() => void stage()} disabled={busy}>
                Review transactions
              </button>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Import history</h2>
        {history.data && history.data.length === 0 && <p className="muted">No imports yet.</p>}
        {history.data && history.data.length > 0 && (
          <div className="table-wrap">
<table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Account</th>
                <th>File</th>
                <th>Status</th>
                <th className="num">New</th>
                <th className="num">Skipped</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.data.map((b) => (
                <tr key={b.id}>
                  <td className="nowrap">{formatDate(b.createdAt)}</td>
                  <td>{b.accountName}</td>
                  <td>
                    <Link to={`/import/${b.id}`}>{b.fileName}</Link>
                  </td>
                  <td>{STATUS_LABELS[b.status]}</td>
                  <td className="num">{b.newCount}</td>
                  <td className="num">{b.duplicateCount}</td>
                  <td className="num">
                    {b.status === "committed" && (
                      <button type="button" className="link danger" onClick={() => void undo(b)}>
                        Undo
                      </button>
                    )}
                    {b.status === "staged" && <Link to={`/import/${b.id}`}>Review</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </section>
    </>
  );
}

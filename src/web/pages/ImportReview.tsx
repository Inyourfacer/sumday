import { useState } from "react";
import type { AccountView, CategoryView, ImportBatchDetail, RuleSuggestion } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged, useApi, changeCategory } from "../api.ts";
import { RuleSuggestionBar } from "../components/RuleForm.tsx";
import { TransactionModal, TransactionTable } from "../components/TransactionTable.tsx";
import { Amount, ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { formatDate, plural } from "../format.ts";
import { Link } from "../router.tsx";
import { navigate } from "../navigation.ts";
import type { TransactionView } from "../../shared/api.ts";

export function ImportReviewPage({ id }: { id: number }) {
  const batch = useApi<ImportBatchDetail>(`/api/imports/${id}`);
  const categories = useApi<CategoryView[]>("/api/categories");
  const accounts = useApi<AccountView[]>("/api/accounts");
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null);
  const [open, setOpen] = useState<TransactionView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!batch.data) return batch.error ? <ErrorNote message={batch.error} /> : <Loading />;
  const b = batch.data;
  const txns = b.transactions;
  const transfers = txns.filter((t) => t.transferId !== null).length;
  const uncategorized = txns.filter((t) => t.categoryId === null).length;
  const cats = categories.data ?? [];

  const run = async (action: "commit" | "discard" | "undo") => {
    setBusy(true);
    setError(undefined);
    try {
      await api("POST", `/api/imports/${id}/${action}`);
      notifyDataChanged();
      if (action === "discard") navigate("/import");
      else await batch.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onCategoryChange = async (txn: TransactionView, categoryId: number | null) => {
    try {
      const result = await changeCategory(txn, categoryId);
      setSuggestion(result.suggestion);
      await batch.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title={b.status === "staged" ? "Review import" : "Import"}
        subtitle={
          <>
            {b.fileName} → <Link to={`/accounts/${b.accountId}`}>{b.accountName}</Link> · {formatDate(b.createdAt)}
          </>
        }
        actions={
          b.status === "staged" ? (
            <>
              <button type="button" className="secondary" disabled={busy} onClick={() => void run("discard")}>
                Discard
              </button>
              <button type="button" disabled={busy} onClick={() => void run("commit")}>
                {b.newCount > 0 ? `Add ${plural(b.newCount, "transaction")}` : "Finish import"}
              </button>
            </>
          ) : b.status === "committed" ? (
            <button
              type="button"
              className="secondary danger"
              disabled={busy}
              onClick={() => window.confirm("Remove every transaction this import added?") && void run("undo")}
            >
              Undo import
            </button>
          ) : undefined
        }
      />

      {b.status === "committed" && (
        <div className="note ok">
          Imported {plural(b.newCount, "transaction")}.{" "}
          {uncategorized > 0 ? (
            <Link to="/transactions?uncategorized=true">Categorize the {uncategorized} left in the inbox →</Link>
          ) : (
            <Link to={`/transactions?accountId=${b.accountId}`}>See them in Transactions →</Link>
          )}
        </div>
      )}
      {(b.status === "undone" || b.status === "discarded") && <div className="note">This import was {b.status}.</div>}

      <div className="chips">
        <span className="chip">{plural(b.newCount, "new transaction")}</span>
        <span className="chip">{b.duplicateCount} already imported (skipped)</span>
        {b.errors.length > 0 && <span className="chip warn">{b.errors.length} couldn't be read</span>}
        {transfers > 0 && <span className="chip">{plural(transfers, "transfer")} matched</span>}
        {b.status === "staged" && uncategorized > 0 && <span className="chip warn">{uncategorized} uncategorized</span>}
        {b.ledgerBalance && (
          <span className="chip">
            Statement balance <Amount cents={b.ledgerBalance.amount} /> on {formatDate(b.ledgerBalance.date)}
          </span>
        )}
      </div>
      {b.sameFileImportedBefore && <div className="note">This exact file was imported before. Rows already in Sumday were skipped.</div>}
      {b.errors.length > 0 && (
        <details className="panel tight">
          <summary>Rows that couldn't be read</summary>
          <ul className="small">
            {b.errors.map((e) => (
              <li key={e.line}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {suggestion && (
        <RuleSuggestionBar
          suggestion={suggestion}
          categories={cats}
          accounts={accounts.data ?? []}
          onDone={() => {
            setSuggestion(null);
            void batch.reload();
          }}
        />
      )}
      <ErrorNote message={error} />

      {txns.length > 0 ? (
        <TransactionTable
          items={txns}
          categories={cats}
          showAccount={false}
          onCategoryChange={(t, cid) => void onCategoryChange(t, cid)}
          onOpen={setOpen}
        />
      ) : (
        b.status === "staged" && <p className="muted">Nothing new in this file. Finish the import to record the statement balance, or discard it.</p>
      )}

      {open && (
        <TransactionModal
          txn={open}
          categories={cats}
          onClose={() => setOpen(undefined)}
          onChanged={(result) => {
            setOpen(undefined);
            if (result?.suggestion) setSuggestion(result.suggestion);
            void batch.reload();
          }}
        />
      )}
    </>
  );
}

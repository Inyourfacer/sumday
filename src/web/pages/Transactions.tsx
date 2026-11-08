import { useEffect, useState } from "react";
import type { AccountView, CategoryView, RuleSuggestion, TransactionList, TransactionView } from "../../shared/api.ts";
import { errorMessage, useApi, changeCategory } from "../api.ts";
import { RuleSuggestionBar } from "../components/RuleForm.tsx";
import { NewTransactionModal, TransactionModal, TransactionTable } from "../components/TransactionTable.tsx";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui.tsx";
import { plural } from "../format.ts";
import { Link } from "../router.tsx";
import { useLocation } from "../navigation.ts";

const PAGE = 100;

/** Remounts when the URL's query changes, so links like ?uncategorized=true reset the filters. */
export function TransactionsPage() {
  const { search } = useLocation();
  return <TransactionsView key={search} query={new URLSearchParams(search)} />;
}

function TransactionsView({ query }: { query: URLSearchParams }) {
  const accounts = useApi<AccountView[]>("/api/accounts");
  const categories = useApi<CategoryView[]>("/api/categories");

  const [accountId, setAccountId] = useState(query.get("accountId") ?? "");
  const [category, setCategory] = useState(query.get("uncategorized") === "true" ? "none" : (query.get("categoryId") ?? ""));
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [from, setFrom] = useState(query.get("from") ?? "");
  const [to, setTo] = useState(query.get("to") ?? "");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<TransactionView>();
  const [adding, setAdding] = useState(false);
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({ limit: String(limit) });
  if (accountId) params.set("accountId", accountId);
  if (category === "none") params.set("uncategorized", "true");
  else if (category) params.set("categoryId", category);
  if (debounced) params.set("search", debounced);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const list = useApi<TransactionList>(`/api/transactions?${params}`);

  const cats = categories.data ?? [];
  const accts = accounts.data ?? [];

  const onCategoryChange = async (txn: TransactionView, categoryId: number | null) => {
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await changeCategory(txn, categoryId);
      setSuggestion(result.suggestion);
      await list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const inbox = category === "none";

  return (
    <>
      <PageHeader
        title={inbox ? "Uncategorized inbox" : "Transactions"}
        subtitle={list.data ? plural(list.data.total, "transaction") : undefined}
        actions={
          <>
            <Link to="/import" className="button secondary">
              Import
            </Link>
            <button type="button" onClick={() => setAdding(true)} disabled={accts.length === 0}>
              Add transaction
            </button>
          </>
        }
      />

      <div className="filters">
        <select aria-label="Account" value={accountId} onChange={(e) => (setAccountId(e.target.value), setLimit(PAGE))}>
          <option value="">All accounts</option>
          {accts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select aria-label="Category filter" value={category} onChange={(e) => (setCategory(e.target.value), setLimit(PAGE))}>
          <option value="">All categories</option>
          <option value="none">Uncategorized only</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Search" placeholder="Search payee, memo, notes" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {suggestion && (
        <RuleSuggestionBar
          suggestion={suggestion}
          categories={cats}
          accounts={accts}
          onDone={(changed) => {
            setSuggestion(null);
            if (changed !== null) setMessage(`Rule created. ${plural(changed, "transaction")} updated.`);
            void list.reload();
          }}
        />
      )}
      {message && <div className="note ok">{message}</div>}
      <ErrorNote message={error ?? list.error} />

      {list.loading && !list.data && <Loading />}
      {list.data && list.data.total === 0 && (
        <Empty>
          {inbox ? (
            <p>Nothing to categorize. Nice.</p>
          ) : accts.length === 0 ? (
            <p>
              Add an account first, then <Link to="/import">import</Link> a CSV or OFX file from your bank.
            </p>
          ) : (
            <p>
              No transactions match. <Link to="/import">Import a file</Link> or add one by hand.
            </p>
          )}
        </Empty>
      )}
      {list.data && list.data.items.length > 0 && (
        <>
          <TransactionTable items={list.data.items} categories={cats} onCategoryChange={(t, id) => void onCategoryChange(t, id)} onOpen={setOpen} />
          {list.data.items.length < list.data.total && (
            <div className="center">
              <button type="button" className="secondary" onClick={() => setLimit(limit + PAGE)}>
                Show more ({plural(list.data.total - list.data.items.length, "more transaction")})
              </button>
            </div>
          )}
        </>
      )}

      {open && (
        <TransactionModal
          txn={open}
          categories={cats}
          onClose={() => setOpen(undefined)}
          onChanged={(result) => {
            setOpen(undefined);
            if (result?.suggestion) setSuggestion(result.suggestion);
            void list.reload();
          }}
        />
      )}
      {adding && (
        <NewTransactionModal
          accounts={accts}
          categories={cats}
          defaultAccountId={accountId ? Number(accountId) : undefined}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

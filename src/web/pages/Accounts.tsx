import { useState } from "react";
import type { AccountView, BalanceSnapshotView, HouseholdResponse } from "../../shared/api.ts";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  LIABILITY_TYPES,
  TAX_TREATMENTS,
  defaultTaxTreatment,
  type AccountType,
  type TaxTreatment,
} from "../../shared/schemas.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { Amount, Empty, ErrorNote, Field, Loading, Modal, MoneyInput, NumberInput, PageHeader } from "../components/ui.tsx";
import { formatDate, plural, todayLocal } from "../format.ts";
import { Link } from "../router.tsx";
import { navigate } from "../navigation.ts";

const GROUPS: { title: string; types: AccountType[] }[] = [
  { title: "Cash", types: ["checking", "savings"] },
  { title: "Credit cards", types: ["credit_card"] },
  { title: "Investments", types: ["brokerage", "529"] },
  { title: "Retirement", types: ["401k", "403b", "457", "ira", "roth_ira", "hsa"] },
  { title: "Loans", types: ["loan", "mortgage", "other_liability"] },
  { title: "Property & other", types: ["property", "other_asset"] },
];

const TAX_LABELS: Record<TaxTreatment, string> = {
  taxable: "Taxable",
  traditional: "Pre-tax (traditional)",
  roth: "Roth",
  hsa: "HSA",
};

const INVESTMENT_TYPES: AccountType[] = ["brokerage", "529", "401k", "403b", "457", "ira", "roth_ira", "hsa"];

interface AccountDraft {
  name: string;
  institution: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  ownerPersonId: number | null;
  interestRatePct: number | null;
  isClosed: boolean;
}

export function AccountForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: AccountView;
  onClose: () => void;
  onSaved: (account: AccountView) => void;
}) {
  const household = useApi<HouseholdResponse>("/api/household");
  const [draft, setDraft] = useState<AccountDraft>(
    initial ?? {
      name: "",
      institution: "",
      type: "checking",
      taxTreatment: "taxable",
      ownerPersonId: null,
      interestRatePct: null,
      isClosed: false,
    },
  );
  const [error, setError] = useState<string>();
  const set = <K extends keyof AccountDraft>(key: K, v: AccountDraft[K]) => setDraft({ ...draft, [key]: v });
  const isDebt = LIABILITY_TYPES.includes(draft.type);

  const save = async () => {
    try {
      const body = { ...draft };
      const saved = initial
        ? await api<AccountView>("PATCH", `/api/accounts/${initial.id}`, body)
        : await api<AccountView>("POST", "/api/accounts", body);
      notifyDataChanged();
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title={initial ? "Edit account" : "Add account"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()}>
            {initial ? "Save" : "Add account"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" hint="What you call it, e.g. “Joint checking”">
          <input value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Institution">
          <input value={draft.institution} onChange={(e) => set("institution", e.target.value)} placeholder="Bank or brokerage" />
        </Field>
        <Field label="Type">
          <select
            value={draft.type}
            onChange={(e) => {
              const type = e.target.value as AccountType;
              setDraft({ ...draft, type, taxTreatment: defaultTaxTreatment(type) });
            }}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        {INVESTMENT_TYPES.includes(draft.type) && (
          <Field label="Tax treatment" hint="Pick Roth for a Roth 401(k)">
            <select value={draft.taxTreatment} onChange={(e) => set("taxTreatment", e.target.value as TaxTreatment)}>
              {TAX_TREATMENTS.map((t) => (
                <option key={t} value={t}>
                  {TAX_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Owner">
          <select value={draft.ownerPersonId ?? ""} onChange={(e) => set("ownerPersonId", e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Joint</option>
            {household.data?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {(isDebt || draft.type === "savings" || draft.type === "checking") && (
          <Field label={isDebt ? "Interest rate (APR)" : "Interest rate (APY)"}>
            <NumberInput value={draft.interestRatePct} min={0} max={100} step={0.01} suffix="%" onChange={(v) => set("interestRatePct", v)} />
          </Field>
        )}
        {initial && (
          <label className="check">
            <input type="checkbox" checked={draft.isClosed} onChange={(e) => set("isClosed", e.target.checked)} />
            Account is closed
          </label>
        )}
      </div>
      <ErrorNote message={error} />
    </Modal>
  );
}

export function AccountsPage() {
  const accounts = useApi<AccountView[]>("/api/accounts");
  const [adding, setAdding] = useState(false);

  const list = accounts.data ?? [];
  const open = list.filter((a) => !a.isClosed);
  const assets = open.filter((a) => !a.isLiability).reduce((s, a) => s + a.balance, 0);
  const debts = open.filter((a) => a.isLiability).reduce((s, a) => s + a.balance, 0);

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle={list.length > 0 ? <>Net worth <Amount cents={assets + debts} /></> : undefined}
        actions={
          <button type="button" onClick={() => setAdding(true)}>
            Add account
          </button>
        }
      />
      {accounts.loading && !accounts.data && <Loading />}
      <ErrorNote message={accounts.error} />
      {accounts.data && list.length === 0 && (
        <Empty>
          <p>No accounts yet. Add your checking, savings, credit cards, loans and investment accounts.</p>
          <button type="button" onClick={() => setAdding(true)}>
            Add your first account
          </button>
        </Empty>
      )}
      {list.length > 0 && (
        <div className="totals">
          <div>
            <span className="muted">Assets</span>
            <Amount cents={assets} />
          </div>
          <div>
            <span className="muted">Debts</span>
            <Amount cents={debts} />
          </div>
        </div>
      )}
      {GROUPS.map((group) => {
        const inGroup = list.filter((a) => group.types.includes(a.type));
        if (inGroup.length === 0) return null;
        return (
          <section className="panel tight" key={group.title}>
            <div className="group-head">
              <h2>{group.title}</h2>
              <Amount cents={inGroup.filter((a) => !a.isClosed).reduce((s, a) => s + a.balance, 0)} />
            </div>
            <ul className="account-list">
              {inGroup.map((a) => (
                <li key={a.id} className={a.isClosed ? "closed" : ""}>
                  <Link to={`/accounts/${a.id}`}>
                    <span>
                      <strong>{a.name}</strong>
                      <span className="muted small">
                        {[a.institution, ACCOUNT_TYPE_LABELS[a.type], a.isClosed ? "Closed" : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="right">
                      <Amount cents={a.balance} />
                      <span className="muted small">{a.balanceAsOf ? `as of ${formatDate(a.balanceAsOf)}` : "no data yet"}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {adding && (
        <AccountForm
          onClose={() => setAdding(false)}
          onSaved={(a) => {
            setAdding(false);
            navigate(`/accounts/${a.id}`);
          }}
        />
      )}
    </>
  );
}

export function AccountDetailPage({ id }: { id: number }) {
  const account = useApi<AccountView>(`/api/accounts/${id}`);
  const balances = useApi<BalanceSnapshotView[]>(`/api/accounts/${id}/balances`);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(todayLocal());
  const [amount, setAmount] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  if (!account.data) return account.error ? <ErrorNote message={account.error} /> : <Loading />;
  const a = account.data;

  const addBalance = async () => {
    if (amount === null) {
      setError("Enter a balance.");
      return;
    }
    try {
      // Debts are stored as negative balances; people enter what they owe.
      await api("POST", `/api/accounts/${id}/balances`, { date, balance: a.isLiability ? -Math.abs(amount) : amount });
      setAmount(null);
      setError(undefined);
      await Promise.all([balances.reload(), account.reload()]);
      notifyDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${a.name}” and its ${plural(a.transactionCount, "transaction")}? This can't be undone.`)) return;
    await api("DELETE", `/api/accounts/${id}`);
    notifyDataChanged();
    navigate("/accounts");
  };

  return (
    <>
      <PageHeader
        title={a.name}
        subtitle={
          <>
            {[a.institution, ACCOUNT_TYPE_LABELS[a.type], a.isClosed ? "Closed" : null].filter(Boolean).join(" · ")} · Balance{" "}
            <Amount cents={a.balance} /> {a.balanceAsOf && <span className="muted">as of {formatDate(a.balanceAsOf)}</span>}
          </>
        }
        actions={
          <>
            <Link to={`/transactions?accountId=${id}`} className="button secondary">
              Transactions ({a.transactionCount})
            </Link>
            <Link to={`/import?accountId=${id}`} className="button secondary">
              Import
            </Link>
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        }
      />

      <section className="panel">
        <h2>Balance history</h2>
        <p className="muted small">
          The balance is the latest entry here plus any transactions after it. Add a balance to set a starting point, or for
          accounts you don't import transactions for (like a 401(k) or your home).
          {a.isLiability && " For debts, enter the amount owed."}
        </p>
        <div className="inline-form">
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={a.isLiability ? "Amount owed" : "Balance"}>
            <MoneyInput value={amount} onChange={setAmount} allowNegative={!a.isLiability} />
          </Field>
          <button type="button" onClick={() => void addBalance()}>
            Add balance
          </button>
        </div>
        <ErrorNote message={error} />
        {balances.data && balances.data.length > 0 && (
          <div className="table-wrap">
<table className="table compact">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Balance</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {balances.data.map((b) => (
                <tr key={b.id}>
                  <td>{formatDate(b.date)}</td>
                  <td className="num">
                    <Amount cents={b.balance} />
                  </td>
                  <td className="muted">{b.source === "import" ? "From statement" : "Entered"}</td>
                  <td className="num">
                    <button
                      type="button"
                      className="link danger"
                      onClick={async () => {
                        await api("DELETE", `/api/balances/${b.id}`);
                        await Promise.all([balances.reload(), account.reload()]);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </section>

      <section className="panel">
        <h2>Import settings</h2>
        {a.hasCsvMapping ? (
          <p>
            CSV column mapping saved for this account.{" "}
            <button
              type="button"
              className="link"
              onClick={async () => {
                await api("DELETE", `/api/accounts/${id}/csv-mapping`);
                await account.reload();
              }}
            >
              Forget it
            </button>{" "}
            <span className="muted small">(you'll map columns again on the next CSV import)</span>
          </p>
        ) : (
          <p className="muted">No CSV mapping saved yet. It's saved the first time you import a CSV.</p>
        )}
      </section>

      <section className="panel danger-zone">
        <h2>Delete account</h2>
        <p className="muted small">Removes the account, its transactions, balances and import history.</p>
        <button type="button" className="danger" onClick={() => void remove()}>
          Delete account
        </button>
      </section>

      {editing && (
        <AccountForm
          initial={a}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void account.reload();
          }}
        />
      )}
    </>
  );
}

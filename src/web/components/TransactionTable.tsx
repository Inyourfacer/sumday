import { useEffect, useState } from "react";
import { addDays } from "../../engine/dates.ts";
import type { AccountView, CategoryView, TransactionList, TransactionUpdateResult, TransactionView } from "../../shared/api.ts";
import { api, errorMessage, notifyDataChanged } from "../api.ts";
import { formatDate, todayLocal } from "../format.ts";
import { Amount, CategorySelect, ErrorNote, Field, Modal, MoneyInput } from "./ui.tsx";

export function TransactionTable({
  items,
  categories,
  showAccount = true,
  onCategoryChange,
  onOpen,
}: {
  items: readonly TransactionView[];
  categories: readonly CategoryView[];
  showAccount?: boolean;
  onCategoryChange: (txn: TransactionView, categoryId: number | null) => void;
  onOpen: (txn: TransactionView) => void;
}) {
  return (
    <div className="table-wrap">
<table className="table txns">
      <thead>
        <tr>
          <th>Date</th>
          <th>Payee</th>
          {showAccount && <th>Account</th>}
          <th>Category</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={t.id}>
            <td className="nowrap">{formatDate(t.date)}</td>
            <td>
              <button type="button" className="link payee" onClick={() => onOpen(t)} title={t.payeeRaw}>
                {t.payee}
              </button>
              {(t.memo || t.notes) && <span className="muted small block">{t.notes || t.memo}</span>}
            </td>
            {showAccount && <td className="muted">{t.accountName}</td>}
            <td>
              <CategorySelect
                categories={categories}
                value={t.categoryId}
                ariaLabel={`Category for ${t.payee}`}
                onChange={(id) => onCategoryChange(t, id)}
              />
              {t.transferId !== null && <span className="badge transfer">↔ {t.transferAccountName}</span>}
              {t.categorySource === "rule" && <span className="badge">rule</span>}
            </td>
            <td className="num">
              <Amount cents={t.amount} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
</div>
  );
}

export function TransactionModal({
  txn,
  categories,
  onClose,
  onChanged,
}: {
  txn: TransactionView;
  categories: readonly CategoryView[];
  onClose: () => void;
  onChanged: (result?: TransactionUpdateResult) => void;
}) {
  const [payee, setPayee] = useState(txn.payee);
  const [notes, setNotes] = useState(txn.notes);
  const [categoryId, setCategoryId] = useState(txn.categoryId);
  const [date, setDate] = useState(txn.date);
  const [amount, setAmount] = useState<number | null>(txn.amount);
  const [candidates, setCandidates] = useState<TransactionView[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (txn.transferId !== null || txn.status !== "posted") return;
    const from = addDays(txn.date, -10);
    const to = addDays(txn.date, 10);
    api<TransactionList>("GET", `/api/transactions?from=${from}&to=${to}&limit=500`)
      .then((list) =>
        setCandidates(
          list.items.filter((c) => c.accountId !== txn.accountId && Math.sign(c.amount) === -Math.sign(txn.amount) && c.transferId === null),
        ),
      )
      .catch(() => setCandidates([]));
  }, [txn]);

  const save = async () => {
    try {
      const body: Record<string, unknown> = {};
      if (payee !== txn.payee) body.payee = payee;
      if (notes !== txn.notes) body.notes = notes;
      if (categoryId !== txn.categoryId) body.categoryId = categoryId;
      if (txn.isManual && date !== txn.date) body.date = date;
      if (txn.isManual && amount !== null && amount !== txn.amount) body.amount = amount;
      const result = Object.keys(body).length
        ? await api<TransactionUpdateResult>("PATCH", `/api/transactions/${txn.id}`, body)
        : undefined;
      notifyDataChanged();
      onChanged(result);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      notifyDataChanged();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title="Transaction"
      onClose={onClose}
      footer={
        <>
          {txn.isManual && (
            <button
              type="button"
              className="danger secondary"
              onClick={() => window.confirm("Delete this transaction?") && void act(() => api("DELETE", `/api/transactions/${txn.id}`))}
            >
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="muted small">
        {txn.accountName} · {txn.isManual ? "Entered by hand" : `Bank text: “${txn.payeeRaw}”`}
        {txn.memo && ` · Memo: ${txn.memo}`}
      </p>
      <div className="form-grid">
        <Field label="Payee">
          <input value={payee} onChange={(e) => setPayee(e.target.value)} />
        </Field>
        <Field label="Category">
          <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} />
        </Field>
        <Field label="Date" hint={txn.isManual ? undefined : "From the bank file"}>
          <input type="date" value={date} disabled={!txn.isManual} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Amount" hint={txn.isManual ? "Negative = money out" : "From the bank file"}>
          {txn.isManual ? <MoneyInput value={amount} onChange={setAmount} allowNegative /> : <Amount cents={txn.amount} />}
        </Field>
        <Field label="Notes" wide>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      <h4>Transfer</h4>
      {txn.transferId !== null ? (
        <p>
          Linked with a transaction in <strong>{txn.transferAccountName}</strong>. Transfers don't count as spending or income.{" "}
          <button type="button" className="link" onClick={() => void act(() => api("POST", `/api/transactions/${txn.id}/unlink-transfer`))}>
            Not a transfer
          </button>
        </p>
      ) : candidates && candidates.length > 0 ? (
        <>
          <p className="muted small">If this moved money between your own accounts, link it to the other side:</p>
          <ul className="candidates">
            {candidates.slice(0, 8).map((c) => (
              <li key={c.id}>
                <span>
                  {formatDate(c.date)} · {c.accountName} · {c.payee}
                </span>
                <Amount cents={c.amount} />
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => void act(() => api("POST", "/api/transactions/link-transfer", { ids: [txn.id, c.id] }))}
                >
                  Link
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">Not linked to another account.</p>
      )}
      <ErrorNote message={error} />
    </Modal>
  );
}

export function NewTransactionModal({
  accounts,
  categories,
  defaultAccountId,
  onClose,
  onSaved,
}: {
  accounts: readonly AccountView[];
  categories: readonly CategoryView[];
  defaultAccountId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accountId, setAccountId] = useState<number | undefined>(defaultAccountId ?? accounts[0]?.id);
  const [date, setDate] = useState(todayLocal());
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  const save = async () => {
    if (accountId === undefined) return setError("Add an account first.");
    if (amount === null) return setError("Enter an amount.");
    try {
      await api("POST", "/api/transactions", {
        accountId,
        date,
        payee,
        amount: direction === "out" ? -Math.abs(amount) : Math.abs(amount),
        ...(categoryId === null ? {} : { categoryId }),
      });
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title="Add transaction"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()}>
            Add
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Account">
          <select value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Payee">
          <input value={payee} onChange={(e) => setPayee(e.target.value)} />
        </Field>
        <Field label="Amount">
          <span className="row">
            <select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value as "out" | "in")}>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel="Amount" />
          </span>
        </Field>
        <Field label="Category" hint="Leave empty to let your rules decide">
          <CategorySelect categories={categories} value={categoryId} noneLabel="Use rules" onChange={setCategoryId} />
        </Field>
      </div>
      <ErrorNote message={error} />
    </Modal>
  );
}

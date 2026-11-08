import { useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABELS, type AssetClass } from "../../engine/invest/classify.ts";
import type { AccountView, HoldingView, InvestmentsResponse, Mix } from "../../shared/api.ts";
import { ACCOUNT_TYPE_LABELS, type AccountType } from "../../shared/schemas.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { Amount, Empty, ErrorNote, Field, Loading, Modal, MoneyInput, NumberInput, PageHeader } from "../components/ui.tsx";
import { formatDate, formatMoney, todayLocal } from "../format.ts";
import { Link } from "../router.tsx";

const pctText = (f: number) => `${Math.round(f * 1000) / 10}%`;

const SHORT: Record<AssetClass, string> = { us_stock: "US", intl_stock: "Intl", bonds: "Bonds", cash: "Cash", real_estate: "RE", other: "Other" };

function mixLabel(mix: Mix | null): string {
  if (!mix) return "Not set";
  const parts = ASSET_CLASSES.filter((c) => (mix[c] ?? 0) > 0).sort((a, b) => (mix[b] ?? 0) - (mix[a] ?? 0));
  if (parts.length === 1) return ASSET_CLASS_LABELS[parts[0]!];
  return parts.map((c) => `${Math.round((mix[c] ?? 0) * 100)}% ${SHORT[c]}`).join(" · ");
}

const INVESTMENT_TYPES: AccountType[] = ["brokerage", "401k", "403b", "457", "ira", "roth_ira", "hsa", "529"];

function AllocationPanel({ data, onSaved }: { data: InvestmentsResponse; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<AssetClass, number | null>>(
    Object.fromEntries(ASSET_CLASSES.map((c) => [c, data.target[c] ? Math.round(data.target[c]! * 1000) / 10 : null])) as Record<
      AssetClass,
      number | null
    >,
  );
  const [error, setError] = useState<string>();
  const sum = ASSET_CLASSES.reduce((s, c) => s + (draft[c] ?? 0), 0);

  const save = async () => {
    const target: Mix = {};
    for (const c of ASSET_CLASSES) if (draft[c]) target[c] = draft[c]! / 100;
    try {
      await api("PUT", "/api/investments/target", { target });
      setEditing(false);
      setError(undefined);
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="panel">
      <div className="group-head">
        <h2>Mix vs target</h2>
        {!editing && (
          <button type="button" className="secondary small" onClick={() => setEditing(true)}>
            Edit target
          </button>
        )}
      </div>
      {data.targetIsDefault && !editing && (
        <p className="muted small">Using a starting target of 60% US stocks, 30% international, 10% bonds. Set your own to match your plan.</p>
      )}
      {editing ? (
        <div className="stack">
          <div className="form-grid">
            {ASSET_CLASSES.map((c) => (
              <Field key={c} label={ASSET_CLASS_LABELS[c]}>
                <NumberInput value={draft[c]} min={0} max={100} step={1} suffix="%" ariaLabel={`Target ${ASSET_CLASS_LABELS[c]}`} onChange={(v) => setDraft({ ...draft, [c]: v })} />
              </Field>
            ))}
          </div>
          <p className={Math.abs(sum - 100) < 0.05 ? "small ok-text" : "small error-text"}>Adds up to {Math.round(sum * 10) / 10}%</p>
          <ErrorNote message={error} />
          <div className="row">
            <button type="button" onClick={() => void save()} disabled={Math.abs(sum - 100) >= 0.05}>
              Save target
            </button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="legend" aria-hidden>
            <span>
              <i className="swatch s1" />
              Current
            </span>
            <span>
              <i className="target-key" />
              Target
            </span>
          </div>
          <ul className="mix-rows">
            {data.drift.map((r) => (
              <li key={r.assetClass}>
                <span className="mix-name">{ASSET_CLASS_LABELS[r.assetClass]}</span>
                <span
                  className="mix-bar"
                  role="img"
                  aria-label={`${ASSET_CLASS_LABELS[r.assetClass]}: ${pctText(r.current)} now, target ${pctText(r.target)}`}
                >
                  <span className="mix-fill" style={{ width: `${Math.min(100, r.current * 100)}%` }} />
                  <span className="mix-target" style={{ left: `${Math.min(100, r.target * 100)}%` }} />
                </span>
                <span className="mix-num">
                  <strong>{pctText(r.current)}</strong> <span className="muted small">/ {pctText(r.target)}</span>
                </span>
                <span className={`status ${r.status === "in" ? "ok" : "over"}`}>
                  {r.status === "in" ? "In range" : r.status === "over" ? `${pctText(r.drift)} over` : `${pctText(-r.drift)} under`}
                </span>
                <span className="mix-value muted small">{formatMoney(r.value, { cents: false })}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            A class is in range within 5 percentage points of its target, or 25% of the target for small ones (at least 1 point).
            {data.unclassified > 0 && <> {formatMoney(data.unclassified, { cents: false })} in funds without a mix isn't counted: set their mix below.</>}
          </p>
        </>
      )}
    </section>
  );
}

function NextContribution({ data, onAmount }: { data: InvestmentsResponse; onAmount: (v: number | null) => void }) {
  const n = data.nextContribution;
  return (
    <section className="panel">
      <div className="group-head">
        <h2>Next contribution</h2>
        <label className="inline-field">
          <span className="field-label">Amount</span>
          <span className="budget-input">
            <MoneyInput value={n.amount} onChange={onAmount} ariaLabel="Contribution amount" />
          </span>
        </label>
      </div>
      <p className="muted small">
        {n.source === "plan" ? "What your plan puts into investing each month (IRA, workplace plan, HSA, brokerage). " : ""}
        Buying the underweight classes first moves you back toward target without selling anything.
      </p>
      {n.split.length === 0 ? (
        <p className="muted">
          {n.source === "plan" && n.amount === 0 ? (
            <>
              Your plan has nothing for investing this month: the steps before it (see <Link to="/plan">Next best moves</Link>) come first. Enter an amount to see how you'd split it.
            </>
          ) : (
            "Enter an amount to see how to split it."
          )}
        </p>
      ) : (
        <ul className="lines">
          {n.split.map((s) => (
            <li key={s.assetClass}>
              <span>
                <strong>{ASSET_CLASS_LABELS[s.assetClass]}</strong>
                <span className="muted small">
                  {" "}
                  {s.suggestion ? `e.g. more ${s.suggestion.label} (${s.suggestion.accountName})` : "you don't hold a fund for this yet"}
                </span>
              </span>
              <strong>{formatMoney(s.amount, { cents: false })}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RebalancePanel({ data }: { data: InvestmentsResponse }) {
  const r = data.rebalance;
  if (!r.needed) return null;
  const label = (c: AssetClass) => (c === "us_stock" ? "US stocks" : ASSET_CLASS_LABELS[c].toLowerCase());
  const sheltered = r.trades.filter((t) => t.where === "tax_advantaged");
  const taxable = r.trades.filter((t) => t.where === "taxable");
  return (
    <section className="panel">
      <h2>Rebalance</h2>
      <p className="muted small">
        Your mix is outside its range. New contributions (above) fix drift gradually at no cost; to get back now, trade in this order.
      </p>
      {sheltered.length > 0 && (
        <>
          <h4>1. Inside retirement & HSA accounts (no tax)</h4>
          <ul className="lines">
            {sheltered.map((t) => (
              <li key={`${t.sell}-${t.buy}`}>
                <span>
                  Sell {label(t.sell)}, buy {label(t.buy)}
                </span>
                <strong>{formatMoney(t.amount, { cents: false })}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {taxable.length > 0 && (
        <>
          <h4>{sheltered.length > 0 ? "2." : "1."} In taxable accounts (may owe tax)</h4>
          <ul className="lines">
            {r.taxableSales.map((s) => (
              <li key={s.holdingId}>
                <span>
                  Sell {formatMoney(s.amount, { cents: false })} of {s.label} <span className="muted small">({s.accountName})</span>
                </span>
                <span className="small">
                  {s.estimatedGain === null
                    ? "gain unknown (add cost basis)"
                    : s.estimatedGain < 0
                      ? `≈ ${formatMoney(-s.estimatedGain, { cents: false })} loss (can offset other gains)`
                      : `≈ ${formatMoney(s.estimatedGain, { cents: false })} gain`}
                </span>
              </li>
            ))}
            {taxable.map((t) => (
              <li key={`b-${t.sell}-${t.buy}`} className="muted">
                <span>Then buy {label(t.buy)}</span>
                <span>{formatMoney(t.amount, { cents: false })}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">Holdings with losses are sold first, then the smallest gains. Short-term gains are taxed higher; check holding periods first.</p>
        </>
      )}
    </section>
  );
}

function HoldingModal({ holding, onClose, onSaved }: { holding: HoldingView; onClose: () => void; onSaved: () => void }) {
  const singleClass = holding.mix ? ASSET_CLASSES.find((c) => holding.mix![c] === 1) : undefined;
  const [mode, setMode] = useState<string>(holding.mix === null ? "" : (singleClass ?? "custom"));
  const [custom, setCustom] = useState<Record<AssetClass, number | null>>(
    Object.fromEntries(ASSET_CLASSES.map((c) => [c, holding.mix?.[c] ? Math.round(holding.mix[c]! * 1000) / 10 : null])) as Record<AssetClass, number | null>,
  );
  const [ticker, setTicker] = useState(holding.ticker ?? "");
  const [proxy, setProxy] = useState(holding.proxyTicker ?? "");
  const [er, setEr] = useState<number | null>(holding.expenseRatio);
  const [shares, setShares] = useState<number | null>(holding.shares);
  const [basis, setBasis] = useState<number | null>(holding.costBasis);
  const [priceDate, setPriceDate] = useState(todayLocal());
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const customSum = ASSET_CLASSES.reduce((s, c) => s + (custom[c] ?? 0), 0);

  const save = async () => {
    try {
      const mix: Mix | null =
        mode === ""
          ? null
          : mode === "custom"
            ? Object.fromEntries(ASSET_CLASSES.filter((c) => custom[c]).map((c) => [c, custom[c]! / 100]))
            : { [mode]: 1 };
      await api("PATCH", `/api/securities/${holding.securityId}`, {
        mix,
        expenseRatio: er,
        ...(ticker.trim() !== (holding.ticker ?? "") ? { ticker: ticker.trim() || null } : {}),
        ...(proxy.trim() !== (holding.proxyTicker ?? "") ? { proxyTicker: proxy.trim() || null } : {}),
      });
      if (shares !== holding.shares || basis !== holding.costBasis) {
        await api("PATCH", `/api/holdings/${holding.id}`, { ...(shares !== null ? { shares } : {}), costBasis: basis });
      }
      if (price !== null) await api("POST", `/api/securities/${holding.securityId}/prices`, { date: priceDate, close: price / 100 });
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${holding.ticker ?? holding.name} from this account?`)) return;
    await api("DELETE", `/api/holdings/${holding.id}`);
    notifyDataChanged();
    onSaved();
  };

  return (
    <Modal
      wide
      title={holding.ticker ? `${holding.ticker}: ${holding.name}` : holding.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary danger" onClick={() => void remove()}>
            Remove holding
          </button>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={mode === "custom" && Math.abs(customSum - 100) >= 0.05}>
            Save
          </button>
        </>
      }
    >
      {holding.priceError && <div className="note error">{holding.priceError}</div>}
      <h4>What it holds</h4>
      <div className="form-grid">
        <Field label="Asset class" hint={holding.mixSource === "guessed" ? "Guessed from the name: please check" : undefined}>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">Not set</option>
            {ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>
                100% {ASSET_CLASS_LABELS[c]}
              </option>
            ))}
            <option value="custom">A mix (target-date, balanced, global)…</option>
          </select>
        </Field>
        <Field label="Expense ratio" hint="From the fund's page; e.g. 0.03">
          <NumberInput value={er} min={0} max={10} step={0.01} suffix="% a year" onChange={setEr} ariaLabel="Expense ratio" />
        </Field>
      </div>
      {mode === "custom" && (
        <>
          <div className="form-grid">
            {ASSET_CLASSES.map((c) => (
              <Field key={c} label={ASSET_CLASS_LABELS[c]}>
                <NumberInput value={custom[c]} min={0} max={100} step={1} suffix="%" ariaLabel={`Mix ${ASSET_CLASS_LABELS[c]}`} onChange={(v) => setCustom({ ...custom, [c]: v })} />
              </Field>
            ))}
          </div>
          <p className={Math.abs(customSum - 100) < 0.05 ? "small ok-text" : "small error-text"}>
            Adds up to {Math.round(customSum * 10) / 10}%. A target-date fund's split is on its fact sheet.
          </p>
        </>
      )}

      <h4>Price</h4>
      <p className="muted small">
        {holding.price !== null
          ? `${formatMoney(Math.round(holding.price * 100))} a share on ${formatDate(holding.priceDate)} (${holding.priceSource === "provider" ? "price feed" : holding.priceSource === "proxy" ? `following ${holding.proxyTicker}` : holding.priceSource === "manual" ? "entered by hand" : "from your file"})`
          : "No price yet."}
      </p>
      <div className="form-grid">
        <Field label="Ticker" hint="Leave blank for funds that don't have one">
          <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="e.g. VTI" />
        </Field>
        {!ticker && (
          <Field label="Follows (proxy ticker)" hint="A public fund that tracks the same index, e.g. VOO for an S&P 500 trust">
            <input value={proxy} onChange={(e) => setProxy(e.target.value.toUpperCase())} placeholder="e.g. VOO" />
          </Field>
        )}
        <Field label="Enter a price" hint="From a statement; never overwritten by the feed">
          <span className="row">
            <input type="date" aria-label="Price date" value={priceDate} onChange={(e) => setPriceDate(e.target.value)} />
            <MoneyInput value={price} onChange={setPrice} ariaLabel="Price per share" placeholder="$ per share" />
          </span>
        </Field>
      </div>

      <h4>In this account</h4>
      <div className="form-grid">
        <Field label="Shares">
          <NumberInput value={shares} step={0.001} onChange={setShares} ariaLabel="Shares" />
        </Field>
        <Field label="Cost basis" hint="What you paid in total; used to estimate tax on sales">
          <MoneyInput value={basis} onChange={setBasis} ariaLabel="Cost basis" />
        </Field>
      </div>
      <ErrorNote message={error} />
    </Modal>
  );
}

function AddHoldingModal({ accounts, onClose, onSaved }: { accounts: AccountView[]; onClose: () => void; onSaved: () => void }) {
  const eligible = accounts.filter((a) => INVESTMENT_TYPES.includes(a.type) && !a.isClosed);
  const [accountId, setAccountId] = useState<number | undefined>(eligible[0]?.id);
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [shares, setShares] = useState<number | null>(null);
  const [basis, setBasis] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  const save = async () => {
    try {
      await api("POST", "/api/holdings", {
        accountId,
        ticker: ticker.trim() || null,
        name: name.trim(),
        shares,
        costBasis: basis,
        price: price === null ? null : price / 100,
      });
      notifyDataChanged();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title="Add a holding"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={!accountId}>
            Add
          </button>
        </>
      }
    >
      {eligible.length === 0 ? (
        <p>
          Add a brokerage, retirement or HSA account first on the <Link to="/accounts">Accounts</Link> page.
        </p>
      ) : (
        <div className="form-grid">
          <Field label="Account">
            <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
              {eligible.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ticker" hint="Blank for 401(k) funds without one">
            <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="e.g. VTI" />
          </Field>
          <Field label="Fund name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional with a ticker" />
          </Field>
          <Field label="Shares">
            <NumberInput value={shares} step={0.001} onChange={setShares} ariaLabel="Shares" />
          </Field>
          <Field label="Cost basis" hint="Optional">
            <MoneyInput value={basis} onChange={setBasis} ariaLabel="Cost basis" />
          </Field>
          <Field label="Price per share" hint="Optional; the feed fills it in for tickers">
            <MoneyInput value={price} onChange={setPrice} ariaLabel="Price per share" />
          </Field>
        </div>
      )}
      <ErrorNote message={error} />
    </Modal>
  );
}

export function InvestmentsPage() {
  const [contribution, setContribution] = useState<number | null>(null);
  const data = useApi<InvestmentsResponse>(`/api/investments${contribution === null ? "" : `?contribution=${contribution}`}`);
  const accounts = useApi<AccountView[]>("/api/accounts");
  const [open, setOpen] = useState<HoldingView>();
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string>();

  if (!data.data) return data.error ? <ErrorNote message={data.error} /> : <Loading />;
  const d = data.data;
  const reload = () => void data.reload();

  const refresh = async () => {
    setRefreshing(true);
    try {
      const s = await api<{ updated: number; errors: { ticker: string; message: string }[] }>("POST", "/api/prices/refresh");
      setMessage(`${s.updated} new prices.${s.errors.length ? ` ${s.errors.length} problem(s), shown on the holdings.` : ""}`);
      notifyDataChanged();
      await data.reload();
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Investments"
        subtitle={
          d.total > 0 ? (
            <>
              <Amount cents={d.total} /> across {d.accounts.length} account{d.accounts.length === 1 ? "" : "s"}
              {d.prices.latest && <span className="muted"> · prices as of {formatDate(d.prices.latest)}</span>}
            </>
          ) : undefined
        }
        actions={
          <>
            <Link to="/investments/import" className="button secondary">
              Import positions
            </Link>
            <button type="button" className="secondary" onClick={() => setAdding(true)}>
              Add holding
            </button>
            <button type="button" onClick={() => void refresh()} disabled={refreshing || !d.prices.configured}>
              {refreshing ? "Updating…" : "Update prices"}
            </button>
          </>
        }
      />
      {!d.prices.configured && (
        <div className="note">
          Daily prices are off. Add your free Tiingo key to <code>.env</code> as <code>TIINGO_API_KEY=…</code> and restart Sumday. Until then,
          prices come from your imported files or what you enter.
        </div>
      )}
      {message && <div className="note ok">{message}</div>}

      {d.accounts.length === 0 ? (
        <Empty>
          <p>
            No holdings yet. Download a positions file (CSV) from your brokerage or 401(k) site and{" "}
            <Link to="/investments/import">import it</Link>, or add holdings by hand.
          </p>
        </Empty>
      ) : (
        <>
          <AllocationPanel key={JSON.stringify(d.target)} data={d} onSaved={reload} />
          <NextContribution data={d} onAmount={setContribution} />
          <RebalancePanel data={d} />

          {(d.locationHints.length > 0 || d.fees.weighted !== null || d.fees.unknownValue > 0) && (
            <section className="panel tight">
              <h2>Costs and placement</h2>
              {d.fees.weighted !== null && (
                <p className="small">
                  Average fund cost <strong>{Math.round(d.fees.weighted * 1000) / 1000}%</strong> a year, about{" "}
                  <strong>{formatMoney(d.fees.yearly, { cents: false })}</strong> today. Over 10 years that's{" "}
                  {formatMoney(d.fees.drag10, { cents: false })} of growth, over 30 years {formatMoney(d.fees.drag30, { cents: false })}{" "}
                  <span className="muted">(assuming 6% a year before fees)</span>.
                </p>
              )}
              {d.fees.unknownValue > 0 && (
                <p className="muted small">
                  {formatMoney(d.fees.unknownValue, { cents: false })} is in funds without an expense ratio entered. Click a holding to add it.
                </p>
              )}
              {d.fees.expensive.map((e) => (
                <p key={e.holdingId} className="small">
                  <span className="status over">{e.label}</span> costs {e.expenseRatio}% a year in {e.accountName}.
                </p>
              ))}
              {d.locationHints.map((h) => (
                <p key={h.kind} className="small">
                  <strong>Placement:</strong> {h.message} <span className="muted">(about {formatMoney(h.amount, { cents: false })})</span>
                </p>
              ))}
            </section>
          )}

          {d.accounts.map((a) => (
            <section className="panel tight" key={a.id}>
              <div className="group-head">
                <h2>
                  <Link to={`/accounts/${a.id}`}>{a.name}</Link>{" "}
                  <span className="muted small">
                    {ACCOUNT_TYPE_LABELS[a.type as AccountType] ?? a.type}
                    {a.ownerName && ` · ${a.ownerName}`}
                    {a.xirr !== null && ` · ${Math.round(a.xirr * 1000) / 10}% a year (money-weighted)`}
                  </span>
                </h2>
                <strong>{formatMoney(a.value, { cents: false })}</strong>
              </div>
              <div className="table-wrap">
                <table className="table compact holdings">
                  <thead>
                    <tr>
                      <th>Holding</th>
                      <th className="num">Shares</th>
                      <th className="num">Price</th>
                      <th className="num">Value</th>
                      <th className="num">Gain</th>
                      <th>Asset class</th>
                      <th className="num">Fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.holdings.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <button type="button" className="link payee" onClick={() => setOpen(h)}>
                            {h.ticker ?? h.name}
                          </button>
                          {h.ticker && <span className="muted small block">{h.name}</span>}
                          {h.priceError && <span className="status over block small">{h.priceError}</span>}
                        </td>
                        <td className="num">{h.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                        <td className="num">
                          {h.price === null ? "—" : formatMoney(Math.round(h.price * 100))}
                          {h.priceSource === "proxy" && <span className="muted small block">via {h.proxyTicker}</span>}
                          {h.priceSource === "manual" && <span className="muted small block">entered</span>}
                        </td>
                        <td className="num">{formatMoney(h.value, { cents: false })}</td>
                        <td className="num">{h.gain === null ? "—" : <Amount cents={h.gain} signed />}</td>
                        <td>
                          <span className={h.mix ? "" : "status over"}>{mixLabel(h.mix)}</span>
                          {h.mixSource === "guessed" && <span className="badge">guess</span>}
                        </td>
                        <td className="num">{h.expenseRatio === null ? <span className="muted">—</span> : `${h.expenseRatio}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}

      {open && (
        <HoldingModal
          holding={open}
          onClose={() => setOpen(undefined)}
          onSaved={() => {
            setOpen(undefined);
            reload();
          }}
        />
      )}
      {adding && (
        <AddHoldingModal
          accounts={accounts.data ?? []}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </>
  );
}

import { useState } from "react";
import type { AlertKind, AlertSettings, AlertsResponse } from "../../shared/api.ts";
import { api, errorMessage, useApi } from "../api.ts";
import { ErrorNote, Field, Loading, MoneyInput, NumberInput, PageHeader } from "../components/ui.tsx";

const KINDS: { kind: AlertKind; label: string }[] = [
  { kind: "over_budget", label: "Flex spending over budget or ahead of pace" },
  { kind: "bill_changed", label: "A regular bill changed" },
  { kind: "new_subscription", label: "A new recurring charge" },
  { kind: "large_transaction", label: "A large charge" },
  { kind: "low_cash", label: "Checking may run low before payday" },
  { kind: "drift", label: "Investments drifted from your target" },
  { kind: "promo_ending", label: "An intro rate is ending" },
  { kind: "goal_behind", label: "A goal is behind" },
  { kind: "stale_data", label: "An account hasn't been updated" },
];

export function SettingsAlertsPage() {
  const loaded = useApi<AlertsResponse>("/api/alerts");
  const [draft, setS] = useState<AlertSettings>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

  const s = draft ?? loaded.data?.settings;
  if (!s) return loaded.error ? <ErrorNote message={loaded.error} /> : <Loading />;

  const set = (patch: Partial<AlertSettings>) => {
    setS({ ...s, ...patch });
    setSaved(false);
  };
  const save = async () => {
    try {
      const r = await api<AlertsResponse>("PUT", "/api/alerts/settings", s);
      setS(r.settings);
      setSaved(true);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const toggleDesktop = async (on: boolean) => {
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      setPermission(await Notification.requestPermission());
    }
    set({ desktop: on });
  };

  return (
    <>
      <PageHeader title="Alerts" subtitle="What Sumday watches for, and how sensitive it is. Alerts show on the dashboard and in the monthly report." />
      <section className="panel">
        <h2>Watch for</h2>
        <ul className="toggle-list">
          {KINDS.map((k) => (
            <li key={k.kind}>
              <label>
                <input
                  type="checkbox"
                  checked={!s.disabled.includes(k.kind)}
                  onChange={(e) => set({ disabled: e.target.checked ? s.disabled.filter((x) => x !== k.kind) : [...s.disabled, k.kind] })}
                />
                {k.label}
              </label>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Thresholds</h2>
        <div className="form-grid">
          <Field label="Flex ahead of pace by" hint="Mid-month, compared with an even pace">
            <NumberInput value={s.flexPacePct} onChange={(v) => set({ flexPacePct: v ?? 0 })} min={0} max={200} suffix="%" ariaLabel="Flex pace percent" />
          </Field>
          <Field label="A bill changes by more than">
            <NumberInput value={s.billChangePct} onChange={(v) => set({ billChangePct: v ?? 10 })} min={1} max={200} suffix="%" ariaLabel="Bill change percent" />
          </Field>
          <Field label="A charge of at least">
            <MoneyInput value={s.largeAmount} onChange={(v) => set({ largeAmount: v ?? 0 })} ariaLabel="Large charge amount" />
          </Field>
          <Field label="Or this many times the category's usual">
            <NumberInput value={s.largeMultiple} onChange={(v) => set({ largeMultiple: v ?? 3 })} min={1.5} max={50} step={0.5} suffix="×" ariaLabel="Large charge multiple" />
          </Field>
          <Field label="Keep checking above" hint="Before the next paycheck, after expected bills">
            <MoneyInput value={s.lowCash} onChange={(v) => set({ lowCash: v ?? 0 })} ariaLabel="Low cash floor" />
          </Field>
          <Field label="Warn before an intro rate ends">
            <NumberInput value={s.promoDays} onChange={(v) => set({ promoDays: v ?? 90 })} min={1} max={365} suffix="days" ariaLabel="Intro rate warning days" />
          </Field>
          <Field label="An account is stale after">
            <NumberInput value={s.staleDays} onChange={(v) => set({ staleDays: v ?? 14 })} min={1} max={365} suffix="days" ariaLabel="Stale days" />
          </Field>
        </div>
      </section>
      <section className="panel">
        <h2>Desktop notifications</h2>
        <label className="check">
          <input type="checkbox" checked={s.desktop} disabled={permission === "unsupported" || permission === "denied"} onChange={(e) => void toggleDesktop(e.target.checked)} />
          Show new alerts as notifications while Sumday is open in a browser tab
        </label>
        {permission === "denied" && <p className="muted small">Your browser blocks notifications for this site. Allow them in the browser's site settings first.</p>}
        {permission === "unsupported" && <p className="muted small">This browser doesn't support notifications.</p>}
      </section>
      <div className="actions">
        <button type="button" onClick={() => void save()}>
          Save
        </button>
        {saved && (
          <span className="status ok" role="status">
            Saved
          </span>
        )}
      </div>
      <ErrorNote message={error} />
    </>
  );
}

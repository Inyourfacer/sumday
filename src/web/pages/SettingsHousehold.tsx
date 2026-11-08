import { useState } from "react";
import type { HouseholdResponse } from "../../shared/api.ts";
import type { Household } from "../../shared/schemas.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { HouseholdFields, PersonBasics, PersonRetirement } from "../components/HouseholdForm.tsx";
import { newPerson, type PersonDraft } from "../components/person.ts";
import { ErrorNote, Loading, PageHeader } from "../components/ui.tsx";

export function SettingsHouseholdPage() {
  const loaded = useApi<HouseholdResponse>("/api/household");
  if (!loaded.data) return loaded.error ? <ErrorNote message={loaded.error} /> : <Loading />;
  return <HouseholdEditor initial={loaded.data} />;
}

function HouseholdEditor({ initial }: { initial: HouseholdResponse }) {
  const [household, setHousehold] = useState<Household>(initial.household);
  const [people, setPeople] = useState<PersonDraft[]>(initial.people);
  const [status, setStatus] = useState<{ kind: "saved" | "error"; message: string }>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setStatus(undefined);
    try {
      const saved = await api<HouseholdResponse>("PUT", "/api/household", { household, people });
      setHousehold(saved.household);
      setPeople(saved.people);
      setStatus({ kind: "saved", message: "Saved." });
      notifyDataChanged();
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const update = (i: number, p: PersonDraft) => setPeople(people.map((x, j) => (j === i ? p : x)));

  return (
    <>
      <PageHeader title="Household" subtitle="Used for retirement projections, contribution limits and recommendations." />
      <section className="panel">
        <h2>Household</h2>
        <HouseholdFields value={household} onChange={setHousehold} />
      </section>

      {people.map((p, i) => (
        <section className="panel" key={p.id ?? `new-${i}`}>
          <div className="person-head">
            <h2>{p.name || `Adult ${i + 1}`}</h2>
            <button
              type="button"
              className="link danger"
              onClick={() => {
                if (p.id === undefined || window.confirm(`Remove ${p.name}? Accounts they own become joint.`)) {
                  setPeople(people.filter((_, j) => j !== i));
                }
              }}
            >
              Remove
            </button>
          </div>
          <PersonBasics value={p} onChange={(v) => update(i, v)} />
          <PersonRetirement value={p} onChange={(v) => update(i, v)} />
        </section>
      ))}

      <div className="save-bar">
        {people.length < 2 && (
          <button type="button" className="secondary" onClick={() => setPeople([...people, newPerson()])}>
            Add an adult
          </button>
        )}
        <span className="spacer" />
        {status && <span className={status.kind === "error" ? "error-text" : "ok-text"}>{status.message}</span>}
        <button type="button" onClick={() => void save()} disabled={saving}>
          Save changes
        </button>
      </div>
    </>
  );
}

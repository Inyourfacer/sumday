import { useState } from "react";
import type { HouseholdResponse } from "../../shared/api.ts";
import type { Household } from "../../shared/schemas.ts";
import { api, errorMessage, notifyDataChanged, useApi } from "../api.ts";
import { HouseholdFields, PersonBasics, PersonRetirement } from "../components/HouseholdForm.tsx";
import { newPerson, type PersonDraft } from "../components/person.ts";
import { ErrorNote, Loading } from "../components/ui.tsx";
import { Link } from "../router.tsx";
import { navigate } from "../navigation.ts";

const STEPS = ["Household", "People", "Retirement details", "Done"] as const;

export function SetupPage() {
  const loaded = useApi<HouseholdResponse>("/api/household");
  if (!loaded.data) return loaded.error ? <ErrorNote message={loaded.error} /> : <Loading />;
  return <SetupWizard initial={loaded.data} />;
}

function SetupWizard({ initial }: { initial: HouseholdResponse }) {
  const [step, setStep] = useState(0);
  const [household, setHousehold] = useState<Household>(initial.household);
  const [people, setPeople] = useState<PersonDraft[]>(initial.people.length > 0 ? initial.people : [newPerson()]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const saved = await api<HouseholdResponse>("PUT", "/api/household", {
      household,
      people: people.filter((p) => p.name.trim() !== "" || p.id !== undefined),
    });
    setPeople(saved.people.length > 0 ? saved.people : [newPerson()]);
    notifyDataChanged();
  };

  const next = async () => {
    setError(undefined);
    if (step === 1 && people.every((p) => p.name.trim() === "")) {
      setError("Add at least one adult, or skip setup for now.");
      return;
    }
    setSaving(true);
    try {
      await save();
      if (step === 2) await api("POST", "/api/setup/complete", { complete: true });
      setStep(step + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    await api("POST", "/api/setup/complete", { complete: true });
    notifyDataChanged();
    navigate("/");
  };

  const updatePerson = (i: number, p: PersonDraft) => setPeople(people.map((x, j) => (j === i ? p : x)));
  const named = people.filter((p) => p.name.trim() !== "");

  return (
    <div className="setup">
      <div className="setup-head">
        <h1>Set up Sumday</h1>
        <p className="lede">
          A few details about your household drive the retirement math and recommendations. Everything can be changed later
          in Settings, and anything left blank shows up as a reminder.
        </p>
        <ol className="steps" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "current" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
              {s}
            </li>
          ))}
        </ol>
      </div>

      <section className="panel">
        {step === 0 && (
          <>
            <h2>Your household</h2>
            <HouseholdFields value={household} onChange={setHousehold} />
          </>
        )}

        {step === 1 && (
          <>
            <h2>The adults in your household</h2>
            {people.map((p, i) => (
              <div className="person-block" key={p.id ?? `new-${i}`}>
                <div className="person-head">
                  <h3>{p.name || `Adult ${i + 1}`}</h3>
                  {people.length > 1 && (
                    <button type="button" className="link" onClick={() => setPeople(people.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </div>
                <PersonBasics value={p} onChange={(v) => updatePerson(i, v)} />
              </div>
            ))}
            {people.length < 2 && (
              <button type="button" className="secondary" onClick={() => setPeople([...people, newPerson()])}>
                Add a second adult
              </button>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h2>Retirement details</h2>
            <p className="muted">Workplace plans, employer match, Social Security and pensions. Skip anything you don't know yet.</p>
            {named.map((p) => {
              const i = people.indexOf(p);
              return (
                <div className="person-block" key={p.id ?? `new-${i}`}>
                  <h3>{p.name}</h3>
                  <PersonRetirement value={p} onChange={(v) => updatePerson(i, v)} />
                </div>
              );
            })}
          </>
        )}

        {step === 3 && (
          <div className="done">
            <h2>You're set up</h2>
            <p>Next, add your accounts and bring in some transactions.</p>
            <div className="row">
              <Link to="/accounts" className="button">
                Add accounts
              </Link>
              <Link to="/import" className="button secondary">
                Import transactions
              </Link>
              <Link to="/" className="button secondary">
                Go to dashboard
              </Link>
            </div>
          </div>
        )}

        <ErrorNote message={error} />

        {step < 3 && (
          <div className="wizard-nav">
            <button type="button" className="link" onClick={() => void skip()}>
              Skip setup for now
            </button>
            <div className="row">
              {step > 0 && (
                <button type="button" className="secondary" onClick={() => setStep(step - 1)} disabled={saving}>
                  Back
                </button>
              )}
              <button type="button" onClick={() => void next()} disabled={saving}>
                {step === 2 ? "Finish" : "Next"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

import type { Household } from "../../shared/schemas.ts";
import type { PersonDraft } from "./person.ts";
import { FILING_STATUSES, HSA_COVERAGE, PLAN_TYPES } from "../../shared/schemas.ts";
import { Field, MoneyInput, NumberInput } from "./ui.tsx";


const FILING_LABELS: Record<(typeof FILING_STATUSES)[number], string> = {
  single: "Single",
  married_joint: "Married filing jointly",
  married_separate: "Married filing separately",
  head_of_household: "Head of household",
};
const HSA_LABELS: Record<(typeof HSA_COVERAGE)[number], string> = {
  none: "No HSA-eligible plan",
  self: "Self-only HSA plan",
  family: "Family HSA plan",
};
const PLAN_LABELS: Record<(typeof PLAN_TYPES)[number], string> = {
  none: "No workplace plan",
  "401k": "401(k)",
  "403b": "403(b)",
  "457": "457(b)",
};

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"];
  }
}

export function HouseholdFields({ value, onChange }: { value: Household; onChange: (h: Household) => void }) {
  const set = <K extends keyof Household>(key: K, v: Household[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="form-grid">
      <Field label="Tax filing status">
        <select value={value.filingStatus} onChange={(e) => set("filingStatus", e.target.value as Household["filingStatus"])}>
          {FILING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {FILING_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="State" hint="Two letters, e.g. TX">
        <input value={value.state} maxLength={2} onChange={(e) => set("state", e.target.value.toUpperCase())} />
      </Field>
      <Field label="Dependents">
        <NumberInput value={value.dependents} min={0} max={20} onChange={(v) => set("dependents", v ?? 0)} />
      </Field>
      <Field label="Health savings account">
        <select value={value.hsaCoverage} onChange={(e) => set("hsaCoverage", e.target.value as Household["hsaCoverage"])}>
          {HSA_COVERAGE.map((s) => (
            <option key={s} value={s}>
              {HSA_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Inflation assumption" hint="Used in retirement projections">
        <NumberInput value={value.inflationPct} min={0} max={20} step={0.1} suffix="%" onChange={(v) => set("inflationPct", v ?? 0)} />
      </Field>
      <Field label="Plan until age">
        <NumberInput value={value.planningHorizonAge} min={70} max={120} onChange={(v) => set("planningHorizonAge", v ?? 95)} />
      </Field>
      <Field label="Time zone" wide>
        <select value={value.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
          {timeZones().map((tz) => (
            <option key={tz} value={tz}>
              {tz.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

export function PersonBasics({ value, onChange }: { value: PersonDraft; onChange: (p: PersonDraft) => void }) {
  const set = <K extends keyof PersonDraft>(key: K, v: PersonDraft[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="form-grid">
      <Field label="Name">
        <input value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="First name" />
      </Field>
      <Field label="Birth date">
        <input type="date" value={value.birthDate ?? ""} onChange={(e) => set("birthDate", e.target.value || null)} />
      </Field>
      <Field label="Yearly income (before tax)" hint="Enter 0 if not working">
        <MoneyInput value={value.income} onChange={(v) => set("income", v)} />
      </Field>
      <Field label="Expected yearly raise">
        <NumberInput value={value.raisePct} min={0} max={20} step={0.5} suffix="%" onChange={(v) => set("raisePct", v ?? 0)} />
      </Field>
      <Field label="Target retirement age">
        <NumberInput value={value.retirementAge} min={30} max={85} onChange={(v) => set("retirementAge", v ?? 65)} />
      </Field>
    </div>
  );
}

export function PersonRetirement({ value, onChange }: { value: PersonDraft; onChange: (p: PersonDraft) => void }) {
  const plan = value.employerPlan;
  const setPlan = (patch: Partial<PersonDraft["employerPlan"]>) => onChange({ ...value, employerPlan: { ...plan, ...patch } });
  const ss = value.socialSecurity;
  const setSs = (patch: Partial<PersonDraft["socialSecurity"]>) => onChange({ ...value, socialSecurity: { ...ss, ...patch } });

  return (
    <div className="stack">
      <h4>Workplace retirement plan</h4>
      <div className="form-grid">
        <Field label="Plan type">
          <select value={plan.type} onChange={(e) => setPlan({ type: e.target.value as typeof plan.type })}>
            {PLAN_TYPES.map((t) => (
              <option key={t} value={t}>
                {PLAN_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        {plan.type !== "none" && (
          <>
            <Field label="You contribute (pre-tax)">
              <NumberInput value={plan.pretaxPct} min={0} max={100} step={0.5} suffix="% of pay" onChange={(v) => setPlan({ pretaxPct: v ?? 0 })} />
            </Field>
            <Field label="You contribute (Roth)">
              <NumberInput value={plan.rothPct} min={0} max={100} step={0.5} suffix="% of pay" onChange={(v) => setPlan({ rothPct: v ?? 0 })} />
            </Field>
          </>
        )}
        <Field label="HSA payroll contribution" hint="Per year, if any">
          <MoneyInput value={plan.hsaPayrollAnnual} onChange={(v) => setPlan({ hsaPayrollAnnual: v ?? 0 })} />
        </Field>
      </div>

      {plan.type !== "none" && (
        <div className="tiers">
          <span className="field-label">Employer match</span>
          {plan.matchTiers.length === 0 && <p className="muted small">No match entered. Add a tier, or leave empty if there's no match.</p>}
          {plan.matchTiers.map((tier, i) => (
            <div className="tier" key={i}>
              <NumberInput
                ariaLabel={`Match percent, tier ${i + 1}`}
                value={tier.matchPct}
                min={0}
                max={200}
                suffix="% match"
                onChange={(v) => setPlan({ matchTiers: plan.matchTiers.map((t, j) => (j === i ? { ...t, matchPct: v ?? 0 } : t)) })}
              />
              <span>on {i === 0 ? "the first" : "the next"}</span>
              <NumberInput
                ariaLabel={`Up to percent of pay, tier ${i + 1}`}
                value={tier.upToPct}
                min={0}
                max={100}
                step={0.5}
                suffix="% of pay"
                onChange={(v) => setPlan({ matchTiers: plan.matchTiers.map((t, j) => (j === i ? { ...t, upToPct: v ?? 0 } : t)) })}
              />
              <button type="button" className="link" onClick={() => setPlan({ matchTiers: plan.matchTiers.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
          ))}
          {plan.matchTiers.length < 5 && (
            <button
              type="button"
              className="secondary small"
              onClick={() => setPlan({ matchTiers: [...plan.matchTiers, { matchPct: plan.matchTiers.length === 0 ? 100 : 50, upToPct: 3 }] })}
            >
              Add match tier
            </button>
          )}
          <p className="muted small">Example: “100% on the first 3%, 50% on the next 2%” is two tiers.</p>
        </div>
      )}

      <h4>Social Security</h4>
      <p className="muted small">
        Monthly estimates from your statement at ssa.gov/myaccount. Leave blank if you don't know yet.
      </p>
      <div className="form-grid">
        <Field label="Monthly at 62">
          <MoneyInput value={ss.at62} onChange={(v) => setSs({ at62: v })} />
        </Field>
        <Field label="Monthly at full retirement age">
          <MoneyInput value={ss.atFra} onChange={(v) => setSs({ atFra: v })} />
        </Field>
        <Field label="Monthly at 70">
          <MoneyInput value={ss.at70} onChange={(v) => setSs({ at70: v })} />
        </Field>
        <Field label="Plan to claim at">
          <NumberInput value={value.ssClaimAge} min={62} max={70} onChange={(v) => onChange({ ...value, ssClaimAge: v ?? 67 })} />
        </Field>
      </div>

      <h4>Pension</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={value.pension !== null}
          onChange={(e) => onChange({ ...value, pension: e.target.checked ? { monthly: 0, startAge: 65, cola: false } : null })}
        />
        {value.name || "This person"} will get a pension
      </label>
      {value.pension && (
        <div className="form-grid">
          <Field label="Monthly amount">
            <MoneyInput value={value.pension.monthly} onChange={(v) => onChange({ ...value, pension: { ...value.pension!, monthly: v ?? 0 } })} />
          </Field>
          <Field label="Starts at age">
            <NumberInput
              value={value.pension.startAge}
              min={40}
              max={80}
              onChange={(v) => onChange({ ...value, pension: { ...value.pension!, startAge: v ?? 65 } })}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={value.pension.cola}
              onChange={(e) => onChange({ ...value, pension: { ...value.pension!, cola: e.target.checked } })}
            />
            Rises with inflation (COLA)
          </label>
        </div>
      )}
    </div>
  );
}

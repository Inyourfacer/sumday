import type { Person } from "../../shared/schemas.ts";

export type PersonDraft = Omit<Person, "id"> & { id?: number };

export function newPerson(name = ""): PersonDraft {
  return {
    name,
    birthDate: null,
    retirementAge: 65,
    income: null,
    raisePct: 3,
    socialSecurity: { at62: null, atFra: null, at70: null },
    ssClaimAge: 67,
    pension: null,
    employerPlan: { type: "none", matchTiers: [], pretaxPct: 0, rothPct: 0, hsaPayrollAnnual: 0 },
  };
}

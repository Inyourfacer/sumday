/**
 * Scenario overrides: changes applied on top of the real plan before it's
 * simulated ("retire at 60", "Sam stops working", "buy a house in 2029").
 */
import { retirementYear, type SimInput } from "./montecarlo.ts";

export type Override =
  | { type: "retirement_age"; personId: number; age: number }
  | { type: "income"; personId: number; income: number; pretaxPct: number | null }
  | { type: "extra_savings"; monthly: number }
  | { type: "retirement_spending"; annualChange: number }
  | { type: "lump_sum"; label: string; year: number; amount: number }
  | { type: "allocation"; stocks: number; bonds: number; cash: number }
  | { type: "home_purchase"; year: number; downPayment: number; monthlyCostChange: number };

/** A new input with the overrides applied; the original is untouched. */
export function applyOverrides(base: SimInput, overrides: readonly Override[]): SimInput {
  const input: SimInput = {
    ...base,
    people: base.people.map((p) => ({ ...p })),
    extraSavings: { ...base.extraSavings, traditional: { ...base.extraSavings.traditional } },
    spending: [...base.spending],
    lumpSums: [...(base.lumpSums ?? [])],
    allocation: { ...base.allocation },
  };
  // People first: retirement timing depends on them.
  for (const o of overrides) {
    const person = "personId" in o ? input.people.find((p) => p.id === o.personId) : undefined;
    if (o.type === "retirement_age" && person) person.retirementAge = o.age;
    if (o.type === "income" && person) {
      person.income = o.income;
      if (o.pretaxPct !== null) person.pretaxPct = o.pretaxPct;
    }
    if (o.type === "allocation") {
      const total = o.stocks + o.bonds + o.cash || 1;
      input.allocation = { stocks: o.stocks / total, bonds: o.bonds / total, cash: o.cash / total };
    }
  }
  const retireYear = retirementYear(input);
  for (const o of overrides) {
    if (o.type === "extra_savings") input.extraSavings.taxable += o.monthly * 12;
    if (o.type === "retirement_spending") input.spending = input.spending.map((s) => Math.max(0, s + o.annualChange));
    if (o.type === "lump_sum") input.lumpSums!.push({ year: o.year, amount: o.amount });
    if (o.type === "home_purchase") {
      input.lumpSums!.push({ year: o.year, amount: -o.downPayment });
      const yearly = o.monthlyCostChange * 12;
      // In retirement the new housing cost is spending; before that it comes out of what's saved.
      input.spending = input.spending.map((s, t) => (input.startYear + t >= o.year ? Math.max(0, s + yearly) : s));
      for (let y = Math.max(o.year, input.startYear); y < retireYear; y++) input.lumpSums!.push({ year: y, amount: -yearly });
    }
  }
  return input;
}

const usd = (c: number) => `${c < 0 ? "-" : ""}$${Math.round(Math.abs(c) / 100).toLocaleString("en-US")}`;

/** One line per override, for lists and confirmations. */
export function describeOverride(o: Override, names: ReadonlyMap<number, string>): string {
  const who = (id: number) => names.get(id) ?? "Someone";
  switch (o.type) {
    case "retirement_age":
      return `${who(o.personId)} retires at ${o.age}`;
    case "income":
      return o.income === 0
        ? `${who(o.personId)} stops working`
        : `${who(o.personId)} earns ${usd(o.income)}/yr${o.pretaxPct !== null ? `, saving ${o.pretaxPct}% at work` : ""}`;
    case "extra_savings":
      return o.monthly >= 0 ? `Save ${usd(o.monthly)}/mo more` : `Save ${usd(-o.monthly)}/mo less`;
    case "retirement_spending":
      return `Spend ${o.annualChange >= 0 ? `${usd(o.annualChange)} more` : `${usd(-o.annualChange)} less`} a year in retirement`;
    case "lump_sum":
      return `${o.label}: ${o.amount > 0 ? "+" : ""}${usd(o.amount)} in ${o.year}`;
    case "allocation":
      return `Mix: ${Math.round(o.stocks * 100)}% stocks / ${Math.round(o.bonds * 100)}% bonds / ${Math.round(o.cash * 100)}% cash`;
    case "home_purchase":
      return `Buy a home in ${o.year}: ${usd(o.downPayment)} down, housing ${o.monthlyCostChange >= 0 ? "+" : ""}${usd(o.monthlyCostChange)}/mo`;
  }
}

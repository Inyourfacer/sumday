/**
 * How long people live, as a random draw instead of a fixed age (DESIGN §11).
 *
 * A Gompertz curve: the chance of dying rises by a constant share each year of
 * age. It needs two numbers: the most common age at death (`mode`) and how
 * spread out deaths are (`dispersion`, in years).
 *
 * The defaults (87 and 10) were fitted to the SSA 2023 period life table
 * (`data/mortality/ssa-period-2023.json`), averaging men and women who are 65.
 * For someone alive at 65 the curve gives 51% alive at 85, 29% at 90, 12% at
 * 95 and 3% at 100, within about a point of the table at every age from 70 to
 * 105 (a test holds it there). It fits one sex at a time less well: men peak
 * near 85 and women near 89, so a single curve overstates a man's lifespan and
 * understates a woman's. A period table also leaves out future gains in life
 * expectancy, and people with higher incomes tend to outlive the population
 * average, so shift the mode up for either reason.
 */
export interface Mortality {
  /** Most common age at death. */
  mode: number;
  /** Spread of ages at death, in years. */
  dispersion: number;
  /** Nobody lives past this age. */
  maxAge: number;
  /** Household spending after one person dies, as a percentage of the plan. */
  survivorSpendingPct: number;
}

export const DEFAULT_MORTALITY: Mortality = { mode: 87, dispersion: 10, maxAge: 110, survivorSpendingPct: 75 };

/** Chance of living from `age` to `to`, given alive at `age`. */
export function survival(age: number, to: number, m: Pick<Mortality, "mode" | "dispersion">): number {
  if (to <= age) return 1;
  return Math.exp(Math.exp((age - m.mode) / m.dispersion) * (1 - Math.exp((to - age) / m.dispersion)));
}

/** Age at death for a uniform draw `u` in (0,1), given alive at `age`. */
export function deathAge(age: number, u: number, m: Mortality): number {
  const safe = Math.min(1 - 1e-12, Math.max(1e-12, u));
  const x = age + m.dispersion * Math.log(1 - Math.log(safe) * Math.exp((m.mode - age) / m.dispersion));
  return Math.min(m.maxAge, Math.max(age, x));
}

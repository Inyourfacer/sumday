/**
 * How long people live, as a random draw instead of a fixed age (DESIGN §11).
 *
 * A Gompertz curve: the chance of dying rises by a constant share each year of
 * age. It needs two numbers: the most common age at death (`mode`) and how
 * spread out deaths are (`dispersion`, in years). Defaults of 88 and 10 give
 * roughly the pattern of US adults who reach their 60s: a median in the
 * mid-80s and about one in ten reaching 100 from 65. These are round numbers,
 * not a life table; replace them in Settings if you have reason to.
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

export const DEFAULT_MORTALITY: Mortality = { mode: 88, dispersion: 10, maxAge: 110, survivorSpendingPct: 75 };

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

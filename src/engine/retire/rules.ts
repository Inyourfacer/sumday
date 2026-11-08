/**
 * Retirement rules: Social Security claiming math, required minimum
 * distributions, and a seeded random number generator so every simulation
 * is repeatable.
 */

/** mulberry32: a small, fast, seedable PRNG. Same seed → same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Social Security full retirement age (SSA): 66 for 1943–1954 births, rising
 * two months a year to 67 for 1960 and later.
 */
export function fullRetirementAge(birthYear: number): number {
  if (birthYear <= 1954) return 66;
  if (birthYear >= 1960) return 67;
  return 66 + ((birthYear - 1954) * 2) / 12;
}

export interface SsEstimates {
  at62: number | null;
  atFra: number | null;
  at70: number | null;
}

/**
 * Monthly benefit when claiming at `claimAge`, from the estimates on an SSA
 * statement. With the full-retirement-age amount, uses SSA's formulas:
 * 5/9% less per month for the first 36 months early, 5/12% per month beyond
 * that; 2/3% more per month of delay up to 70. Without it, interpolates
 * between the amounts given. Returns null with no estimates at all.
 */
export function benefitAtClaim(ss: SsEstimates, claimAge: number, birthYear: number): number | null {
  const fra = fullRetirementAge(birthYear);
  const age = Math.min(70, Math.max(62, claimAge));
  if (ss.atFra !== null) {
    if (age < fra) {
      const months = Math.round((fra - age) * 12);
      const cut = (Math.min(months, 36) * 5) / 9 / 100 + (Math.max(months - 36, 0) * 5) / 12 / 100;
      return Math.round(ss.atFra * (1 - cut));
    }
    const months = Math.round((age - fra) * 12);
    return Math.round(ss.atFra * (1 + (months * 2) / 3 / 100));
  }
  const points = [
    [62, ss.at62],
    [70, ss.at70],
  ].filter((p): p is [number, number] => p[1] !== null);
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]![1];
  const [[a0, v0], [a1, v1]] = points as [[number, number], [number, number]];
  return Math.round(v0 + ((v1 - v0) * (age - a0)) / (a1 - a0));
}

export interface RmdTable {
  startAge: { bornThrough: number; age: number }[];
  uniformLifetime: Record<string, number>;
}

export function rmdStartAge(table: RmdTable, birthYear: number): number {
  return (table.startAge.find((s) => birthYear <= s.bornThrough) ?? table.startAge.at(-1)!).age;
}

const maxAge = new WeakMap<RmdTable, number>();

/** Required withdrawal this year: last year-end balance ÷ the IRS divisor for this age. */
export function requiredMinimum(table: RmdTable, age: number, balance: number): number {
  if (balance <= 0) return 0;
  let top = maxAge.get(table);
  if (top === undefined) {
    top = Math.max(...Object.keys(table.uniformLifetime).map(Number));
    maxAge.set(table, top);
  }
  const divisor = table.uniformLifetime[String(Math.min(age, top))];
  if (divisor === undefined) return 0;
  return Math.round(balance / divisor);
}

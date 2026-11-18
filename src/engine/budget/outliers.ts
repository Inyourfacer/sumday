/**
 * What counts as an unusually large charge in a category. A fixed multiple of
 * the median flags ordinary swings in noisy categories (dining out, shopping),
 * so the bar also rises with how much the category normally varies.
 */

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median absolute deviation scaled to match a standard deviation for bell-shaped data. */
export function robustSpread(values: readonly number[]): number {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

export interface Usual {
  median: number;
  /** A charge above this is unusual for the category. */
  threshold: number;
}

/**
 * The user's multiple of the median is the lowest the bar can be, so this only
 * ever flags less than that rule alone: it raises the bar where the category
 * is naturally spread out (median plus four robust standard deviations).
 * Needs at least 5 past charges; null otherwise.
 */
export function usualFor(values: readonly number[], multiple: number): Usual | null {
  if (values.length < 5) return null;
  const m = median(values);
  return { median: m, threshold: Math.max(m * multiple, m + 4 * robustSpread(values)) };
}

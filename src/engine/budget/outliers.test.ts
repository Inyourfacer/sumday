import { describe, expect, it } from "vitest";
import { median, robustSpread, usualFor } from "./outliers.ts";

describe("unusual charges", () => {
  it("computes the median and a robust spread", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(robustSpread([10, 10, 10, 10, 10])).toBe(0);
    // One wild value barely moves a robust spread.
    expect(robustSpread([10, 11, 9, 10, 10, 11, 9, 1000])).toBeLessThan(3);
  });

  it("needs history before judging", () => {
    expect(usualFor([100, 100, 100, 100], 3)).toBeNull();
  });

  it("keeps the user's multiple as the lowest bar for steady categories", () => {
    const u = usualFor([10_000, 10_000, 10_000, 10_000, 10_000], 3)!;
    expect(u.median).toBe(10_000);
    expect(u.threshold).toBe(30_000);
  });

  it("raises the bar where a category is naturally spread out", () => {
    // Dining out: usually $20 to $200 and a median near $60; three times the median ($180) would flag ordinary nights out.
    const dining = [2_000, 3_500, 4_500, 6_000, 6_000, 7_500, 9_000, 12_000, 15_000, 20_000];
    const u = usualFor(dining, 3)!;
    expect(u.threshold).toBeGreaterThan(u.median * 3);
    // A genuinely odd charge still gets caught.
    expect(100_000).toBeGreaterThan(u.threshold);
  });
});

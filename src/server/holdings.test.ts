import { describe, expect, it } from "vitest";
import { latestExpectedClose } from "./holdings.ts";

describe("latestExpectedClose", () => {
  it("is yesterday on weekdays and Friday over the weekend", () => {
    expect(latestExpectedClose("2026-11-04")).toBe("2026-11-03"); // Wednesday → Tuesday
    expect(latestExpectedClose("2026-11-07")).toBe("2026-11-06"); // Saturday → Friday
    expect(latestExpectedClose("2026-11-08")).toBe("2026-11-06"); // Sunday → Friday
    expect(latestExpectedClose("2026-11-09")).toBe("2026-11-06"); // Monday → Friday
    expect(latestExpectedClose("2026-11-10")).toBe("2026-11-09"); // Tuesday → Monday
  });
});

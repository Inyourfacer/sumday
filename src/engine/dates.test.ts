import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  addYears,
  ageOn,
  compareDates,
  daysBetween,
  daysInMonth,
  endOfMonth,
  isIsoDate,
  isLeapYear,
  monthKey,
  monthsBetween,
  parseIsoDate,
  startOfMonth,
  todayIn,
  toIsoDate,
} from "./dates.ts";

describe("validation", () => {
  it("accepts real dates only", () => {
    expect(isIsoDate("2026-11-08")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-04-31")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-1-5")).toBe(false);
    expect(isIsoDate("11/08/2026")).toBe(false);
    expect(isIsoDate(20261108)).toBe(false);
  });

  it("parses and rebuilds", () => {
    expect(parseIsoDate("2026-11-08")).toEqual({ year: 2026, month: 11, day: 8 });
    expect(toIsoDate({ year: 2026, month: 3, day: 1 })).toBe("2026-03-01");
    expect(() => parseIsoDate("2026-02-30")).toThrow(SyntaxError);
    expect(() => toIsoDate({ year: 2026, month: 2, day: 30 })).toThrow(RangeError);
  });

  it("knows leap years and month lengths", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe("arithmetic", () => {
  it("adds days across months, years and DST changes", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    // US DST starts 2026-03-08; a calendar date must not drift.
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(() => addDays("2026-01-01", 1.5)).toThrow(RangeError);
  });

  it("adds months and clamps to month end", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -13)).toBe("2024-12-15");
    expect(addYears("2028-02-29", 1)).toBe("2029-02-28");
  });

  it("measures gaps", () => {
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
    expect(daysBetween("2028-01-01", "2029-01-01")).toBe(366);
    expect(daysBetween("2026-11-08", "2026-11-01")).toBe(-7);
    expect(monthsBetween("2026-01-31", "2026-03-01")).toBe(2);
    expect(monthsBetween("2026-11-08", "2025-11-08")).toBe(-12);
  });

  it("compares as strings sort", () => {
    expect(compareDates("2026-01-02", "2026-01-10")).toBe(-1);
    expect(compareDates("2026-01-10", "2026-01-10")).toBe(0);
    expect(["2026-03-01", "2025-12-31", "2026-01-15"].sort(compareDates)).toEqual([
      "2025-12-31",
      "2026-01-15",
      "2026-03-01",
    ]);
  });
});

describe("months", () => {
  it("finds month keys and bounds", () => {
    expect(monthKey("2026-11-08")).toBe("2026-11");
    expect(startOfMonth("2026-11-08")).toBe("2026-11-01");
    expect(endOfMonth("2026-11-08")).toBe("2026-11-30");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
  });
});

describe("ageOn", () => {
  it("counts whole years", () => {
    expect(ageOn("1985-06-15", "2026-06-14")).toBe(40);
    expect(ageOn("1985-06-15", "2026-06-15")).toBe(41);
  });

  it("ages a Feb 29 birthday on Mar 1 in non-leap years", () => {
    expect(ageOn("2000-02-29", "2026-02-28")).toBe(25);
    expect(ageOn("2000-02-29", "2026-03-01")).toBe(26);
    expect(ageOn("2000-02-29", "2028-02-29")).toBe(28);
  });
});

describe("todayIn", () => {
  it("uses the household time zone, not UTC", () => {
    // 03:30 UTC on Nov 9 is still the evening of Nov 8 in Chicago.
    const instant = new Date("2026-11-09T03:30:00Z");
    expect(todayIn("UTC", instant)).toBe("2026-11-09");
    expect(todayIn("America/Chicago", instant)).toBe("2026-11-08");
    expect(todayIn("Asia/Tokyo", instant)).toBe("2026-11-09");
  });
});

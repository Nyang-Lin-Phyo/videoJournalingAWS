import { describe, it, expect } from "vitest";
import { dayCover, localDayKey, localMonthRange, monthDaySlots, shiftMonth, journalsByLocalDay } from "../src/cloud/calendarDates";
import type { JournalSummary } from "../src/cloud/analysisApi";

function entry(id: string, when: string, sentiment: JournalSummary["sentiment"]): JournalSummary {
  return { upload_id: id, created_at: when, sentiment, status: "completed", title: id };
}

describe("calendar date and sentiment aggregation", () => {
  it("moves through year boundaries and retains 42 cells for every month", () => {
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthDaySlots("2026-11")).toHaveLength(42);
    expect(monthDaySlots("2027-02").filter(Boolean)).toHaveLength(28);
  });

  it("matches the existing timeline's local-day grouping", () => {
    const rows = [
      entry("one", "2026-11-14T12:00:00Z", "positive"),
      entry("two", "2026-11-14T18:00:00Z", "negative"),
    ];
    const byDay = journalsByLocalDay(rows);
    expect(byDay.get(localDayKey(rows[0]!.created_at))).toHaveLength(2);
    expect(dayCover(rows)).toContain("#f7c46b");
    expect(dayCover(rows)).toContain("#56658f");
    expect(dayCover([rows[0]!])).toContain("#ef7d44");
  });

  it("generates month boundaries in local time, not UTC calendar dates", () => {
    const { start, end } = localMonthRange("2026-11");
    expect(new Date(start).getTime()).toBe(new Date(2026, 10, 1).getTime());
    expect(new Date(end).getTime()).toBe(new Date(2026, 11, 1).getTime());
    expect(Date.parse(end)).toBeGreaterThan(Date.parse(start));
  });
});

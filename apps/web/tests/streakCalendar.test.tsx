import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CalendarOverview } from "../src/cloud/CalendarOverview";
import type { JournalSummary } from "../src/cloud/analysisApi";

const uploaded: JournalSummary = {
  upload_id: "test-video",
  title: "A journal",
  created_at: "2026-11-25T14:00:00.000Z",
  status: "completed",
  sentiment: "positive",
};

describe("streak-aware calendar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("keeps uploaded days colorful, freezes blue, missed past days gray, and today/future days white", () => {
    const monthData = new Map<string, JournalSummary[]>([["2026-11", [uploaded]]]);
    const { container } = render(
      <CalendarOverview
        initialMonth="2026-11"
        visibleMonth="2026-11"
        onVisibleMonthChange={vi.fn()}
        monthData={monthData}
        loading={false}
        error={null}
        onSelectDay={vi.fn()}
        streak={{ today_local_date: "2026-11-26", frozen_local_dates: ["2026-11-24"] }}
      />,
    );
    const november = container.querySelector('[data-month="2026-11"]');
    expect(november).not.toBeNull();
    const findDay = (day: number) => within(november as HTMLElement).getByRole("gridcell", { name: new RegExp(`November 2026 ${day}:`) });
    expect(findDay(25)).toHaveClass("has-journals");
    expect(findDay(24)).toHaveClass("is-frozen");
    expect(findDay(24)).toHaveTextContent("❄");
    expect(findDay(23)).toHaveClass("is-missed");
    expect(findDay(26)).toHaveClass("is-future");
    expect(findDay(27)).toHaveClass("is-future");
    expect(screen.getByRole("button", { name: "Older month" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Newer month" })).toBeDisabled();
  });

  it("renders older months above the current month and preserves weekday-aligned empty slots", () => {
    const { container } = render(
      <CalendarOverview
        initialMonth="2026-11"
        visibleMonth="2026-11"
        onVisibleMonthChange={vi.fn()}
        monthData={new Map()}
        loading={false}
        error={null}
        onSelectDay={vi.fn()}
        streak={null}
      />,
    );
    const months = [...container.querySelectorAll<HTMLElement>(".calendar-month")];
    expect(months[0]?.dataset.month).toMatch(/^2025-/);
    expect(months.at(-1)?.dataset.month).toBe("2026-11");
    const november = container.querySelector('[data-month="2026-11"]');
    expect(november).not.toBeNull();
    // November 1, 2026 was a Sunday, so the first slot of its grid is day 1.
    expect((november as HTMLElement).querySelectorAll(".calendar-grid > *")[7]).toHaveAttribute("aria-label", expect.stringContaining("November 2026 1:"));
    const october = container.querySelector('[data-month="2026-10"]');
    // October 1, 2026 was a Thursday, so there are four leading blanks.
    const slots = (october as HTMLElement).querySelectorAll(".calendar-grid > *");
    expect([...slots].slice(7, 11).every(element => element.classList.contains("calendar-blank"))).toBe(true);
  });
});

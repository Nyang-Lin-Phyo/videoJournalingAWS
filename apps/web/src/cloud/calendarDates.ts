import type { JournalSummary } from "./analysisApi";
import { blendedCover, MOOD_GRADIENTS } from "./historyTimeline";

/** The browser's local date is the display date for both Timeline and Calendar. */
export function localDayKey(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function monthKeyFromDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

export function monthOfDay(dayKey: string): string {
  return dayKey.slice(0, 7);
}

export function shiftMonth(key: string, offset: number): string {
  const [year, month] = key.split("-").map(Number);
  return monthKeyFromDate(new Date(year!, month! - 1 + offset, 1));
}

export function monthDistance(newer: string, older: string): number {
  const [newYear, newMonth] = newer.split("-").map(Number);
  const [oldYear, oldMonth] = older.split("-").map(Number);
  return (newYear! - oldYear!) * 12 + newMonth! - oldMonth!;
}

/** UTC timestamp boundaries corresponding to local midnights. Handles DST. */
export function localMonthRange(key: string): { start: string; end: string } {
  const [year, month] = key.split("-").map(Number);
  return {
    start: new Date(year!, month! - 1, 1).toISOString(),
    end: new Date(year!, month!, 1).toISOString(),
  };
}

export function monthDaySlots(key: string): (number | null)[] {
  const [year, month] = key.split("-").map(Number);
  const offset = new Date(year!, month! - 1, 1).getDay();
  const count = new Date(year!, month!, 0).getDate();
  // Always six rows to prevent a jump in grid height between months.
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    return day >= 1 && day <= count ? day : null;
  });
}

export function journalsByLocalDay(journals: JournalSummary[]): Map<string, JournalSummary[]> {
  const result = new Map<string, JournalSummary[]>();
  for (const journal of journals) {
    const day = localDayKey(journal.created_at);
    result.set(day, [...(result.get(day) ?? []), journal]);
  }
  return result;
}

export function dayCover(journals: JournalSummary[]): string {
  if (journals.length > 1) return blendedCover(journals);
  return `linear-gradient(135deg, ${(MOOD_GRADIENTS[journals[0]?.sentiment ?? "pending"] ?? MOOD_GRADIENTS.pending).join(", ")})`;
}

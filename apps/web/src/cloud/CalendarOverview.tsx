import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JournalSummary, StreakSummary } from "./analysisApi";
import { dayCover, journalsByLocalDay, monthDaySlots, monthDistance, monthKeyFromDate, shiftMonth } from "./calendarDates";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PAGE_SIZE = 12;

type CalendarOverviewProps = {
  initialMonth: string;
  visibleMonth: string;
  onVisibleMonthChange: (month: string) => void;
  monthData: ReadonlyMap<string, JournalSummary[]>;
  loading: boolean;
  error: string | null;
  onSelectDay: (day: string) => void;
  streak: Pick<StreakSummary, "today_local_date" | "frozen_local_dates"> | null;
};

function browserTodayKey() {
  const now = new Date();
  return `${monthKeyFromDate(now)}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Apple-style month browsing: older months live above the current month, so
 * scrolling upward moves into the past and scrolling downward returns toward
 * the present. Native overflow scrolling and month-level scroll-snap keep the
 * interaction predictable across trackpads, wheels, and touch.
 */
export function CalendarOverview({ initialMonth, visibleMonth, onVisibleMonthChange, monthData, loading, error, onSelectDay, streak }: CalendarOverviewProps) {
  const todayMonth = monthKeyFromDate(new Date());
  const [oldestMonth, setOldestMonth] = useState(() => shiftMonth(initialMonth, -PAGE_SIZE));
  const scrollRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const prependedPages = useRef(0);
  const monthChanged = useRef(onVisibleMonthChange);
  useEffect(() => { monthChanged.current = onVisibleMonthChange; }, [onVisibleMonthChange]);

  const months = useMemo(() => {
    const count = Math.max(0, monthDistance(todayMonth, oldestMonth));
    return Array.from({ length: count + 1 }, (_, index) => shiftMonth(oldestMonth, index));
  }, [todayMonth, oldestMonth]);

  const entriesByMonth = useMemo(() => new Map([...monthData].map(([key, rows]) => [key, journalsByLocalDay(rows)])), [monthData]);
  const [needsOlderMonths, setNeedsOlderMonths] = useState(false);
  const todayKey = streak?.today_local_date ?? browserTodayKey();
  const frozenDays = useMemo(() => new Set(streak?.frozen_local_dates ?? []), [streak]);

  useLayoutEffect(() => {
    if (started.current) return;
    const scroller = scrollRef.current;
    if (!scroller || !scroller.clientHeight) return;
    started.current = true;
    const index = months.indexOf(initialMonth);
    if (index >= 0) scroller.scrollTop = index * scroller.clientHeight;
  }, [initialMonth, months]);

  useLayoutEffect(() => {
    const added = prependedPages.current;
    const scroller = scrollRef.current;
    if (!added || !scroller || !scroller.clientHeight) return;
    scroller.scrollTop += added * scroller.clientHeight;
    prependedPages.current = 0;
  }, [months]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const index = Math.max(0, Math.min(months.length - 1, Math.round(scroller.scrollTop / Math.max(1, scroller.clientHeight))));
        const shown = months[index];
        if (shown) monthChanged.current(shown);
        if (index <= 2) setNeedsOlderMonths(true);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [months]);

  useEffect(() => {
    if (!needsOlderMonths) return;
    prependedPages.current += PAGE_SIZE;
    setOldestMonth(month => shiftMonth(month, -PAGE_SIZE));
    setNeedsOlderMonths(false);
  }, [needsOlderMonths]);

  function navigate(direction: -1 | 1) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollBy({
      top: direction * scroller.clientHeight,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }

  return (
    <section className="calendar-overview" aria-label="Journal calendar by month">
      <div className="calendar-controls">
        <p className="calendar-help">Scroll up for earlier months and down for newer ones, or use the arrows.</p>
        <div className="calendar-arrows">
          <button type="button" aria-label="Older month" onClick={() => navigate(-1)}>↑</button>
          <button type="button" aria-label="Newer month" disabled={visibleMonth === todayMonth} onClick={() => navigate(1)}>↓</button>
        </div>
      </div>
      <div className="calendar-scroller" ref={scrollRef} role="region" tabIndex={0} aria-label="Scroll months">
        {months.map(month => {
          const [year, num] = month.split("-").map(Number);
          const title = new Date(year!, num! - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
          const current = month === visibleMonth;
          return (
            <section className="calendar-month" key={month} aria-label={title} data-month={month}>
              <header className="calendar-month-header">
                <div>
                  <span className="calendar-month-eyebrow">A MONTH IN MOMENTS</span>
                  <h2>{title}</h2>
                </div>
                {current && <span className="calendar-month-count">
                  {loading ? "Loading…" : `${(monthData.get(month)?.length ?? 0)} moment${monthData.get(month)?.length === 1 ? "" : "s"}`}
                </span>}
              </header>
              {current && error && <p className="calendar-load-error" role="alert">{error}</p>}
              <div className="calendar-grid" role="grid" aria-label={title}>
                {WEEKDAYS.map(day => <span key={`${month}-${day}`} role="columnheader" className="calendar-weekday">{day}</span>)}
                {monthDaySlots(month).map((day, index) => {
                  const date = day === null ? "" : `${month}-${String(day).padStart(2, "0")}`;
                  const today = date === todayKey;
                  const dayJournals = entriesByMonth.get(month)?.get(date) ?? [];
                  const count = dayJournals.length;
                  const isFuture = !count && date >= todayKey;
                  const isFrozen = !count && !isFuture && frozenDays.has(date);
                  const knownMonth = monthData.has(month);
                  const isMissed = !count && knownMonth && !isFuture && !isFrozen;

                  if (day === null) {
                    return <span key={`${month}-blank-${index}`} className="calendar-blank" role="gridcell" />;
                  }

                  const stateClass = count ? "has-journals" : isFrozen ? "is-frozen" : isMissed ? "is-missed" : "is-future";
                  const ariaLabel = count
                    ? `${title} ${day}: ${count} journal${count === 1 ? "" : "s"}, open in timeline`
                    : isFrozen
                      ? `${title} ${day}: freeze used`
                      : isFuture
                        ? `${title} ${day}: today or future day`
                        : !knownMonth
                          ? `${title} ${day}: journal history not loaded yet`
                          : `${title} ${day}: missed day`;
                  const titleText = count
                    ? `Open ${count} moment${count > 1 ? "s" : ""} in Timeline`
                    : isFrozen
                      ? "A streak freeze protected this day"
                      : isFuture
                        ? "Today or future day"
                        : !knownMonth
                          ? "Journal history loading"
                          : "No upload on this day";

                  return (
                    <button
                      key={date}
                      type="button"
                      role="gridcell"
                      disabled={!count}
                      className={`calendar-day ${stateClass}${today ? " is-today" : ""}`}
                      style={count ? { background: dayCover(dayJournals) } : undefined}
                      aria-label={ariaLabel}
                      title={titleText}
                      onClick={() => onSelectDay(date)}
                    >
                      <span>{day}</span>
                      {count > 1 && <span className="calendar-day-count" aria-hidden="true">{count}</span>}
                      {isFrozen && <span className="calendar-freeze-mark" aria-hidden="true">❄</span>}
                    </button>
                  );
                })}
              </div>
              <p className="calendar-month-footer">
                {current && !loading && !error && monthData.has(month) && monthData.get(month)?.length === 0
                  ? "No journals this month yet."
                  : "Journal days keep their reflection colors. Gray means a missed day, and blue means a streak freeze was used."}
              </p>
            </section>
          );
        })}
      </div>
      <div className="calendar-legend" aria-label="Color key">
        <span><i className="uploaded" />Journal day</span>
        <span><i className="frozen" />Freeze used</span>
        <span><i className="missed" />Missed day</span>
        <span><i className="future" />Future day</span>
      </div>
    </section>
  );
}

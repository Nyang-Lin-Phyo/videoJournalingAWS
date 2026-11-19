import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JournalSummary } from "./analysisApi";
import { dayCover, journalsByLocalDay, monthDaySlots, monthDistance, monthKeyFromDate, shiftMonth } from "./calendarDates";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PAGE_SIZE = 12;

/** Native overflow scrolling and month-level scroll-snap; no wheel-event hijacking. */
export function CalendarOverview({ initialMonth, visibleMonth, onVisibleMonthChange, monthData, loading, error, onSelectDay }: {
  initialMonth: string;
  visibleMonth: string;
  onVisibleMonthChange: (month: string) => void;
  monthData: ReadonlyMap<string, JournalSummary[]>;
  loading: boolean;
  error: string | null;
  onSelectDay: (day: string) => void;
}) {
  const todayMonth = monthKeyFromDate(new Date());
  const [oldestMonth, setOldestMonth] = useState(() => shiftMonth(initialMonth, -PAGE_SIZE));
  const scrollRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const monthChanged = useRef(onVisibleMonthChange);
  useEffect(() => { monthChanged.current = onVisibleMonthChange; }, [onVisibleMonthChange]);
  const months = useMemo(() => {
    const count = Math.max(0, monthDistance(todayMonth, oldestMonth));
    return Array.from({ length: count + 1 }, (_, index) => shiftMonth(todayMonth, -index));
  }, [todayMonth, oldestMonth]);
  const entriesByMonth = useMemo(() => new Map([...monthData].map(([key, rows]) => [key, journalsByLocalDay(rows)])), [monthData]);
  const [isAppending, setIsAppending] = useState(false);

  useLayoutEffect(() => {
    if (started.current) return;
    const scroller = scrollRef.current;
    if (!scroller || !scroller.clientHeight) return;
    started.current = true;
    const index = months.indexOf(initialMonth);
    if (index >= 0) scroller.scrollTop = index * scroller.clientHeight;
  }, [initialMonth, months]);

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
        // Extend backward in chunks so users can keep exploring older years.
        if (index >= months.length - 3) setIsAppending(true);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [months]);

  useEffect(() => {
    if (!isAppending) return;
    setOldestMonth(month => shiftMonth(month, -PAGE_SIZE));
    setIsAppending(false);
  }, [isAppending]);

  function navigate(direction: number) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const index = Math.max(0, months.indexOf(visibleMonth));
    const target = Math.max(0, Math.min(months.length - 1, index + direction));
    scroller.scrollTo({
      top: target * scroller.clientHeight,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }

  return (
    <section className="calendar-overview" aria-label="Journal calendar by month">
      <div className="calendar-controls">
        <p className="calendar-help">Scroll to move between months, or use the arrows.</p>
        <div className="calendar-arrows">
          <button type="button" aria-label="Newer month" disabled={visibleMonth === todayMonth} onClick={() => navigate(-1)}>↑</button>
          <button type="button" aria-label="Older month" onClick={() => navigate(1)}>↓</button>
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
                  const today = date === (() => { const now = new Date(); return `${monthKeyFromDate(now)}-${String(now.getDate()).padStart(2, "0")}`; })();
                  const dayJournals = entriesByMonth.get(month)?.get(date) ?? [];
                  const count = dayJournals.length;
                  return day === null ? <span key={`${month}-blank-${index}`} className="calendar-blank" role="gridcell"/> : (
                    <button
                      key={date}
                      type="button"
                      role="gridcell"
                      disabled={!count}
                      className={`calendar-day ${count ? "has-journals" : "is-empty"}${today ? " is-today" : ""}`}
                      style={count ? { background: dayCover(dayJournals) } : undefined}
                      aria-label={`${title} ${day}: ${count ? `${count} journal${count === 1 ? "" : "s"}, open in timeline` : "no journals"}`}
                      title={count ? `Open ${count} moment${count > 1 ? "s" : ""} in Timeline` : undefined}
                      onClick={() => onSelectDay(date)}
                    >
                      <span>{day}</span>
                      {count > 1 && <span className="calendar-day-count" aria-hidden="true">{count}</span>}
                    </button>
                  );
                })}
              </div>
              <p className="calendar-month-footer">{current && !loading && !error && monthData.has(month) && monthData.get(month)?.length === 0 ? "No journals this month yet." : "Each color comes from your saved journal reflections."}</p>
            </section>
          );
        })}
      </div>
      <div className="calendar-legend" aria-label="Color key">
        <span><i className="positive"/>Positive</span>
        <span><i className="negative"/>Negative</span>
        <span><i className="neutral"/>Neutral</span>
        <span><i className="mixed"/>Mixed</span>
        <span><i className="empty"/>No journal</span>
      </div>
    </section>
  );
}

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import type { JournalSummary } from "./analysisApi";
import { statusLabel } from "./historyTimeline";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), video[controls], [tabindex='0']";

/**
 * A reader-style dialog for a day with several journals: a grid of that day's
 * videos, and the full detail (video, transcript, reflection, actions) for
 * whichever one is chosen.
 */
export function DayStackDialog({ date, journals, openId, onSelect, onBack, onClose, renderDetail }: {
  date: Date;
  journals: JournalSummary[];
  openId: string | null;
  onSelect: (journal: JournalSummary) => void;
  onBack: () => void;
  onClose: () => void;
  renderDetail: (journal: JournalSummary) => ReactNode;
}) {
  const headingId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const lastOpened = useRef<string | null>(null);
  const [host] = useState(() => document.createElement("div"));
  const selected = journals.find(journal => journal.upload_id === openId) ?? null;
  const dayLabel = date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  useEffect(() => {
    // Same approach as the transcript reader: portal out of the timeline and
    // make everything behind the dialog inert until it closes.
    const opener = document.activeElement as HTMLElement | null;
    const backgrounds = Array.from(document.body.children).map(element => ({
      element: element as HTMLElement, inert: (element as HTMLElement).inert,
    }));
    document.body.appendChild(host);
    backgrounds.forEach(({ element }) => { element.inert = true; });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    return () => {
      backgrounds.forEach(({ element, inert }) => { element.inert = inert; });
      document.body.style.overflow = previousOverflow;
      host.remove();
      opener?.focus();
    };
  }, [host]);

  // Moving between the grid and a journal keeps keyboard focus somewhere sensible.
  useEffect(() => {
    if (selected) {
      lastOpened.current = selected.upload_id;
      backButton.current?.focus();
    } else if (lastOpened.current) {
      host.querySelector<HTMLElement>(`[data-journal="${lastOpened.current}"]`)?.focus();
    }
  }, [selected, host]);

  return createPortal(
    <div className="transcript-backdrop stack-backdrop" data-testid="stack-backdrop"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="transcript-reader stack-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}
        onKeyDown={event => {
          // Ignore keys from nested dialogs (e.g. the transcript reader portal).
          if (!event.currentTarget.contains(event.target as Node)) return;
          if (event.key === "Escape") {
            event.preventDefault();
            if (selected) onBack(); else onClose();
          }
          if (event.key === "Tab") {
            const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
              .filter(element => element.offsetParent !== null);
            const first = stops[0];
            const last = stops[stops.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header className="transcript-reader-header">
          <div>
            <p className="section-label"><Icon name="book" size={16} /> {journals.length} MOMENTS THIS DAY</p>
            <h2 id={headingId}>{dayLabel}</h2>
          </div>
          <button ref={closeButton} type="button" className="transcript-close" aria-label="Close day" onClick={onClose}>
            <Icon name="close" size={22} />
          </button>
        </header>
        <div className="transcript-reader-body stack-body">
          {selected ? (
            <div className="stack-detail" key={selected.upload_id}>
              <div className="stack-detail-head">
                <button ref={backButton} type="button" className="button button-secondary stack-back" onClick={onBack}>
                  <Icon name="back" size={16} /> All moments
                </button>
                <div>
                  <h3>{selected.title || "Untitled"}</h3>
                  <p className="muted">{new Date(selected.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {statusLabel(selected.status)}</p>
                </div>
              </div>
              {renderDetail(selected)}
            </div>
          ) : (
            <ul className="stack-grid" aria-label={`Journals from ${dayLabel}`}>
              {journals.map((journal, index) => (
                <li key={journal.upload_id} style={{ "--stack-i": index } as CSSProperties}>
                  <button type="button" className={`stack-tile tl-mood-${journal.sentiment ?? "pending"}`}
                    data-journal={journal.upload_id} onClick={() => onSelect(journal)}>
                    <span className="stack-thumb" aria-hidden="true">
                      <Icon name="video" size={26} />
                      <span className="stack-time">
                        {new Date(journal.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </span>
                    <span className="stack-tile-text">
                      <span className="history-title">{journal.title || "Untitled"}</span>
                      <span className="history-status">{statusLabel(journal.status)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="transcript-reader-footer">One day, many moments.</footer>
      </section>
    </div>, host,
  );
}

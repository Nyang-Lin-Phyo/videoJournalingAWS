import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import "./transcript.css";

const PREVIEW_LENGTH = 240;

export function TranscriptPanel({ transcript, title, pending = false }: {
  transcript?: string | null;
  title?: string;
  pending?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useCallback(() => trigger.current?.focus(), []);
  const text = transcript?.trim() ?? "";
  const preview = text.length > PREVIEW_LENGTH
    ? `${text.slice(0, PREVIEW_LENGTH).replace(/\s+\S*$/, "").trimEnd()}…`
    : text;

  return (
    <section className="panel transcript-panel" aria-labelledby={headingId}>
      <div className="panel-title">
        <h2 id={headingId}>In your words</h2>
        <span className="section-label">TRANSCRIPT</span>
      </div>
      {text ? <>
        <p className="transcript-preview">{preview}</p>
        <button ref={trigger} type="button" className="button button-secondary transcript-read"
          aria-haspopup="dialog" onClick={() => setIsOpen(true)}>
          <Icon name="book" size={17} /> Read full transcript <Icon name="arrow" size={16} />
        </button>
        <p className="transcript-hint">A moment to read, at your own pace.</p>
      </> : <p className="muted">{pending
        ? "Your transcript will appear here when it is available."
        : "No transcript is available for this entry."}</p>}
      {isOpen && text && <TranscriptReader text={text} title={title}
        onClose={() => setIsOpen(false)} returnFocus={returnFocus} />}
    </section>
  );
}

function TranscriptReader({ text, title, onClose, returnFocus }: {
  text: string; title?: string; onClose: () => void; returnFocus: () => void;
}) {
  const headingId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [host] = useState(() => document.createElement("div"));

  useEffect(() => {
    // A portal keeps the reader outside hidden history panels. Make the rest
    // of the document inert while it is open, then restore its previous state.
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
      returnFocus();
    };
  }, [host, returnFocus]);

  return createPortal(
    <div className="transcript-backdrop" data-testid="transcript-backdrop"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="transcript-reader" role="dialog" aria-modal="true" aria-labelledby={headingId}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key === "Tab") {
            const reader = event.currentTarget;
            const stops = Array.from(reader.querySelectorAll<HTMLElement>("button, [tabindex='0']"));
            const first = stops[0];
            const last = stops[stops.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header className="transcript-reader-header">
          <div>
            <p className="section-label"><Icon name="book" size={16} /> YOUR WORDS, KEPT</p>
            <h2 id={headingId}>Your transcript</h2>
            {title && <p className="transcript-reader-title">{title}</p>}
          </div>
          <button ref={closeButton} type="button" className="transcript-close" aria-label="Close transcript" onClick={onClose}>
            <Icon name="close" size={22} />
          </button>
        </header>
        <div className="transcript-reader-body" tabIndex={0} role="region" aria-label="Full transcript">
          <p>{text}</p>
        </div>
        <footer className="transcript-reader-footer">Your words. Your pace.</footer>
      </section>
    </div>, host,
  );
}

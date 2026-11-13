import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { journalApi } from "../api/client";
import type { JournalApi, JournalSummary } from "../api/types";
import { isProcessing } from "../api/types";
import { errorMessage, isAbort } from "../api/errors";
import { JournalCard } from "../components/JournalCard";
import { Icon } from "../components/Icon";
import { ErrorNotice, Loading } from "../components/Feedback";
const filters = [
  "All entries",
  "Ready",
  "Processing",
  "Needs attention",
] as const;
export function JournalListPage({ api = journalApi }: { api?: JournalApi }) {
  const [journals, setJournals] = useState<JournalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<(typeof filters)[number]>("All entries");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const results = await api.list(controller.signal);
        if (controller.signal.aborted) return;
        setJournals(results);
        setError(null);
        if (results.some((journal) => isProcessing(journal.status)))
          timer = setTimeout(() => {
            void load();
          }, 3000);
      } catch (err) {
        if (!controller.signal.aborted && !isAbort(err))
          setError(errorMessage(err));
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, revision]);
  const visible = journals?.filter(
    (journal) =>
      filter === "All entries" ||
      (filter === "Ready"
        ? journal.status === "completed"
        : filter === "Processing"
          ? isProcessing(journal.status)
          : journal.status === "failed" ||
            journal.status === "awaiting_upload"),
  );
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span /> YOUR SPACE TO SLOW DOWN
          </div>
          <h1>
            Life happens.
            <br />
            Make a little room for it.
          </h1>
          <p>
            A thought, a feeling, a day worth remembering.
            <br className="desktop-break" /> Keep it in your own words, at your
            own pace.
          </p>
          <Link className="button button-primary" to="/upload">
            <Icon name="plus" size={18} /> Create a new entry{" "}
            <Icon name="arrow" size={17} />
          </Link>
          <span className="hero-footnote">
            No perfect words needed. Just you.
          </span>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-sun" />
          <div className="art-window">
            <span className="art-hill back" />
            <span className="art-hill front" />
            <span className="art-path" />
          </div>
          <span className="art-caption">a moment, kept.</span>
          <svg
            className="art-sprig"
            viewBox="0 0 100 170"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M50 165C38 115 65 70 53 10M50 140C10 129 14 100 42 119M48 110C83 94 85 70 55 88M53 75C23 65 18 42 49 52M55 43C79 29 76 9 55 19" />
          </svg>
        </div>
      </section>
      <section className="journal-section" aria-labelledby="entries-heading">
        <div className="section-heading">
          <div>
            <div className="eyebrow muted">THE DAYS, IN YOUR WORDS</div>
            <h2 id="entries-heading">
              Your journal{" "}
              <span className="count">{journals?.length ?? "—"}</span>
            </h2>
          </div>
          <button
            className="button button-quiet button-small"
            onClick={() => setRevision((value) => value + 1)}
            aria-label="Refresh journal history"
          >
            <Icon name="refresh" size={16} /> Refresh
          </button>
        </div>
        <div
          className="filter-row"
          role="group"
          aria-label="Filter journal entries"
        >
          {filters.map((item) => (
            <button
              key={item}
              className={`filter ${filter === item ? "active" : ""}`}
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>
        {error && (
          <ErrorNotice
            message={error}
            onRetry={() => setRevision((value) => value + 1)}
          />
        )}
        {!journals && !error && <Loading />}
        {journals && !journals.length && (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="book" size={32} />
            </span>
            <h3>Your story starts here.</h3>
            <p>
              Save your first video journal. There is no right way to begin.
            </p>
            <Link to="/upload" className="button button-primary">
              <Icon name="plus" size={17} /> Create your first entry
            </Link>
          </div>
        )}
        {!!journals?.length && !visible?.length && (
          <div className="empty-state compact">
            <h3>No entries here yet.</h3>
            <p>Try another filter to see more of your journal.</p>
            <button
              className="text-button"
              onClick={() => setFilter("All entries")}
            >
              View all entries <Icon name="arrow" size={16} />
            </button>
          </div>
        )}
        {!!visible?.length && (
          <div className="journal-grid">
            {visible.map((journal, index) => (
              <JournalCard key={journal.id} journal={journal} index={index} />
            ))}
          </div>
        )}
      </section>
      <div className="gentle-note">
        <Icon name="leaf" />
        <p>Some days have a lot to say. Some don’t. Both belong here.</p>
      </div>
    </>
  );
}

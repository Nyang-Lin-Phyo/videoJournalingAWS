import { Link } from "react-router-dom";
import type { JournalSummary } from "../api/types";
import { JournalStatus } from "./JournalStatus";
import { Icon } from "./Icon";
export function JournalCard({
  journal,
  index,
}: {
  journal: JournalSummary;
  index: number;
}) {
  const date = new Date(journal.created_at);
  return (
    <Link to={`/journals/${journal.id}`} className="journal-card">
      <div className={`cover cover-${index % 4}`} aria-hidden="true">
        <span className="cover-sun" />
        <span className="cover-hill hill-back" />
        <span className="cover-hill hill-front" />
        <span className="cover-entry">
          <Icon name="video" size={16} /> VIDEO JOURNAL
        </span>
        <span className="cover-open">
          <Icon name="arrow" />
        </span>
      </div>
      <div className="card-content">
        <div className="card-meta">
          <time dateTime={journal.created_at}>
            {date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </time>
          <span>
            {date.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </div>
        <h3>
          {date.toLocaleDateString(undefined, { weekday: "long" })}’s reflection
        </h3>
        <p className="card-excerpt">
          {journal.analysis?.summary ||
            (journal.status === "failed"
              ? "Your entry needs a little attention."
              : journal.status === "awaiting_upload"
                ? "A space waiting for your video."
                : "Your reflection is coming together.")}
        </p>
        <div className="card-bottom">
          <JournalStatus status={journal.status} />
          {journal.analysis && (
            <span
              className={`sentiment sentiment-${journal.analysis.sentiment}`}
            >
              {journal.analysis.sentiment}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

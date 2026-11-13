import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { journalApi, useMockApi } from "../api/client";
import { isProcessing } from "../api/types";
import { errorMessage } from "../api/errors";
import { useJournal } from "../hooks/useJournal";
import { JournalStatus } from "../components/JournalStatus";
import { AnalysisPanel } from "../components/AnalysisPanel";
import { VideoPreview } from "../components/VideoPreview";
import { Icon } from "../components/Icon";
import { ErrorNotice, Loading } from "../components/Feedback";
export function JournalDetailPage() {
  const { id = "" } = useParams();
  return <JournalDetail key={id} id={id} />;
}
function JournalDetail({ id }: { id: string }) {
  const { journal, error, refreshing, refresh } = useJournal(journalApi, id);
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmDelete) cancelDelete.current?.focus();
  }, [confirmDelete]);
  function closeDelete() {
    setConfirmDelete(false);
    deleteTrigger.current?.focus();
  }
  async function deleteEntry() {
    if (!journal || deleting || isProcessing(journal.status)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await journalApi.delete(journal.id);
      navigate("/");
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
      refresh();
    }
  }
  if (!journal)
    return (
      <>
        <Link className="back-link" to="/">
          <Icon name="back" size={17} /> Back to your journal
        </Link>
        {error ? (
          <ErrorNotice message={error} onRetry={refresh} />
        ) : (
          <Loading />
        )}
      </>
    );
  const active = isProcessing(journal.status);
  const date = new Date(journal.created_at);
  const stageIndex = [
    "queued",
    "transcribing",
    "analyzing",
    "completed",
  ].indexOf(journal.status);
  return (
    <>
      <Link className="back-link" to="/">
        <Icon name="back" size={17} /> Back to your journal
      </Link>
      <div className="detail-heading">
        <div>
          <div className="eyebrow">A MOMENT, KEPT</div>
          <h1>
            {date.toLocaleDateString(undefined, { weekday: "long" })}’s
            reflection
          </h1>
          <p>
            <time dateTime={journal.created_at}>
              {date.toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}{" "}
              ·{" "}
              {date.toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </p>
        </div>
        <JournalStatus status={journal.status} />
      </div>
      {error && <ErrorNotice message={error} onRetry={refresh} />}
      {active && (
        <section className="processing-panel" aria-live="polite">
          <div>
            <Icon name="spark" size={23} />
            <div>
              <h2>Your reflection is taking shape.</h2>
              <p>
                You can return to your journal while we work. This page checks
                for updates automatically.
              </p>
            </div>
          </div>
          <ol className="processing-steps">
            {["Queued", "Transcribing", "Reflecting", "Ready"].map(
              (label, index) => (
                <li
                  key={label}
                  className={index <= stageIndex ? "reached" : ""}
                >
                  <span>
                    {index < stageIndex ? (
                      <Icon name="check" size={14} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {label}
                </li>
              ),
            )}
          </ol>
        </section>
      )}
      {journal.status === "failed" && (
        <ErrorNotice
          message={
            journal.error_message ||
            "Processing could not be completed. Upload another video to try again."
          }
        />
      )}
      {journal.status === "awaiting_upload" && (
        <div className="notice">
          <Icon name="info" />
          <div>
            <strong>This entry is waiting for an upload.</strong>
            <p>
              No processing has started. You can delete this incomplete entry
              and <Link to="/upload">upload a new video</Link>.
            </p>
          </div>
        </div>
      )}
      <div className="detail-layout">
        <div className="detail-main">
          <section className="panel video-panel">
            <div className="panel-title">
              <h2>Your moment</h2>
              <span className="section-label">
                <Icon name="video" size={15} /> VIDEO JOURNAL
              </span>
            </div>
            <VideoPreview
              key={journal.video_url}
              src={
                journal.video_url
                  ? journalApi.videoUrl(journal.video_url)
                  : null
              }
              demo={useMockApi}
            />
          </section>
          <section
            className="panel transcript-panel"
            aria-labelledby="transcript-heading"
          >
            <div className="panel-title">
              <h2 id="transcript-heading">In your words</h2>
              <span className="section-label">TRANSCRIPT</span>
            </div>
            {journal.transcript ? (
              <p className="transcript">{journal.transcript}</p>
            ) : (
              <p className="muted">
                {journal.status === "failed"
                  ? "No transcript was returned for this entry."
                  : "Your transcript will appear here when it is available."}
              </p>
            )}
          </section>
        </div>
        <div className="detail-aside">
          {journal.analysis ? (
            <AnalysisPanel analysis={journal.analysis} />
          ) : (
            <section className="panel reflection-placeholder">
              <Icon name="leaf" size={30} />
              <h2>
                A little perspective,
                <br />
                when it’s ready.
              </h2>
              <p>
                Sentiment, emotions, themes, and a short summary will appear
                here after processing.
              </p>
            </section>
          )}
          <div className="detail-controls">
            <button
              className="button button-quiet"
              disabled={refreshing}
              onClick={refresh}
            >
              <Icon name="refresh" size={16} />
              {refreshing ? "Refreshing…" : "Refresh status"}
            </button>
            <button
              ref={deleteTrigger}
              className="button button-danger-quiet"
              disabled={active}
              title={
                active
                  ? "Wait for processing to finish before deleting"
                  : undefined
              }
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="trash" size={16} /> Delete entry
            </button>
          </div>
          {active && (
            <p className="fine-print">
              Deletion is available after processing finishes.
            </p>
          )}
        </div>
      </div>
      {confirmDelete && (
        <div
          className="modal-backdrop"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleting) closeDelete();
            if (event.key === "Tab") {
              const buttons =
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                );
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-heading"
            aria-describedby="delete-description"
            className="delete-dialog"
          >
            <span className="empty-icon">
              <Icon name="trash" size={25} />
            </span>
            <h2 id="delete-heading">Let this moment go?</h2>
            <p id="delete-description">
              This removes the video, transcript, and reflection from your
              journal. It cannot be undone.
            </p>
            {deleteError && <ErrorNotice message={deleteError} />}
            <div className="dialog-actions">
              <button
                ref={cancelDelete}
                className="button button-secondary"
                disabled={deleting}
                onClick={closeDelete}
              >
                Keep entry
              </button>
              <button
                className="button button-danger"
                disabled={deleting}
                onClick={() => {
                  void deleteEntry();
                }}
              >
                {deleting ? "Deleting…" : "Delete entry"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

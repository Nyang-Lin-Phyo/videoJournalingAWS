import { useState } from "react";
import "./cloud.css";
import { Icon } from "../components/Icon";
import { CloudIngestPage } from "./CloudIngestPage";
import { CloudHistoryPage } from "./CloudHistoryPage";
import { useCloudEnvironment } from "./CloudEnvironment";

type CloudView = "upload" | "history";
type CloudIngestAppProps = {
  accountEmail?: string;
  onSignOut?: () => Promise<void>;
  onAccountDeleted?: () => Promise<void>;
};

export function CloudIngestApp({ accountEmail, onSignOut, onAccountDeleted }: CloudIngestAppProps) {
  const { accessToken, isPreview, services } = useCloudEnvironment();
  const [view, setView] = useState<CloudView>("upload");
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploadRevision, setUploadRevision] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState("");

  async function signOut() {
    if (!onSignOut) {
      setSettingsMessage("Sign out is available after signing in with Cognito.");
      return;
    }
    try {
      await onSignOut();
    } catch {
      setSettingsMessage("Unable to sign out right now. Please try again.");
    }
  }

  async function deleteAccount() {
    setDeletingAccount(true);
    setDeleteError(null);
    setDeleteProgress("Starting account deletion…");
    try {
      let progress = await services.deleteAccount(accessToken, accountEmail ?? "preview@example.invalid");
      while (!progress.complete) {
        setDeleteProgress(progress.message ?? "Removing your account data…");
        await new Promise(resolve => window.setTimeout(
          resolve,
          Math.max(1, progress.retry_after_seconds ?? 1) * 1000,
        ));
        progress = await services.deleteAccount(accessToken, accountEmail ?? "preview@example.invalid");
      }
      setDeleteProgress(progress.message ?? (isPreview ? "Local preview data was cleared. No real account was deleted." : "Your account has been deleted."));
      setConfirmingDelete(false);
      setDeleteConfirmation("");
      setRefreshKey(value => value + 1);
      setUploadRevision(value => value + 1);
      if (!isPreview) await onAccountDeleted?.();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Unable to delete your account. Please retry.");
      setDeleteProgress("");
    } finally {
      setDeletingAccount(false);
    }
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <aside className="sidebar">
        <a href="/" className="brand" aria-label="Reverie home" onClick={event => { event.preventDefault(); setView("upload"); }}>
          <span className="brand-mark"><Icon name="leaf" size={26} /></span>
          <span>reverie<span className="brand-period">.</span></span>
        </a>
        <p className="brand-tagline">A little space for yourself.</p>
        <div className="nav-label">REVERIE — PRIVATE JOURNALS</div>
        <nav className="main-nav" aria-label="Main navigation">
          <button type="button" className={`nav-link ${view === "upload" ? "active" : ""}`} onClick={() => setView("upload")}>
            <Icon name="upload" /> Upload a video {view === "upload" && <span className="nav-dot" />}
          </button>
          <button type="button" className={`nav-link ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>
            <Icon name="book" /> Journal history {view === "history" && <span className="nav-dot" />}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-label"><span className="local-dot" /> Your private notebook</div>
          <p className="local-description">A quiet place for your moments.</p>
          <button
            type="button"
            className="settings-trigger"
            aria-expanded={settingsOpen}
            aria-controls="account-settings"
            onClick={() => {
              setSettingsOpen(value => !value);
              setSettingsMessage("");
            }}
          >
            <Icon name="settings" size={17} /> Settings
          </button>
          {settingsOpen && (
            <section id="account-settings" className="settings-panel" aria-label="Settings">
              <div className="settings-panel-heading">
                <h2>Settings</h2>
                <button type="button" className="settings-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
                  <Icon name="close" size={17} />
                </button>
              </div>
              <p className="settings-account">{accountEmail ?? (isPreview ? "Local preview account" : "Your Reverie account")}</p>
              <button type="button" className="settings-action" onClick={() => void signOut()}>
                <Icon name="logout" size={17} /> Sign out
              </button>
              <button
                type="button"
                className="settings-action settings-delete"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteProgress("");
                  setConfirmingDelete(true);
                  setSettingsMessage("");
                }}
              >
                <Icon name="trash" size={17} /> Delete account
              </button>
              {settingsMessage && <p className="settings-message" role="status">{settingsMessage}</p>}
              {deleteProgress && <p className="settings-message" role="status">{deleteProgress}</p>}
              {deleteError && <p className="settings-error" role="alert">{deleteError}</p>}
            </section>
          )}
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">Your notebook <span>/</span> <strong>{view === "upload" ? "Upload a video" : "Journal history"}</strong></div>
          <div className="topbar-right"><span className="local-pill"><Icon name="shield" size={14} /> PRIVATE JOURNALS</span></div>
        </header>
        <main id="main-content" className="main-content">
          {/* Keep history mounted so its in-memory video cache survives tab switches. */}
          <div style={{ display: view === "upload" ? "block" : "none" }}>
            <CloudIngestPage key={uploadRevision} active={view === "upload"} onUploaded={() => setRefreshKey(value => value + 1)} />
          </div>
          <div style={{ display: view === "history" ? "block" : "none" }}>
            <CloudHistoryPage active={view === "history"} refreshKey={refreshKey} onDeleted={() => { setUploadRevision(n => n + 1); setRefreshKey(n => n + 1); }} />
          </div>
        </main>
        <footer className="footer"><span>Made for the moments in between.</span><span>YOUR WORDS. YOUR PACE.</span></footer>
      </div>
      {confirmingDelete && (
        <div className="account-dialog-backdrop">
          <section className="account-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title" aria-describedby="delete-account-description">
            <h2 id="delete-account-title">Delete your account?</h2>
            <p id="delete-account-description">
              This permanently deletes your account, journals, recordings, transcripts, and reflections. This cannot be undone.
              {isPreview ? " In this local preview, only fictional preview data is cleared." : " Keep this page open while deletion waits for active uploads or journals. If interrupted, sign in again and retry from Settings."}
            </p>
            {!isPreview && (
              <label className="delete-confirm-label" htmlFor="delete-account-confirmation">
                Type DELETE to confirm
                <input
                  id="delete-account-confirmation"
                  autoComplete="off"
                  value={deleteConfirmation}
                  onChange={event => setDeleteConfirmation(event.target.value)}
                />
              </label>
            )}
            {!isPreview && !accountEmail && <p className="settings-error" role="alert">Your account email is unavailable, so account deletion cannot be verified.</p>}
            {deleteError && <p className="settings-error" role="alert">{deleteError}</p>}
            {deleteProgress && <p className="settings-message" role="status">{deleteProgress}</p>}
            <div className="account-dialog-actions">
              <button type="button" className="button button-secondary" disabled={deletingAccount} onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button account-delete-confirm"
                disabled={deletingAccount || (!isPreview && (!accountEmail || deleteConfirmation !== "DELETE"))}
                onClick={() => void deleteAccount()}
              >
                {deletingAccount ? "Deleting…" : "Delete account"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

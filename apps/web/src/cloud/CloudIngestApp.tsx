import { useEffect, useState } from "react";
import "./cloud.css";
import { Icon } from "../components/Icon";
import { CloudIngestPage } from "./CloudIngestPage";
import { CloudHistoryPage } from "./CloudHistoryPage";
import { MemoryBooksPage } from "./MemoryBooksPage";
import { useCloudEnvironment } from "./CloudEnvironment";
import { InterestsPage } from "./InterestsPage";
import { OnboardingFlow } from "./OnboardingFlow";
import { JournalBuddy } from "../components/mascot/JournalBuddy";
import { JournalPageEditor } from "./JournalPageEditor";
import { BuddyContext, createBuddyChannel } from "../components/mascot/buddyChannel";
import type { ProfileUpdate, StreakSummary, UserProfile } from "./analysisApi";

type CloudView = "upload" | "history" | "books" | "interests" | "page";
const VIEW_TITLES: Record<CloudView, string> = {
  upload: "Upload a video",
  history: "Journal history",
  books: "Memory books",
  interests: "Your interests",
  page: "Edit journal page",
};
type CloudIngestAppProps = {
  accountEmail?: string;
  onSignOut?: () => Promise<void>;
  onAccountDeleted?: () => Promise<void>;
};

function localDayKey(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function CloudIngestApp({ accountEmail, onSignOut, onAccountDeleted }: CloudIngestAppProps) {
  const { accessToken, isPreview, services } = useCloudEnvironment();
  const [view, setView] = useState<CloudView>("upload");
  const [pageDayKey, setPageDayKey] = useState("");
  // Lets reflections hand Gemini's recommendations to Biscuit to deliver.
  const [buddyChannel] = useState(createBuddyChannel);
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploadRevision, setUploadRevision] = useState(0);
  const [streakRefreshKey, setStreakRefreshKey] = useState(0);
  const [streak, setStreak] = useState<StreakSummary | null>(null);
  const [streakError, setStreakError] = useState<string | null>(null);
  const [streakRewardsOpen, setStreakRewardsOpen] = useState(false);
  const [buyingFreeze, setBuyingFreeze] = useState(false);
  const [freezeMessage, setFreezeMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileUnavailable, setProfileUnavailable] = useState(false);
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  // Opened once per load when the server flag is off; closing it does not change the flag.
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let attempts = 0;
    const load = async () => {
      attempts += 1;
      try {
        const summary = await services.fetchStreak(accessToken, timezone, controller.signal);
        if (controller.signal.aborted) return;
        setStreak(summary);
        setStreakError(null);
        if (streakRefreshKey > 0 && !summary.uploaded_today && attempts < 6) {
          timer = window.setTimeout(() => void load(), 2500);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setStreakError(error instanceof Error ? error.message : "Unable to load your streak.");
          if (streakRefreshKey > 0 && attempts < 6) {
            timer = window.setTimeout(() => void load(), 2500);
          }
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [accessToken, services, streakRefreshKey, timezone]);

  useEffect(() => {
    const controller = new AbortController();
    services.fetchProfile(accessToken, controller.signal)
      .then(loaded => {
        if (controller.signal.aborted) return;
        setProfile(loaded);
        setProfileUnavailable(false);
        if (!loaded.onboarding_completed) setOnboardingOpen(true);
      })
      .catch(() => {
        // Never block journaling: without a profile, onboarding is simply not shown.
        if (!controller.signal.aborted) setProfileUnavailable(true);
      });
    return () => controller.abort();
  }, [accessToken, services, profileReloadKey]);

  async function saveProfile(update: ProfileUpdate) {
    const saved = await services.saveProfile(accessToken, update);
    setProfile(saved);
    return saved;
  }

  async function buyStreakFreeze() {
    setBuyingFreeze(true);
    setFreezeMessage("");
    setStreakError(null);
    try {
      const updated = await services.buyStreakFreeze(accessToken);
      setStreak(updated);
      setFreezeMessage("Streak freeze added to your inventory.");
    } catch (error) {
      setStreakError(error instanceof Error ? error.message : "Unable to buy a streak freeze.");
    } finally {
      setBuyingFreeze(false);
    }
  }

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
      setProfile(null);
      setOnboardingOpen(false);
      setProfileReloadKey(value => value + 1);
      if (!isPreview) await onAccountDeleted?.();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Unable to delete your account. Please retry.");
      setDeleteProgress("");
    } finally {
      setDeletingAccount(false);
    }
  }

  return (
    <BuddyContext.Provider value={buddyChannel}>
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
          <button type="button" className={`nav-link ${view === "books" ? "active" : ""}`} onClick={() => setView("books")}>
            <Icon name="book" /> Memory books {view === "books" && <span className="nav-dot" />}
          </button>
          <button type="button" className={`nav-link ${view === "interests" ? "active" : ""}`} onClick={() => setView("interests")}>
            <Icon name="heart" /> Your interests {view === "interests" && <span className="nav-dot" />}
          </button>
        </nav>
        <div className="streak-widget">
          <button
            type="button"
            className="streak-card"
            aria-expanded={streakRewardsOpen}
            aria-controls="streak-rewards"
            onClick={() => {
              setStreakRewardsOpen(value => !value);
              setFreezeMessage("");
            }}
          >
            <Icon name="spark" size={20} />
            <span className="streak-card-copy">
              <strong>{streak
                ? streak.current_streak > 0
                  ? `${streak.current_streak} day${streak.current_streak === 1 ? "" : "s"} streak`
                  : "Start a streak"
                : "Streak"}
              </strong>
              <span>
                {streakError ? "Streak unavailable" : !streak ? "Loading streak…" :
                  streak.uploaded_today ? "Today's upload counted" :
                    streak.freeze_pending ? "Freeze ready to protect it" :
                      streak.current_streak ? "Upload today to keep it going" : "Upload to start your streak"}
              </span>
            </span>
            <span className="streak-card-points">
              <strong>{streak?.points ?? "—"}</strong>
              <span>points</span>
            </span>
          </button>
          {streakRewardsOpen && (
            <section id="streak-rewards" className="streak-rewards" aria-label="Streak rewards">
              <div className="streak-rewards-heading">
                <h2>Streak rewards</h2>
                <button type="button" className="settings-close" aria-label="Close rewards" onClick={() => setStreakRewardsOpen(false)}>
                  <Icon name="close" size={17} />
                </button>
              </div>
              <p className="streak-rewards-balance">
                {streak?.points ?? "—"} points · {streak?.freezes ?? 0} freeze{streak?.freezes === 1 ? "" : "s"} owned
              </p>
              {streakError && (
                <button
                  type="button"
                  className="streak-retry-button"
                  onClick={() => setStreakRefreshKey(value => value + 1)}
                >
                  Try loading streak again
                </button>
              )}
              <div className="streak-reward-item">
                <Icon name="shield" size={19} />
                <div>
                  <strong>Streak freeze</strong>
                  <span>Automatically protects one missed day. It does not earn a point.</span>
                </div>
                <strong>{streak?.freeze_cost ?? 7} pts</strong>
              </div>
              {streakError && <p className="settings-error" role="alert">{streakError}</p>}
              {freezeMessage && <p className="settings-message" role="status">{freezeMessage}</p>}
              <button
                type="button"
                className="streak-buy-button"
                disabled={!streak || streak.points < streak.freeze_cost || buyingFreeze}
                onClick={() => void buyStreakFreeze()}
              >
                {buyingFreeze ? "Buying…" : "Buy streak freeze"}
              </button>
            </section>
          )}
        </div>
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
          <div className="breadcrumbs">Your notebook <span>/</span> <strong>{VIEW_TITLES[view]}</strong></div>
          <div className="topbar-right"><span className="local-pill"><Icon name="shield" size={14} /> PRIVATE JOURNALS</span></div>
        </header>
        <main id="main-content" className="main-content">
          {/* Keep history mounted so its in-memory video cache survives tab switches. */}
          <div style={{ display: view === "upload" ? "block" : "none" }}>
            <CloudIngestPage
              key={uploadRevision}
              active={view === "upload"}
              onUploaded={() => {
                setRefreshKey(value => value + 1);
                setStreakRefreshKey(value => value + 1);
              }}
              onOpenPage={createdAt => { setPageDayKey(localDayKey(createdAt, timezone)); setView("page"); }}
            />
          </div>
          <div style={{ display: view === "history" ? "block" : "none" }}>
            <CloudHistoryPage active={view === "history"} refreshKey={refreshKey} onOpenBooks={()=>setView("books")} onEditPage={createdAt => { setPageDayKey(localDayKey(createdAt, timezone)); setView("page"); }} onDeleted={() => { setUploadRevision(n => n + 1); setRefreshKey(n => n + 1); }} />
          </div>
          {view === "page" && <JournalPageEditor key={pageDayKey} dayKey={pageDayKey} timezone={timezone} onBack={() => setView("history")} />}
          {view === "interests" && (
            <InterestsPage
              profile={profile}
              unavailable={profileUnavailable}
              onRetry={() => {
                setProfileUnavailable(false);
                setProfileReloadKey(value => value + 1);
              }}
              onSave={saveProfile}
            />
          )}
          {view === "books" && <MemoryBooksPage />}
        </main>
        {/* Sits on the footer's top border; sticks to the window bottom until it scrolls into view. */}
        {!onboardingOpen && <JournalBuddy context={view === "upload" || view === "history" ? view : undefined} />}
        <footer className="footer"><span>Made for the moments in between.</span><span>YOUR WORDS. YOUR PACE.</span></footer>
      </div>
      {onboardingOpen && profile && (
        <OnboardingFlow
          initial={profile}
          onSave={saveProfile}
          onDone={saved => {
            if (saved) setProfile(saved);
            setOnboardingOpen(false);
          }}
        />
      )}
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
    </BuddyContext.Provider>
  );
}

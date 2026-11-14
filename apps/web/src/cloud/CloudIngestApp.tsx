import { useState } from "react";
import "./cloud.css";
import { Icon } from "../components/Icon";
import { CloudIngestPage } from "./CloudIngestPage";
import { CloudHistoryPage } from "./CloudHistoryPage";

type CloudView = "upload" | "history";

export function CloudIngestApp() {
  const [view, setView] = useState<CloudView>("upload");
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploadRevision, setUploadRevision] = useState(0);

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
            <CloudIngestPage key={uploadRevision} onUploaded={() => setRefreshKey(value => value + 1)} />
          </div>
          <div style={{ display: view === "history" ? "block" : "none" }}>
            <CloudHistoryPage active={view === "history"} refreshKey={refreshKey} onDeleted={() => { setUploadRevision(n => n + 1); setRefreshKey(n => n + 1); }} />
          </div>
        </main>
        <footer className="footer"><span>Made for the moments in between.</span><span>YOUR WORDS. YOUR PACE.</span></footer>
      </div>
    </div>
  );
}

import "./cloud.css";
import { Icon } from "../components/Icon";
import { CloudIngestPage } from "./CloudIngestPage";

export function CloudIngestApp() {
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <aside className="sidebar">
        <a href="/" className="brand" aria-label="Reverie home">
          <span className="brand-mark"><Icon name="leaf" size={26} /></span>
          <span>reverie<span className="brand-period">.</span></span>
        </a>
        <p className="brand-tagline">A little space for yourself.</p>
        <div className="nav-label">PART 2 — CLOUD DEMO</div>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="/" className="nav-link active"><Icon name="upload" /> Upload a video <span className="nav-dot" /></a>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-label"><span className="local-dot" /> ElevenLabs + Gemini processing demo</div>
          <p className="local-description">No account or journal history. Use fictional spoken recordings only.</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">Your notebook <span>/</span> <strong>Upload to S3</strong></div>
          <div className="topbar-right"><span className="local-pill"><Icon name="shield" size={14} /> AWS DEMO</span></div>
        </header>
        <div className="demo-banner"><span className="demo-tag">DEMO</span><p><strong>Upload → ElevenLabs Scribe → Gemini</strong><span className="demo-extra"> · No login or secure user accounts yet. Use fictional test recordings only.</span></p></div>
        <main id="main-content" className="main-content"><CloudIngestPage /></main>
        <footer className="footer"><span>Made for the moments in between.</span><span>YOUR WORDS. YOUR PACE.</span></footer>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useMockApi } from "./api/client";
import { Icon } from "./components/Icon";
import { JournalListPage } from "./pages/JournalListPage";
import { UploadPage } from "./pages/UploadPage";
import { JournalDetailPage } from "./pages/JournalDetailPage";
export default function App() {
  const location = useLocation();
  const [showAbout, setShowAbout] = useState(false);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [location.pathname]);
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="Reverie home">
          <span className="brand-mark">
            <Icon name="leaf" size={26} />
          </span>
          <span>
            reverie<span className="brand-period">.</span>
          </span>
        </Link>
        <p className="brand-tagline">A little space for yourself.</p>
        <div className="nav-label">YOUR NOTEBOOK</div>
        <nav className="main-nav" aria-label="Main navigation">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              isActive || location.pathname.startsWith("/journals/")
                ? "nav-link active"
                : "nav-link"
            }
          >
            <Icon name="book" /> My journal <span className="nav-dot" />
          </NavLink>
          <NavLink
            to="/upload"
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            <Icon name="plus" /> New entry
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-quote">
            <Icon name="leaf" size={24} />
            <p>
              “Pay attention.
              <br />
              Be astonished.
              <br />
              Tell about it.”
            </p>
            <span>— MARY OLIVER</span>
          </div>
          <div className="local-label">
            <span className="local-dot" /> Local development
          </div>
          <p className="local-description">
            One local journal.
            <br />A place to begin.
          </p>
          <button
            className="about-button"
            aria-expanded={showAbout}
            onClick={() => setShowAbout((value) => !value)}
          >
            <Icon name="info" size={15} /> About this space
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            Your notebook <span>/</span>{" "}
            <strong>
              {location.pathname === "/upload"
                ? "New entry"
                : location.pathname.startsWith("/journals/")
                  ? "Reflection"
                  : "My journal"}
            </strong>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button mobile-about"
              aria-label="About this space"
              aria-expanded={showAbout}
              onClick={() => setShowAbout((value) => !value)}
            >
              <Icon name="info" size={16} />
            </button>
            <span className="local-pill">
              <Icon name="shield" size={14} /> LOCAL MVP
            </span>
            <span className="avatar" aria-label="Local journal">
              Y
            </span>
          </div>
        </header>
        {useMockApi && (
          <div className="demo-banner">
            <span className="demo-tag">DEMO</span>
            <p>
              <strong>Demo/mock results</strong>
              <span className="demo-extra">
                {" "}
                · Fictional entries. Uploads stay in memory and reset on
                refresh.
              </span>
            </p>
          </div>
        )}
        {showAbout && (
          <section className="about-panel">
            <div>
              <h2>A space for your everyday.</h2>
              <p>
                Upload a video, revisit your words, and explore a short
                reflection based on the transcript.{" "}
                {useMockApi
                  ? "Demo mode uses synthetic results and does not transcribe your recording."
                  : "API mode sends the video to your local backend. The current repository uses a mock processor. A real Gemini processor, when connected by the backend team, sends transcript text to Google."}{" "}
                This local MVP uses one development identity and has no sign-in.
              </p>
            </div>
            <button
              className="icon-button"
              aria-label="Close about this space"
              onClick={() => setShowAbout(false)}
            >
              <Icon name="close" />
            </button>
          </section>
        )}
        <main id="main-content" className="main-content">
          <Routes>
            <Route path="/" element={<JournalListPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/journals/:id" element={<JournalDetailPage />} />
            <Route
              path="*"
              element={
                <div className="empty-state">
                  <h1>A little off the path.</h1>
                  <p>This page could not be found.</p>
                  <Link to="/" className="button button-primary">
                    Back to your journal
                  </Link>
                </div>
              }
            />
          </Routes>
        </main>
        <footer className="footer">
          <span>Made for the moments in between.</span>
          <span>YOUR WORDS. YOUR PACE.</span>
        </footer>
      </div>
    </div>
  );
}

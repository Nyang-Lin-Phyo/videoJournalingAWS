import { Icon } from "../components/Icon";
import "./login.css";

type LoginPageProps = {
  onSignIn: () => void;
  isLoading?: boolean;
  error?: string;
  disabled?: boolean;
};

export function LoginPage({ onSignIn, isLoading = false, error, disabled = false }: LoginPageProps) {
  return (
    <div className="login-page">
      <header className="login-header">
        <a className="login-brand" href="/" aria-label="Reverie home">
          <Icon name="leaf" size={29} /> reverie.
        </a>
        <span>A LITTLE SPACE FOR YOURSELF</span>
      </header>

      <main className="login-main">
        <section className="login-story" aria-labelledby="login-heading">
          <p className="login-eyebrow"><span /> YOUR EVERYDAY, REMEMBERED</p>
          <h1 id="login-heading">Life moves fast.<br />Keep a little<br /> <em>of it here.</em></h1>
          <p className="login-intro">The small wins. The tangled thoughts. The ordinary days.
            A video journal for whatever’s on your mind.</p>
          <div className="login-illustration" aria-hidden="true">
            <div className="login-orbit" />
            <div className="login-window">
              <div className="login-sun" />
              <div className="login-hill login-hill-back" />
              <div className="login-hill login-hill-front" />
            </div>
            <div className="login-note"><Icon name="video" size={20} /><span>A moment, just for you.</span></div>
            <span className="login-art-leaf"><Icon name="leaf" size={76} /></span>
          </div>
        </section>

        <section className="login-card" aria-labelledby="login-card-heading">
          <span className="login-card-icon"><Icon name="book" size={28} /></span>
          <p className="login-eyebrow">MAKE ROOM FOR YOU</p>
          <h2 id="login-card-heading">Your story starts here.</h2>
          <p className="login-card-intro">Take a breath. Settle in.<br />Your next chapter can start with a moment.</p>
          <button className="login-google-button" type="button" onClick={onSignIn}
            disabled={isLoading || disabled} aria-busy={isLoading}>
            {isLoading ? <span className="login-spinner" aria-hidden="true" /> : (
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z" />
                <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z" />
                <path fill="#FBBC05" d="M6.41 13.92A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.92V7.49H3.07A10 10 0 0 0 2 12c0 1.61.39 3.14 1.07 4.51l3.34-2.59Z" />
                <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z" />
              </svg>
            )}
            {isLoading ? "Connecting to Google…" : "Continue with Google"}
          </button>
          <p className="login-account-note">New here? Your account is created when you sign in.</p>
          {isLoading && <p className="login-status" role="status">Opening your space. This may take a moment.</p>}
          {error && <p className="login-error" role="alert">{error}</p>}
          <div className="login-features">
            <div><Icon name="video" /><span>Capture a moment<small>Upload a video, in your own words.</small></span></div>
            <div><Icon name="book" /><span>Revisit your words<small>Read the transcript of your day.</small></span></div>
            <div><Icon name="spark" /><span>Find room to reflect<small>Explore the themes in your entries.</small></span></div>
          </div>
          <p className="login-preview-note"><Icon name="info" size={16} /><span>Early preview · Please use fictional recordings while backend authorization testing is in progress.</span></p>
        </section>
      </main>
      <footer className="login-footer"><span>Made for the moments in between.</span><span>YOUR WORDS. YOUR PACE.</span></footer>
    </div>
  );
}

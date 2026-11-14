import type { Analysis } from "./analysisApi";
import { Icon } from "../components/Icon";

export function ReflectionPanel({ reflection }: { reflection: Analysis }) {
  return (
    <section className="panel analysis-panel" aria-labelledby="reflection-heading">
      <div className="section-label"><Icon name="spark" /> A MOMENT OF PERSPECTIVE</div>
      <h2 id="reflection-heading">Your reflection</h2>
      <div className="summary"><p>{reflection.summary}</p></div>
      <div className="analysis-section">
        <h3>Overall sentiment</h3>
        <span className={`sentiment sentiment-${reflection.sentiment}`}>{reflection.sentiment}</span>
      </div>
      <div className="analysis-section">
        <h3>Emotions in your words</h3>
        <div className="tags">
          {reflection.emotions.length ? reflection.emotions.map(emotion => (
            <span className="tag" key={emotion}>{emotion}</span>
          )) : <p className="muted">No emotions to display.</p>}
        </div>
      </div>
      <div className="analysis-section">
        <h3>Themes you touched on</h3>
        <div className="tags">
          {reflection.themes.length ? reflection.themes.map(theme => (
            <span className="tag theme-tag" key={theme}>{theme}</span>
          )) : <p className="muted">No themes to display.</p>}
        </div>
      </div>
      <p className="fine-print">A gentle interpretation of your words. Your reflection is personal to you.</p>
    </section>
  );
}

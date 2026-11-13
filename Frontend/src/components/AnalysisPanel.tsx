import type { Analysis } from "../api/types";
import { Icon } from "./Icon";
export function AnalysisPanel({ analysis }: { analysis: Analysis }) {
  return (
    <section
      className="panel analysis-panel"
      aria-labelledby="reflection-heading"
    >
      <div className="section-label">
        <Icon name="spark" /> A MOMENT OF PERSPECTIVE
      </div>
      <h2 id="reflection-heading">Your reflection</h2>
      <div className="summary">
        <p>{analysis.summary}</p>
      </div>
      <div className="analysis-section">
        <h3>Overall sentiment</h3>
        <span className={`sentiment sentiment-${analysis.sentiment}`}>
          {analysis.sentiment}
        </span>
      </div>
      <div className="analysis-section">
        <h3>Emotions in your words</h3>
        <div className="tags">
          {analysis.emotions.length ? (
            analysis.emotions.map((emotion) => (
              <span className="tag" key={emotion}>
                {emotion}
              </span>
            ))
          ) : (
            <p className="muted">No emotions returned.</p>
          )}
        </div>
      </div>
      <div className="analysis-section">
        <h3>Themes you touched on</h3>
        <div className="tags">
          {analysis.themes.length ? (
            analysis.themes.map((theme) => (
              <span className="tag theme-tag" key={theme}>
                {theme}
              </span>
            ))
          ) : (
            <p className="muted">No themes returned.</p>
          )}
        </div>
      </div>
      <p className="fine-print">
        A reflection inferred from transcript text. These interpretations are
        suggestions, not diagnoses.
      </p>
    </section>
  );
}

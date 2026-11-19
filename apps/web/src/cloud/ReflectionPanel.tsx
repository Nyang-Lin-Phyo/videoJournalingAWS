import { useEffect } from "react";
import type { Analysis } from "./analysisApi";
import { Icon } from "../components/Icon";
import { RECOMMENDATION_HEADINGS, useBuddyChannel } from "../components/mascot/buddyChannel";
import "./onboarding.css";

export function ReflectionPanel({ reflection }: { reflection: Analysis }) {
  const buddy = useBuddyChannel();
  const suggestion = reflection.suggestion?.trim();
  const reason = reflection.suggestion_reason ?? "comfort";

  // Biscuit delivers the recommendation whenever a reflection carrying one appears:
  // right after an upload finishes, or when an entry is opened from history.
  useEffect(() => {
    if (buddy && suggestion) buddy.recommend({ text: suggestion, reason });
  }, [buddy, suggestion, reason]);

  return (
    <section className="panel analysis-panel" aria-labelledby="reflection-heading">
      <div className="section-label"><Icon name="spark" /> A MOMENT OF PERSPECTIVE</div>
      <h2 id="reflection-heading">Your reflection</h2>
      <div className="summary"><p>{reflection.summary}</p></div>
      {suggestion && buddy && (
        <div className="buddy-handoff">
          <Icon name="heart" size={16} />
          <span>Biscuit has {RECOMMENDATION_HEADINGS[reason].toLowerCase()} for you.</span>
          <button type="button" onClick={() => buddy.recommend({ text: suggestion, reason })}>
            Hear it again
          </button>
        </div>
      )}
      {suggestion && !buddy && (
        <aside className="gentle-suggestion" aria-labelledby="gentle-suggestion-heading">
          <Icon name="heart" size={18} />
          <div>
            <h3 id="gentle-suggestion-heading">{RECOMMENDATION_HEADINGS[reason]}</h3>
            <p>{suggestion}</p>
          </div>
        </aside>
      )}
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

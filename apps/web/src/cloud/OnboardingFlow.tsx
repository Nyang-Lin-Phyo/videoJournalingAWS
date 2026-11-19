import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { ChipPicker } from "./ChipPicker";
import type { ProfileUpdate, UserProfile } from "./analysisApi";
import {
  COMFORT_FOOD_OPTIONS, INTEREST_OPTIONS, MAX_COMFORT_FOODS, MAX_INTERESTS, MAX_MOOD_BOOSTERS,
  MAX_MUSIC, MAX_MUSIC_NOTE, MOOD_BOOSTER_OPTIONS, MUSIC_OPTIONS,
} from "./profileCatalog";
import "./onboarding.css";

type OnboardingFlowProps = {
  initial: UserProfile;
  onSave: (update: ProfileUpdate) => Promise<UserProfile>;
  onDone: (profile: UserProfile | null) => void;
};

const STEPS = ["welcome", "interests", "music", "boosters", "foods", "done"] as const;
type Step = (typeof STEPS)[number];
const QUESTION_STEPS = 4;

/**
 * First-run onboarding: one question per screen, chips instead of typing,
 * and a skip option on every screen. Finishing or skipping both set the
 * server-side onboarding flag, so the flow is only shown once.
 */
export function OnboardingFlow({ initial, onSave, onDone }: OnboardingFlowProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [interests, setInterests] = useState(initial.interests);
  const [music, setMusic] = useState(initial.music);
  const [musicNote, setMusicNote] = useState(initial.music_note);
  const [boosters, setBoosters] = useState(initial.mood_boosters);
  const [foods, setFoods] = useState(initial.comfort_foods);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<UserProfile | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const index = STEPS.indexOf(step);
  const questionNumber = Math.min(Math.max(index, 1), QUESTION_STEPS);

  useEffect(() => { heading.current?.focus(); }, [step]);

  async function finish(goToDone: boolean) {
    setSaving(true);
    setError(null);
    try {
      const profile = await onSave({
        interests, music, mood_boosters: boosters, comfort_foods: foods,
        music_note: musicNote.trim(), complete_onboarding: true,
      });
      if (!goToDone) {
        onDone(profile);
        return;
      }
      setSaved(profile);
      setStep("done");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We couldn't save your answers.");
    }
    setSaving(false);
  }

  const next = () => setStep(STEPS[index + 1]!);
  const back = () => setStep(STEPS[index - 1]!);
  const isQuestion = step === "interests" || step === "music" || step === "boosters" || step === "foods";

  return (
    <div className="onboarding-backdrop">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-heading">
        <header className="onboarding-top">
          <span className="brand onboarding-brand">
            <span className="brand-mark"><Icon name="leaf" size={22} /></span>
            <span>reverie<span className="brand-period">.</span></span>
          </span>
          {step !== "done" && (
            <button type="button" className="onboarding-skip" disabled={saving} onClick={() => void finish(false)}>
              Skip for now
            </button>
          )}
        </header>

        {isQuestion && (
          <div className="onboarding-progress">
            <span>Step {questionNumber} of {QUESTION_STEPS}</span>
            <div className="onboarding-progress-track" aria-hidden="true">
              <div style={{ width: `${(questionNumber / QUESTION_STEPS) * 100}%` }} />
            </div>
          </div>
        )}

        {step === "welcome" && (
          <div className="onboarding-body onboarding-welcome">
            <div className="eyebrow">WELCOME TO YOUR NOTEBOOK</div>
            <h1 id="onboarding-heading" ref={heading} tabIndex={-1}>Let's get to know you a little.</h1>
            <p>
              Four quick questions about what you enjoy, so your reflections can feel a bit more like you.
              Pick as many or as few as you like, and change them anytime from <strong>Your interests</strong>.
            </p>
          </div>
        )}

        {step === "interests" && (
          <div className="onboarding-body">
            <h1 id="onboarding-heading" ref={heading} tabIndex={-1}>What do you enjoy?</h1>
            <p>The things you like spending time on.</p>
            <ChipPicker label="Interests" options={INTEREST_OPTIONS} selected={interests}
              max={MAX_INTERESTS} onChange={setInterests} />
          </div>
        )}

        {step === "music" && (
          <div className="onboarding-body">
            <h1 id="onboarding-heading" ref={heading} tabIndex={-1}>What's on your playlist?</h1>
            <p>The music you reach for most.</p>
            <ChipPicker label="Music" options={MUSIC_OPTIONS} selected={music}
              max={MAX_MUSIC} onChange={setMusic} />
            <label className="onboarding-field" htmlFor="onboarding-music-note">
              <span>A favourite artist or song <small>(optional)</small></span>
              <input id="onboarding-music-note" value={musicNote} maxLength={MAX_MUSIC_NOTE}
                autoComplete="off" onChange={event => setMusicNote(event.target.value)} />
            </label>
          </div>
        )}

        {step === "boosters" && (
          <div className="onboarding-body">
            <h1 id="onboarding-heading" ref={heading} tabIndex={-1}>When a day feels heavy, what usually helps?</h1>
            <p>Small things that tend to lift you up.</p>
            <ChipPicker label="What helps" options={MOOD_BOOSTER_OPTIONS} selected={boosters}
              max={MAX_MOOD_BOOSTERS} onChange={setBoosters} />
          </div>
        )}

        {step === "foods" && (
          <div className="onboarding-body">
            <h1 id="onboarding-heading" ref={heading} tabIndex={-1}>And your comfort food or drink?</h1>
            <p>The little treats that make a day feel better.</p>
            <ChipPicker label="Comfort food and drink" options={COMFORT_FOOD_OPTIONS} selected={foods}
              max={MAX_COMFORT_FOODS} onChange={setFoods} />
          </div>
        )}

        {step === "done" && (
          <div className="onboarding-body onboarding-welcome">
            <span className="onboarding-done-mark"><Icon name="check" size={26} /></span>
            <h1 id="onboarding-heading" ref={heading} tabIndex={-1}>You're all set.</h1>
            <p>Thanks for sharing. Whenever you want to update these, open <strong>Your interests</strong> in the sidebar.</p>
          </div>
        )}

        {error && (
          <div className="onboarding-error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" onClick={() => onDone(null)}>Continue without saving</button>
          </div>
        )}

        <footer className="onboarding-actions">
          {isQuestion && (
            <button type="button" className="button button-quiet" disabled={saving} onClick={back}>
              <Icon name="back" size={16} /> Back
            </button>
          )}
          {step === "welcome" && (
            <button type="button" className="button button-primary onboarding-primary" onClick={next}>
              Get started <Icon name="arrow" size={16} />
            </button>
          )}
          {(step === "interests" || step === "music" || step === "boosters") && (
            <button type="button" className="button button-primary onboarding-primary" onClick={next}>
              Continue <Icon name="arrow" size={16} />
            </button>
          )}
          {step === "foods" && (
            <button type="button" className="button button-primary onboarding-primary" disabled={saving}
              onClick={() => void finish(true)}>
              {saving ? <><span className="spinner" /> Saving…</> : <>Finish <Icon name="check" size={16} /></>}
            </button>
          )}
          {step === "done" && (
            <button type="button" className="button button-primary onboarding-primary"
              onClick={() => onDone(saved)}>
              Start journaling <Icon name="arrow" size={16} />
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

import { useState } from "react";
import { ErrorNotice } from "../components/Feedback";
import { Icon } from "../components/Icon";
import { ChipPicker } from "./ChipPicker";
import type { ProfileUpdate, UserProfile } from "./analysisApi";
import {
  COMFORT_FOOD_OPTIONS, INTEREST_OPTIONS, MAX_COMFORT_FOODS, MAX_INTERESTS, MAX_MOOD_BOOSTERS,
  MAX_MUSIC, MAX_MUSIC_NOTE, MOOD_BOOSTER_OPTIONS, MUSIC_OPTIONS,
} from "./profileCatalog";
import "./onboarding.css";

type InterestsPageProps = {
  profile: UserProfile | null;
  unavailable: boolean;
  onRetry: () => void;
  onSave: (update: ProfileUpdate) => Promise<UserProfile>;
};

/** The "Your interests" tab: edit what was chosen during onboarding. */
export function InterestsPage({ profile, unavailable, onRetry, onSave }: InterestsPageProps) {
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">YOUR INTERESTS</div>
        <h1>The things that make you, you.</h1>
        <p>These help us shape gentle, personal ideas in your reflections. Only you can see them.</p>
      </div>

      {unavailable && !profile && (
        <section className="panel interests-unavailable">
          <p>Your interests couldn't be loaded right now.</p>
          <button type="button" className="button button-secondary" onClick={onRetry}>
            <Icon name="refresh" size={16} /> Try again
          </button>
        </section>
      )}
      {!unavailable && !profile && <p className="muted" role="status">Loading your interests…</p>}
      {profile && <InterestsEditor profile={profile} onSave={onSave} />}
    </>
  );
}

function InterestsEditor({ profile, onSave }: { profile: UserProfile; onSave: InterestsPageProps["onSave"] }) {
  const [interests, setInterests] = useState(profile.interests);
  const [music, setMusic] = useState(profile.music);
  const [musicNote, setMusicNote] = useState(profile.music_note);
  const [boosters, setBoosters] = useState(profile.mood_boosters);
  const [foods, setFoods] = useState(profile.comfort_foods);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const changed =
    interests.join() !== profile.interests.join() ||
    music.join() !== profile.music.join() ||
    boosters.join() !== profile.mood_boosters.join() ||
    foods.join() !== profile.comfort_foods.join() ||
    musicNote.trim() !== profile.music_note;

  async function save() {
    setSaving(true);
    setError(null);
    setMessage("");
    try {
      await onSave({
        interests, music, mood_boosters: boosters, comfort_foods: foods, music_note: musicNote.trim(),
      });
      setMessage("Saved. Your reflections will take these into account.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We couldn't save your interests.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="interests-layout">
      <section className="panel interests-section" aria-labelledby="interests-enjoy">
        <h2 id="interests-enjoy">What you enjoy</h2>
        <ChipPicker label="Interests" options={INTEREST_OPTIONS} selected={interests}
          max={MAX_INTERESTS} onChange={setInterests} />
      </section>
      <section className="panel interests-section" aria-labelledby="interests-music">
        <h2 id="interests-music">Your music</h2>
        <ChipPicker label="Music" options={MUSIC_OPTIONS} selected={music}
          max={MAX_MUSIC} onChange={setMusic} />
        <label className="onboarding-field" htmlFor="interests-music-note">
          <span>A favourite artist or song <small>(optional)</small></span>
          <input id="interests-music-note" value={musicNote} maxLength={MAX_MUSIC_NOTE}
            autoComplete="off" onChange={event => setMusicNote(event.target.value)} />
        </label>
      </section>
      <section className="panel interests-section" aria-labelledby="interests-helps">
        <h2 id="interests-helps">What helps on heavier days</h2>
        <ChipPicker label="What helps" options={MOOD_BOOSTER_OPTIONS} selected={boosters}
          max={MAX_MOOD_BOOSTERS} onChange={setBoosters} />
      </section>
      <section className="panel interests-section" aria-labelledby="interests-foods">
        <h2 id="interests-foods">Comfort food and drink</h2>
        <ChipPicker label="Comfort food and drink" options={COMFORT_FOOD_OPTIONS} selected={foods}
          max={MAX_COMFORT_FOODS} onChange={setFoods} />
      </section>
      <div className="interests-actions">
        <button type="button" className="button button-primary onboarding-primary"
          disabled={!changed || saving} onClick={() => void save()}>
          {saving ? <><span className="spinner" /> Saving…</> : <><Icon name="check" size={16} /> Save changes</>}
        </button>
        {message && <p className="settings-message" role="status">{message}</p>}
        {error && <ErrorNotice message={error} />}
      </div>
    </div>
  );
}

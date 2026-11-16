import { useEffect, useState } from "react";
import { CloudEnvironmentContext, type CloudEnvironment } from "./CloudEnvironment";
import { CloudIngestApp } from "./CloudIngestApp";
import { fixtureJournals } from "../mocks/fixtures";
import type { AnalysisResult, StreakSummary } from "./analysisApi";

function createPreview(): { environment: CloudEnvironment; dispose: () => void } {
  const entries = new Map<string, AnalysisResult>(fixtureJournals.slice(0, 3).map(journal => [journal.id, {
    upload_id: journal.id,
    title: ["A walk after class", "An ordinary day", "One step at a time"][Number(journal.id.slice(-1)) - 1]!,
    created_at: journal.created_at,
    status: journal.status,
    transcript: journal.transcript,
    analysis: journal.analysis,
    error: null,
  }]));
  const videoUrls = new Map<string, string>();
  const awardedDays = new Set<string>();
  let streak: StreakSummary = {
    current_streak: 0,
    longest_streak: 0,
    points: 0,
    freezes: 0,
    freeze_cost: 7,
    uploaded_today: false,
    freeze_pending: false,
  };
  let lastUploadDay: string | null = null;
  const localDay = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  const dayDifference = (from: string, to: string) => {
    const [fromYear, fromMonth, fromDate] = from.split("-").map(Number);
    const [toYear, toMonth, toDate] = to.split("-").map(Number);
    const fromTime = Date.UTC(fromYear!, fromMonth! - 1, fromDate!);
    const toTime = Date.UTC(toYear!, toMonth! - 1, toDate!);
    return Math.round((toTime - fromTime) / 86_400_000);
  };
  const currentStreak = () => {
    if (!lastUploadDay) return 0;
    const today = localDay(new Date());
    const missed = dayDifference(lastUploadDay, today) - 1;
    return missed > streak.freezes ? 0 : streak.current_streak;
  };
  const refreshStreakSummary = () => {
    const today = localDay(new Date());
    const missed = lastUploadDay ? dayDifference(lastUploadDay, today) - 1 : 0;
    streak = {
      ...streak,
      current_streak: currentStreak(),
      uploaded_today: lastUploadDay === today,
      freeze_pending: missed > 0 && missed <= streak.freezes,
    };
    return { ...streak };
  };
  const recordPreviewUpload = () => {
    const today = localDay(new Date());
    if (!awardedDays.has(today)) {
      streak.points += 1;
      awardedDays.add(today);
    }
    if (!lastUploadDay) {
      streak.current_streak = 1;
    } else if (today !== lastUploadDay) {
      const gap = dayDifference(lastUploadDay, today);
      const missed = gap - 1;
      if (missed === 0) streak.current_streak += 1;
      else if (missed <= streak.freezes) {
        streak.current_streak += gap;
        streak.freezes -= missed;
      } else streak.current_streak = 1;
    }
    lastUploadDay = today;
    streak.longest_streak = Math.max(streak.longest_streak, streak.current_streak);
    refreshStreakSummary();
  };
  const get = (id: string) => {
    const entry = entries.get(id);
    if (!entry) throw new Error("Unable to retrieve reflection (HTTP 404).");
    return entry;
  };
  return {
    environment: {
      userSub: "local-cloud-preview",
      accessToken: "local-preview-only",
      isPreview: true,
      services: {
        async fetchJournals() {
          return { journals: Array.from(entries.values()).map(entry => ({
            upload_id: entry.upload_id, title: entry.title, created_at: entry.created_at,
            status: entry.status, sentiment: entry.analysis?.sentiment ?? null,
          })), next_token: null };
        },
        async fetchAnalysis(id) { return { ...get(id) }; },
        async fetchVideoUrl(id) {
          get(id);
          const url = videoUrls.get(id);
          if (!url) throw new Error("This fictional entry has no recording. Its transcript is available below.");
          return { upload_id: id, url, expires_in: 900 };
        },
        async renameJournal(id, title) {
          entries.set(id, { ...get(id), title });
          return { upload_id: id, title };
        },
        async deleteJournal(id) {
          entries.delete(id);
          const url = videoUrls.get(id);
          if (url) URL.revokeObjectURL(url);
          videoUrls.delete(id);
        },
        async deleteAccount() {
          entries.clear();
          videoUrls.forEach(url => URL.revokeObjectURL(url));
          videoUrls.clear();
          awardedDays.clear();
          lastUploadDay = null;
          streak = {
            current_streak: 0,
            longest_streak: 0,
            points: 0,
            freezes: 0,
            freeze_cost: 7,
            uploaded_today: false,
            freeze_pending: false,
          };
          return {
            complete: true,
            message: "Local preview data was cleared. No real account was deleted.",
          };
        },
        async uploadMp4(file, title, onStage, onProgress, _token, signal) {
          signal?.throwIfAborted();
          onStage("uploading");
          recordPreviewUpload();
          const id = crypto.randomUUID();
          videoUrls.set(id, URL.createObjectURL(file));
          entries.set(id, { upload_id: id, title, created_at: new Date().toISOString(), status: "completed",
            transcript: "[DEMO TRANSCRIPT] This is fictional preview text. Your selected video has not been transcribed or sent to AWS.\n\nToday I made time for a quiet walk after class. There was a lot on my mind, but stepping outside helped me slow down. I noticed the changing leaves and called a friend on the way home.\n\nSometimes a small pause is enough. Tomorrow I want to carry a little of that calm into the day.",
            analysis: { sentiment: "neutral", emotions: ["calm"], themes: ["reflection"],
              summary: "Fictional preview reflection. Your video has not been analyzed." }, error: null });
          onProgress(100);
          return { upload_id: id, object_key: `preview/${id}.mp4` };
        },
        async fetchStreak() {
          return refreshStreakSummary();
        },
        async buyStreakFreeze() {
          if (streak.points < streak.freeze_cost) {
            throw new Error("You need 7 points to buy a streak freeze.");
          }
          streak = {
            ...streak,
            points: streak.points - streak.freeze_cost,
            freezes: streak.freezes + 1,
          };
          return refreshStreakSummary();
        },
      },
    },
    dispose() { videoUrls.forEach(url => URL.revokeObjectURL(url)); videoUrls.clear(); },
  };
}

export default function CloudPreviewApp() {
  const [preview] = useState(createPreview);
  useEffect(() => () => preview.dispose(), [preview]);
  return <CloudEnvironmentContext.Provider value={preview.environment}>
    <div style={{ padding: "8px 20px", display: "flex", justifyContent: "flex-end", gap: 16, alignItems: "center" }}>
      <span>Local preview · Fictional journals · Uploads stay in this browser session</span>
    </div>
    <CloudIngestApp />
  </CloudEnvironmentContext.Provider>;
}

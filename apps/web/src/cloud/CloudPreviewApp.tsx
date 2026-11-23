import { useEffect, useState } from "react";
import { CloudEnvironmentContext, type CloudEnvironment } from "./CloudEnvironment";
import { CloudIngestApp } from "./CloudIngestApp";
import { fixtureJournals } from "../mocks/fixtures";
import type { Analysis, AnalysisResult, MemoryReflection, MemoryWritingPreferences, StreakSummary, UserProfile } from "./analysisApi";
import { COMFORT_FOOD_OPTIONS, INTEREST_OPTIONS, MOOD_BOOSTER_OPTIONS } from "./profileCatalog";

const EMPTY_PROFILE: UserProfile = {
  onboarding_completed: false, interests: [], music: [], mood_boosters: [], comfort_foods: [],
  music_note: "",
};

const labelOf = (options: { id: string; label: string }[], id?: string) =>
  options.find(option => option.id === id)?.label.toLowerCase();

// Fictional stand-ins for the worker's verified recommendations. The real ones
// are written by Gemini from stated choices plus what it learned from journals.
function previewSuggestion(profile: UserProfile, analysis: Analysis): Partial<Analysis> {
  const food = labelOf(COMFORT_FOOD_OPTIONS, profile.comfort_foods[0]);
  const booster = labelOf(MOOD_BOOSTER_OPTIONS, profile.mood_boosters[0]);
  const interest = labelOf(INTEREST_OPTIONS, profile.interests[0]);
  if (analysis.sentiment === "negative") {
    const idea = food ?? booster ?? interest;
    return {
      suggestion_reason: "comfort",
      suggestion: idea
        ? `[DEMO] If it feels right, maybe make a little room for ${idea} later. It has seemed to help you before.`
        : "[DEMO] If it feels right, maybe take a slow breath and give yourself a small, kind pause today.",
    };
  }
  if (analysis.sentiment === "positive" && (interest || food)) {
    return {
      suggestion_reason: "been_a_while",
      suggestion: `[DEMO] It has been a little while since ${interest ?? food} came up. Could be a nice one to fit in this week.`,
    };
  }
  return {};
}

function createPreview(onboarded: boolean): { environment: CloudEnvironment; dispose: () => void } {
  let profile: UserProfile = { ...EMPTY_PROFILE, onboarding_completed: onboarded };
  const entries = new Map<string, AnalysisResult>(fixtureJournals.slice(0, 3).map(journal => [journal.id, {
    upload_id: journal.id,
    title: ["A walk after class", "An ordinary day", "One step at a time"][Number(journal.id.slice(-1)) - 1]!,
    created_at: journal.created_at,
    status: journal.status,
    transcript: journal.transcript,
    analysis: journal.analysis,
    error: null,
  }]));
  // Two more fictional entries on the same day as "An ordinary day", so the
  // history timeline shows a stacked day in the preview.
  const ordinaryDay = fixtureJournals[1]!;
  ([
    ["preview-stack-1", "Morning pages", "2026-10-25T19:10:00Z", "positive"],
    ["preview-stack-2", "A long afternoon", "2026-10-25T19:45:00Z", "negative"],
  ] as const).forEach(([id, title, createdAt, sentiment]) => {
    entries.set(id, {
      upload_id: id, title, created_at: createdAt, status: "completed",
      transcript: `[DEMO TRANSCRIPT] ${title}. A fictional entry for the local preview.`,
      analysis: ordinaryDay.analysis ? { ...ordinaryDay.analysis, sentiment } : null,
      error: null,
    });
  });
  const videoUrls = new Map<string, string>();
  const memoryBooks = new Map<string, import("./analysisApi").MemoryBookRecord>();
  const journalPages = new Map<string, import("./analysisApi").JournalPage>();
  const dailyPages = new Map<string, import("./analysisApi").JournalPage>();
  const previewPhotos: import("./analysisApi").MemoryPhoto[] = [];
  let memoryPreferences: MemoryWritingPreferences = { style: "reflective", amount: "light", revision: 0 };
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
        async fetchJournalsInRange(_token, start, end, timezone) {
          const localDate = (value: string) => {
            const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
            const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
            return `${part("year")}-${part("month")}-${part("day")}`;
          };
          return [...entries.values()].filter(entry => entry.status === "completed" && (!start || localDate(entry.created_at) >= start) && (!end || localDate(entry.created_at) <= end)).map(entry => ({ upload_id: entry.upload_id, title: entry.title, created_at: entry.created_at, status: entry.status, sentiment: entry.analysis?.sentiment ?? null, page_available: Boolean(entry.transcript?.trim()) }));
        },
        async fetchDailyPage(_token, dayKey, timezone) {
          const key = `${timezone}#${dayKey}`;
          const localDate = (value: string) => {
            const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
            const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
            return `${part("year")}-${part("month")}-${part("day")}`;
          };
          const sources = [...entries.values()].filter(entry => entry.status === "completed" && localDate(entry.created_at) === dayKey).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.upload_id.localeCompare(b.upload_id));
          if (!sources.length) throw new Error("No ready transcripts were found for this day.");
          const current = dailyPages.get(key);
          const blocks = current?.blocks.filter(block => !block.source || sources.some(source => source.upload_id === block.sourceJournalId)) ?? [];
          const existing = new Set(blocks.filter(block => block.source).map(block => block.id));
          for (const source of sources) {
            const paragraphs = (source.transcript ?? "").split(/\n\s*\n/).filter(text => text.trim());
            paragraphs.forEach((text, index) => {
              const id = `source-${source.upload_id}-${String(index + 1).padStart(4, "0")}`;
              if (!existing.has(id)) blocks.push({ id, kind: "text", width: "full", text, source: true, sourceJournalId: source.upload_id });
            });
          }
          const value: import("./analysisApi").JournalPage = current ? { ...current, blocks, sources: sources.map(source => ({ id: source.upload_id, title: source.title, date: source.created_at })) } : {
            journalId: dayKey, dayKey, timezone, title: dayKey, date: `${dayKey}T12:00:00`, revision: 0,
            sources: sources.map(source => ({ id: source.upload_id, title: source.title, date: source.created_at })), blocks,
            highlightPage: false, originalText: sources.map(source => source.transcript ?? "").join("\n\n"),
          };
          dailyPages.set(key, value);
          return structuredClone(value);
        },
        async saveDailyPage(_token, dayKey, timezone, value) {
          const key = `${timezone}#${dayKey}`, current = dailyPages.get(key);
          if (!current || current.revision !== value.revision) throw new Error("This daily page changed elsewhere. Reload before saving.");
          const saved = { ...current, ...structuredClone(value), revision: current.revision + 1 };
          dailyPages.set(key, saved); return structuredClone(saved);
        },
        async fetchJournalPage(_token, id) {
          const existing = journalPages.get(id); if (existing) return structuredClone(existing);
          const entry = get(id); const transcript = entry.transcript ?? "";
          const paragraphs = transcript.split(/\n\s*\n/).filter(text => text.trim());
          const value = { journalId: id, title: entry.title, date: entry.created_at, revision: 0, blocks: paragraphs.map((text, index) => ({ id: `source-${String(index + 1).padStart(4, "0")}`, kind: "text" as const, width: "full" as const, text, source: true })), highlightPage: false, originalText: transcript };
          journalPages.set(id, value); return structuredClone(value);
        },
        async saveJournalPage(_token, id, value) {
          const current = journalPages.get(id); if (!current || current.revision !== value.revision) throw new Error("This page changed elsewhere. Reload it before saving.");
          const saved = { ...current, ...structuredClone(value), revision: current.revision + 1 }; journalPages.set(id, saved); return structuredClone(saved);
        },
        async startQuickExport(_token, value) { return { job_id: value.request_key, status: "queued" }; },
        async fetchQuickExport(_token, jobId) { return { status: "complete", download_url: `data:application/pdf,DEMO%20journal%20PDF%20${jobId}` }; },
        async fetchMemoryBooks() { return [...memoryBooks.values()].map(book => structuredClone(book)); },
        async fetchMemoryPreferences() { return { ...memoryPreferences }; },
        async saveMemoryPreferences(_token, value) { memoryPreferences = { style:value.style, amount:value.amount, revision:memoryPreferences.revision+1 }; return { ...memoryPreferences }; },
        async fetchMemoryNarratives(_token, refs) {
          return new Map(refs.map(ref => {
            const entry = [...memoryBooks.values()].flatMap(book => book.entries).find(item => item.id === ref.id);
            const original = entries.get(ref.id)?.transcript ?? entry?.text ?? "";
            return [ref.id, { id: ref.id, text: entry?.text ?? original, original_text: original, candidate: entry?.candidate,
              quotes: entry?.quotes ?? [], favorite: entry?.favorite ?? false, meaningful: entry?.meaningful ?? false,
              narrativeRevision: entry?.narrativeRevision ?? 0, metadataRevision: entry?.metadataRevision ?? 0, sourceAvailable: Boolean(original) }];
          }));
        },
        async saveMemoryBook(_token, book) {
          const previous = memoryBooks.get(book.id);
          if ((previous?.revision ?? 0) !== book.revision) throw new Error("This book changed elsewhere. Reload before saving.");
          const saved = { ...structuredClone(book), revision: book.revision + 1 };
          memoryBooks.set(book.id, saved); return structuredClone(saved);
        },
        async deleteMemoryBook(_token, bookId) { memoryBooks.delete(bookId); },
        async startMemoryExport(_token, bookId) { return { book_id: bookId, revision: memoryBooks.get(bookId)?.revision ?? 0, status: "preview" }; },
        async fetchMemoryExport() { return { status: "preview" }; },
        async retryMemoryExport(_token, bookId, revision) { return { book_id: bookId, revision, status: "preview" }; },
        async rewriteMemory(_token, _bookId, uploadId, style, amount) {
          const source = entries.get(uploadId)?.transcript ?? "";
          return { candidate: amount === "original" ? source : `[DEMO ${style} rewrite] ${source}` };
        },
        async generateMemoryReflection(_token, bookId, period, key): Promise<MemoryReflection> {
          const book = memoryBooks.get(bookId);
          const source = (book?.entries ?? []).filter(entry => entry.included && (period === "year" ? entry.date.slice(0,4) === key : entry.date.slice(0,7) === key));
          if (!source.length) throw new Error("No fictional memories in this period.");
          return { period, key, text: `[DEMO AI reflection] Across ${source.length} memories, the moments gather into a story only you can finish in your own words.`,
            sourceIds: source.map(entry => entry.id), coverage: { journal_count: source.length, start_date: source[0]!.date.slice(0,10), end_date: source[source.length-1]!.date.slice(0,10), source_characters: source.reduce((sum,entry)=>sum+entry.text.length,0) }, aiGenerated: true, approved: false, included: true };
        },
        async fetchMemoryPhotos() { return structuredClone(previewPhotos); },
        async uploadMemoryPhoto() { const photo_id = crypto.randomUUID(); previewPhotos.push({ photo_id, status: "complete", url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='500'%3E%3Crect width='100%25' height='100%25' fill='%23e9dfd2'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%23715c4b' font-size='32'%3EPreview photo%3C/text%3E%3C/svg%3E" }); return photo_id; },
        async fetchJournals() {
          return { journals: Array.from(entries.values()).map(entry => ({
            upload_id: entry.upload_id, title: entry.title, created_at: entry.created_at,
            status: entry.status, sentiment: entry.analysis?.sentiment ?? null,
            source_type: "video",
            page_available: entry.status === "completed",
          })), next_token: null };
        },
        async fetchJournalMonth(_token, month) {
          // The local preview derives its calendar from the same fictional entries.
          const all = Array.from(entries.values());
          return { journals: all.filter(entry => {
            const date = new Date(entry.created_at);
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` === month;
          }).map(entry => ({ upload_id: entry.upload_id, title: entry.title,
            created_at: entry.created_at, status: entry.status,
            sentiment: entry.analysis?.sentiment ?? null, page_available: entry.status === "completed" })), next_token: null };
        },
        async fetchAnalysis(id) {
          const entry = get(id);
          return entry.analysis
            ? { ...entry, analysis: { ...entry.analysis, ...previewSuggestion(profile, entry.analysis) } }
            : { ...entry };
        },
        async fetchProfile() { return { ...profile }; },
        async saveProfile(_token, update) {
          const { complete_onboarding: complete, ...stated } = update;
          profile = { ...profile, ...stated, onboarding_completed: profile.onboarding_completed || Boolean(complete) };
          return { ...profile };
        },
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
          memoryBooks.clear();
          memoryPreferences = { style: "reflective", amount: "light", revision: 0 };
          videoUrls.forEach(url => URL.revokeObjectURL(url));
          videoUrls.clear();
          awardedDays.clear();
          lastUploadDay = null;
          profile = { ...EMPTY_PROFILE };
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

export default function CloudPreviewApp({ onboarded = false }: { onboarded?: boolean }) {
  const [preview] = useState(() => createPreview(onboarded));
  useEffect(() => () => preview.dispose(), [preview]);
  return <CloudEnvironmentContext.Provider value={preview.environment}>
    <div style={{ padding: "8px 20px", display: "flex", justifyContent: "flex-end", gap: 16, alignItems: "center" }}>
      <span>Local preview · Fictional journals · Uploads stay in this browser session</span>
    </div>
    <CloudIngestApp />
  </CloudEnvironmentContext.Provider>;
}

import type { JournalDetail, JournalStatus, Sentiment } from "../api/types";
function fixture(
  index: number,
  date: string,
  status: JournalStatus,
  sentiment: Sentiment | null,
  transcript: string | null,
  summary: string,
  emotions: string[],
  themes: string[],
): JournalDetail {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    created_at: date,
    status,
    video_url: null,
    transcript,
    analysis: sentiment ? { sentiment, emotions, themes, summary } : null,
    error_message:
      status === "failed"
        ? "The demo could not find speech in this synthetic entry. Try uploading another video."
        : null,
  };
}
export const emptyJournals: JournalDetail[] = [];
export const fixtureJournals: JournalDetail[] = [
  fixture(
    1,
    "2026-10-26T18:30:00Z",
    "completed",
    "positive",
    "[DEMO TRANSCRIPT] I took a walk after class today. The air was cool, and I finally had a moment to slow down. Later I called a friend. It was a small thing, but I felt grateful for the people I can be myself around.",
    "A quiet walk and a conversation with a friend brought a sense of gratitude and connection.",
    ["gratitude", "calm"],
    ["friendship", "small moments"],
  ),
  fixture(
    2,
    "2026-10-25T20:15:00Z",
    "completed",
    "neutral",
    "[DEMO TRANSCRIPT] Today was an ordinary day. I went to class, made dinner, and read for a while. There is still work to do tomorrow, but tonight I am taking a little time for myself.",
    "An ordinary day of study and familiar routines ends with time to rest.",
    ["calm", "reflection"],
    ["daily routine", "rest"],
  ),
  fixture(
    3,
    "2026-10-24T19:00:00Z",
    "completed",
    "negative",
    "[DEMO TRANSCRIPT] The project deadline felt overwhelming today. I was frustrated that I could not finish everything. I asked my teammate for help and decided to take it one step at a time.",
    "A challenging deadline prompted frustration and a decision to ask for support.",
    ["frustration", "worry"],
    ["school", "support"],
  ),
  fixture(4, "2026-10-23T18:00:00Z", "queued", null, null, "", [], []),
  fixture(5, "2026-10-22T18:00:00Z", "failed", null, null, "", [], []),
  fixture(6, "2026-10-21T18:00:00Z", "awaiting_upload", null, null, "", [], []),
];
export const demoResult = {
  transcript:
    "[DEMO TRANSCRIPT] This is synthetic test content. I had a good day, took a peaceful walk, and felt grateful for my friends.",
  analysis: {
    sentiment: "positive",
    emotions: ["gratitude", "calm"],
    themes: ["friends", "daily life"],
    summary:
      "Demo/mock results: a fictional day with moments of calm and connection. Your video has not been transcribed or analyzed.",
  },
} satisfies Pick<JournalDetail, "transcript" | "analysis">;

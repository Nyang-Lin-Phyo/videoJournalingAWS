import { useEffect, useState } from "react";
import { CloudEnvironmentContext, type CloudEnvironment } from "./CloudEnvironment";
import { CloudIngestApp } from "./CloudIngestApp";
import { fixtureJournals } from "../mocks/fixtures";
import type { AnalysisResult } from "./analysisApi";

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
          return {
            complete: true,
            message: "Local preview data was cleared. No real account was deleted.",
          };
        },
        async uploadMp4(file, title, onStage, onProgress, _token, signal) {
          signal?.throwIfAborted();
          onStage("uploading");
          const id = crypto.randomUUID();
          videoUrls.set(id, URL.createObjectURL(file));
          entries.set(id, { upload_id: id, title, created_at: new Date().toISOString(), status: "completed",
            transcript: "[DEMO TRANSCRIPT] This is fictional preview text. Your selected video has not been transcribed or sent to AWS.\n\nToday I made time for a quiet walk after class. There was a lot on my mind, but stepping outside helped me slow down. I noticed the changing leaves and called a friend on the way home.\n\nSometimes a small pause is enough. Tomorrow I want to carry a little of that calm into the day.",
            analysis: { sentiment: "neutral", emotions: ["calm"], themes: ["reflection"],
              summary: "Fictional preview reflection. Your video has not been analyzed." }, error: null });
          onProgress(100);
          return { upload_id: id, object_key: `preview/${id}.mp4` };
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

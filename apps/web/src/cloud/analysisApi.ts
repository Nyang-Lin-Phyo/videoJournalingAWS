export type Analysis = {
  sentiment: "positive" | "negative" | "neutral";
  emotions: string[];
  themes: string[];
  summary: string;
};

export type AnalysisResult = {
  upload_id: string;
  title: string;
  created_at: string;
  status: "awaiting_upload" | "queued" | "transcribing" | "analyzing" | "completed" | "failed" | "deleting";
  analysis: Analysis | null;
  error: string | null;
};

const apiBase = import.meta.env.VITE_INGEST_API_URL as string | undefined;
function base() {
  if (!apiBase) throw new Error("The journal API is not configured.");
  return apiBase.replace(/\/$/, "");
}
function headers(token: string, extra?: Record<string, string>): HeadersInit {
  return { Authorization: `Bearer ${token}`, ...extra };
}

export async function fetchAnalysis(uploadId: string, token: string, signal?: AbortSignal): Promise<AnalysisResult> {
  const response = await fetch(`${base()}/uploads/${encodeURIComponent(uploadId)}/result`, {
    headers: headers(token), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to retrieve reflection (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("status" in data) || !("upload_id" in data)) {
    throw new Error("Invalid journal response.");
  }
  return data as AnalysisResult;
}

export type JournalSummary = {
  upload_id: string;
  created_at: string;
  title: string;
  status: AnalysisResult["status"];
  sentiment: Analysis["sentiment"] | null;
};
export type JournalHistory = { journals: JournalSummary[]; next_token: string | null };

export async function fetchJournals(token: string, signal?: AbortSignal, nextToken?: string): Promise<JournalHistory> {
  const query = new URLSearchParams({ limit: "20" });
  if (nextToken) query.set("next_token", nextToken);
  const response = await fetch(`${base()}/journals?${query}`, {
    headers: headers(token), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to load journals (HTTP ${response.status}).`);
  return response.json() as Promise<JournalHistory>;
}

export type VideoUrlResult = { upload_id: string; url: string; expires_in: number };
export async function fetchVideoUrl(uploadId: string, token: string, signal?: AbortSignal): Promise<VideoUrlResult> {
  const response = await fetch(`${base()}/uploads/${encodeURIComponent(uploadId)}/video-url`, {
    headers: headers(token), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to open video (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("url" in data) ||
      typeof data.url !== "string" || !data.url.startsWith("https://")) {
    throw new Error("Invalid private video response.");
  }
  return data as VideoUrlResult;
}

export async function renameJournal(uploadId: string, title: string, token: string): Promise<{upload_id:string; title:string}> {
  const response = await fetch(`${base()}/journals/${encodeURIComponent(uploadId)}`, {
    method: "PATCH", headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ title }), cache: "no-store",
  });
  if (!response.ok) throw new Error(`Unable to rename journal (HTTP ${response.status}).`);
  return response.json() as Promise<{upload_id:string; title:string}>;
}

export async function deleteJournal(uploadId: string, token: string): Promise<void> {
  const response = await fetch(`${base()}/journals/${encodeURIComponent(uploadId)}`, {
    method: "DELETE", headers: headers(token), cache: "no-store",
  });
  if (response.status !== 204) {
    let message = `Unable to delete journal (HTTP ${response.status}).`;
    try {
      const parsed = await response.json() as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch { /* keep the status code */ }
    throw new Error(message);
  }
}

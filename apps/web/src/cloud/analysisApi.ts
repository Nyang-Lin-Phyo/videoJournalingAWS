export type Analysis = {
  sentiment: "positive" | "negative" | "neutral";
  emotions: string[];
  themes: string[];
  summary: string;
};

export type AnalysisResult = {
  upload_id: string;
  status: "awaiting_upload" | "queued" | "transcribing" | "analyzing" | "completed" | "failed";
  transcript: string | null;
  analysis: Analysis | null;
  error: string | null;
};

const apiBase = import.meta.env.VITE_INGEST_API_URL as string | undefined;

export async function fetchAnalysis(uploadId: string, accessToken: string, signal?: AbortSignal): Promise<AnalysisResult> {
  if (!apiBase) throw new Error("VITE_INGEST_API_URL is missing");
  const url = `${apiBase.replace(/\/$/, "")}/uploads/${encodeURIComponent(uploadId)}/result`;
  const response = await fetch(url, { cache: "no-store", signal, headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Unable to retrieve results (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("status" in data) || !("upload_id" in data)) {
    throw new Error("Invalid results API response.");
  }
  return data as AnalysisResult;
}

export type JournalSummary = {
  upload_id: string;
  created_at: string;
  status: AnalysisResult["status"];
  sentiment: Analysis["sentiment"] | null;
};
export type JournalHistory = { journals: JournalSummary[]; next_token: string | null };
export async function fetchJournals(accessToken: string, signal?: AbortSignal): Promise<JournalHistory> {
  if (!apiBase) throw new Error("VITE_INGEST_API_URL is missing");
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/journals?limit=20`, {
    headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to retrieve journals (HTTP ${response.status}).`);
  return await response.json() as JournalHistory;
}

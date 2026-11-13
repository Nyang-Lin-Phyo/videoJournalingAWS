export const journalStatuses = [
  "awaiting_upload",
  "queued",
  "transcribing",
  "analyzing",
  "completed",
  "failed",
] as const;
export type JournalStatus = (typeof journalStatuses)[number];
export type Sentiment = "positive" | "negative" | "neutral";
export interface Analysis {
  sentiment: Sentiment;
  emotions: string[];
  themes: string[];
  summary: string;
}
// These wire types follow packages/contracts/journal.schema.json and openapi.yaml.
export interface JournalDetail {
  id: string;
  created_at: string;
  status: JournalStatus;
  video_url: string | null;
  transcript: string | null;
  analysis: Analysis | null;
  error_message: string | null;
}
export type JournalSummary = JournalDetail;
export interface CreateJournalResponse {
  journal: JournalDetail;
  upload_url: string;
}
export interface JournalApi {
  list(signal?: AbortSignal): Promise<JournalSummary[]>;
  get(id: string, signal?: AbortSignal): Promise<JournalDetail>;
  create(signal?: AbortSignal): Promise<CreateJournalResponse>;
  upload(
    created: CreateJournalResponse,
    file: File,
    signal?: AbortSignal,
  ): Promise<void>;
  complete(id: string, signal?: AbortSignal): Promise<JournalDetail>;
  delete(id: string, signal?: AbortSignal): Promise<void>;
  videoUrl(path: string): string;
}
export function isProcessing(status: JournalStatus) {
  return (
    status === "queued" || status === "transcribing" || status === "analyzing"
  );
}

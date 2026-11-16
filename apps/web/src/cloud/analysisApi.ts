
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
  transcript?: string | null;
  transcript_error?: string | null;
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

export type StreakSummary = {
  current_streak: number;
  longest_streak: number;
  points: number;
  freezes: number;
  freeze_cost: number;
  uploaded_today: boolean;
  freeze_pending: boolean;
};

function parseStreakSummary(value: unknown): StreakSummary {
  if (!value || typeof value !== "object") throw new Error("Invalid streak response.");
  const data = value as Partial<StreakSummary>;
  if (
    !Number.isSafeInteger(data.current_streak) ||
    (data.current_streak ?? -1) < 0 ||
    !Number.isSafeInteger(data.longest_streak) ||
    (data.longest_streak ?? -1) < 0 ||
    !Number.isSafeInteger(data.points) ||
    (data.points ?? -1) < 0 ||
    !Number.isSafeInteger(data.freezes) ||
    (data.freezes ?? -1) < 0 ||
    !Number.isSafeInteger(data.freeze_cost) ||
    (data.freeze_cost ?? 0) <= 0 ||
    typeof data.uploaded_today !== "boolean" ||
    typeof data.freeze_pending !== "boolean"
  ) {
    throw new Error("Invalid streak response.");
  }
  return data as StreakSummary;
}

export async function fetchStreak(token: string, timezone: string, signal?: AbortSignal): Promise<StreakSummary> {
  const query = new URLSearchParams({ timezone });
  const response = await fetch(`${base()}/streak?${query}`, {
    headers: headers(token), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to load streak (HTTP ${response.status}).`);
  return parseStreakSummary(await response.json());
}

export async function buyStreakFreeze(token: string): Promise<StreakSummary> {
  const response = await fetch(`${base()}/streak/freeze`, {
    method: "POST",
    headers: headers(token),
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Unable to buy a streak freeze (HTTP ${response.status}).`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch { /* keep the status code */ }
    throw new Error(message);
  }
  return parseStreakSummary(await response.json());
}

export type AccountDeletionProgress = {
  complete: boolean;
  message?: string;
  retry_after_seconds?: number;
};

export async function deleteAccount(token: string, email: string): Promise<AccountDeletionProgress> {
  const response = await fetch(`${base()}/account`, {
    method: "DELETE",
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ email }),
    cache: "no-store",
  });
  if (response.status === 204) return { complete: true };
  let payload: { error?: string; message?: string; retry_after_seconds?: number } = {};
  try {
    payload = await response.json() as typeof payload;
  } catch {
    if (!response.ok) throw new Error(`Unable to delete account (HTTP ${response.status}).`);
  }
  if (response.status === 202 && payload.message) {
    return {
      complete: false,
      message: payload.message,
      retry_after_seconds: payload.retry_after_seconds,
    };
  }
  if (!response.ok) {
    throw new Error(payload.error || `Unable to delete account (HTTP ${response.status}).`);
  }
  throw new Error("Invalid account-deletion response.");
}

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

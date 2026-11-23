import { localMonthRange } from "./calendarDates";

export type Analysis = {
  sentiment: "positive" | "negative" | "neutral";
  emotions: string[];
  themes: string[];
  summary: string;
  /** One small, verified recommendation built from the user's favourites. */
  suggestion?: string;
  /** Why it was offered: a heavier entry, today's situation, or a while since. */
  suggestion_reason?: "comfort" | "context_match" | "been_a_while";
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

export type QuickExportRequest = { start_date: string; end_date: string; timezone: string; template: string; request_key: string };
export async function startQuickExport(token: string, value: QuickExportRequest, signal?: AbortSignal): Promise<{job_id:string;status:string}> {
  const response=await fetch(`${base()}/journal-exports`,{method:'POST',headers:headers(token,{'Content-Type':'application/json'}),body:JSON.stringify(value),cache:'no-store',signal});
  const data=await response.json() as {job_id?:string;status?:string;error?:string};
  if(!response.ok) throw new Error(data.error || `Unable to start PDF export (HTTP ${response.status}).`);
  return data as {job_id:string;status:string};
}
export async function fetchQuickExport(token:string,jobId:string,signal?:AbortSignal):Promise<{status:string;download_url?:string}> {
  const response=await fetch(`${base()}/journal-exports/${encodeURIComponent(jobId)}`,{headers:headers(token),cache:'no-store',signal});
  const data=await response.json() as {status?:string;download_url?:string;error?:string};
  if(!response.ok) throw new Error(data.error || `Unable to check PDF export (HTTP ${response.status}).`);
  return data as {status:string;download_url?:string};
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
  source_type?: "video" | "text";
  page_available?: boolean;
};
export type JournalPageBlock =
  | { id: string; kind: "text"; width: "full" | "wide" | "half"; widthPercent?: number; heightMm?: number; text: string; style?: "paragraph" | "note"; highlight?: string; source?: boolean; sourceJournalId?: string; x?: number; y?: number; rotation?: number; fontSize?: number }
  | { id: string; kind: "image"; width: "full" | "wide" | "half"; widthPercent?: number; heightMm?: number; photoId: string; caption?: string; highlight?: boolean; x?: number; y?: number; rotation?: number };
export type JournalPage = { journalId: string; dayKey?: string; timezone?: string; sources?: { id: string; title: string; date: string }[]; title: string; date: string; revision: number; blocks: JournalPageBlock[]; highlightPage: boolean; originalText?: string };
export async function fetchJournalPage(token: string, journalId: string): Promise<JournalPage> {
  const response = await fetch(`${base()}/journals/${encodeURIComponent(journalId)}/page`, { headers: headers(token), cache: "no-store" });
  const value = await response.json() as JournalPage & { error?: string };
  if (!response.ok) throw new Error(value.error || `Unable to load journal page (HTTP ${response.status}).`);
  return value;
}
export async function saveJournalPage(token: string, journalId: string, value: Pick<JournalPage, "revision" | "blocks" | "highlightPage">): Promise<JournalPage> {
  const response = await fetch(`${base()}/journals/${encodeURIComponent(journalId)}/page`, { method: "PUT", headers: headers(token, { "Content-Type": "application/json" }), body: JSON.stringify(value), cache: "no-store" });
  const result = await response.json() as JournalPage & { error?: string };
  if (!response.ok) throw new Error(result.error || `Unable to save journal page (HTTP ${response.status}).`);
  return result;
}
export async function fetchDailyPage(token: string, dayKey: string, timezone: string): Promise<JournalPage> {
  const query = new URLSearchParams({ timezone });
  const response = await fetch(`${base()}/journal-days/${encodeURIComponent(dayKey)}?${query}`, { headers: headers(token), cache: "no-store" });
  const value = await response.json() as JournalPage & { error?: string };
  if (!response.ok) throw new Error(value.error || `Unable to load daily page (HTTP ${response.status}).`);
  return value;
}
export async function saveDailyPage(token: string, dayKey: string, timezone: string, value: Pick<JournalPage, "revision" | "blocks" | "highlightPage">): Promise<JournalPage> {
  const query = new URLSearchParams({ timezone });
  const response = await fetch(`${base()}/journal-days/${encodeURIComponent(dayKey)}?${query}`, { method: "PUT", headers: headers(token, { "Content-Type": "application/json" }), body: JSON.stringify(value), cache: "no-store" });
  const result = await response.json() as JournalPage & { error?: string };
  if (!response.ok) throw new Error(result.error || `Unable to save daily page (HTTP ${response.status}).`);
  return result;
}
export type JournalHistory = { journals: JournalSummary[]; next_token: string | null };

export type MemoryNarrative = { id: string; text: string; original_text: string; candidate?: string; quotes: string[]; favorite: boolean; meaningful: boolean; narrativeRevision: number; metadataRevision: number; sourceAvailable: boolean };
export type MemoryReflection = { period: "month" | "year"; key: string; text: string; sourceIds: string[]; coverage: { journal_count: number; start_date: string; end_date: string; source_characters: number }; aiGenerated: true; approved: boolean; included: boolean };
export type MemoryWritingPreferences = { style: string; amount: string; revision: number };
export async function fetchMemoryPreferences(token: string): Promise<MemoryWritingPreferences> {
  const response=await fetch(`${base()}/memory-preferences`,{headers:headers(token),cache:"no-store"});
  if (!response.ok) throw new Error(`Unable to load writing preferences (HTTP ${response.status}).`);
  return response.json() as Promise<MemoryWritingPreferences>;
}
export async function saveMemoryPreferences(token: string, value: MemoryWritingPreferences): Promise<MemoryWritingPreferences> {
  const response=await fetch(`${base()}/memory-preferences`,{method:"PUT",headers:headers(token,{"Content-Type":"application/json"}),body:JSON.stringify(value),cache:"no-store"});
  const result=await response.json() as MemoryWritingPreferences & {error?:string};
  if (!response.ok) throw new Error(result.error || `Unable to save writing preferences (HTTP ${response.status}).`);
  return result;
}
export type MemoryArea = { mode: "blank" | "text" | "image"; text?: string; photoId?: string };
export type MemoryBookRecord = { id: string; title: string; subtitle: string; contentMode?: "journal-pages" | "legacy"; includeHighlights?: boolean; templateId?: string; theme: string; texture: string; fontSize: number; headingSize?: number; coverBackground?: string; coverFont?: string; bodyFont?: string; textColor?: string; pageColor?: string; marginMm?: number; lineSpacing?: number; headingFont?: string; pageBorder?: boolean; rewriteStyle?: string; rewriteAmount?: string; coverPhotoId?: string; timezone?: string; chapterTitles?: Record<string,string>; chapterOrder?: string[]; dateStart?: string; dateEnd?: string; excludedDays?: string[]; yearSectionEnabled?: boolean; yearSectionText?: string; reflections?: MemoryReflection[]; revision: number; entries: (MemoryNarrative & { title: string; date: string; areas?: Record<string, MemoryArea>; annotation?: string; stickers?: string[]; personalStickerPhotoId?: string; quoteDisplay?: string; quoteModes?: Record<string,string>; photoId?: string; photoIds?: string[]; caption?: string; focal?: { x: number; y: number }; layout?: string; approved: boolean; included: boolean })[] };
export type MemoryPhoto = { photo_id: string; status: string; url?: string };
export async function fetchMemoryPhotos(token: string): Promise<MemoryPhoto[]> {
  const response = await fetch(`${base()}/memory-photos`, { headers: headers(token), cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load photos (HTTP ${response.status}).`);
  const value = await response.json() as { photos?: MemoryPhoto[] };
  if (!Array.isArray(value.photos)) throw new Error("Invalid photo response.");
  return value.photos;
}
export async function uploadMemoryPhoto(token: string, file: File | Blob): Promise<string> {
  if (file.size < 1 || file.size > 5 * 1024 * 1024) throw new Error("Choose an image up to 5 MiB.");
  const type = file.type;
  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  const create = await fetch(`${base()}/memory-photos`, { method: "POST", headers: headers(token, { "Content-Type": "application/json" }), body: JSON.stringify({ content_type: type }), cache: "no-store" });
  const upload = await create.json() as { photo_id?: string; upload?: { url: string; fields: Record<string,string> }; error?: string };
  if (!create.ok || !upload.photo_id || !upload.upload) throw new Error(upload.error || "Unable to prepare photo upload.");
  const form = new FormData();
  Object.entries(upload.upload.fields).forEach(([key,value]) => form.append(key,value));
  form.append("file", file);
  const posted = await fetch(upload.upload.url, { method: "POST", body: form });
  if (!posted.ok) throw new Error("Private photo upload failed.");
  const finalized = await fetch(`${base()}/memory-photos/${upload.photo_id}/finalize`, { method: "POST", headers: headers(token), cache: "no-store" });
  if (!finalized.ok) throw new Error("Unable to process the uploaded photo.");
  for (let attempt=0; attempt<20; attempt++) {
    const response = await fetch(`${base()}/memory-photos/${upload.photo_id}`, { headers: headers(token), cache: "no-store" });
    if (!response.ok) throw new Error("Unable to check photo processing.");
    const status = await response.json() as { status?: string };
    if (status.status === "complete") return upload.photo_id;
    if (status.status === "failed") throw new Error("The uploaded file is not a supported image.");
    await new Promise(resolve => window.setTimeout(resolve, 1000));
  }
  throw new Error("Photo processing is still underway. Reload your photo library in a moment.");
}
export async function fetchMemoryNarratives(token: string, refs: {id:string;narrativeRevision?:number}[]): Promise<Map<string,MemoryNarrative>> {
  const narratives=new Map<string,MemoryNarrative>();
  for (let i=0;i<refs.length;i+=50) {
    const batch=refs.slice(i,i+50);
    const query=new URLSearchParams({ids:batch.map(ref=>ref.id).join(",")});
    const revisions=batch.filter(ref=>(ref.narrativeRevision??0)>0).map(ref=>`${ref.id}:${ref.narrativeRevision}`).join(",");
    if (revisions) query.set("revisions",revisions);
    const response=await fetch(`${base()}/memory-narratives?${query}`,{headers:headers(token),cache:"no-store"});
    if (!response.ok) throw new Error(`Unable to load saved memories (HTTP ${response.status}).`);
    const payload=await response.json() as {narratives?:MemoryNarrative[]};
    payload.narratives?.forEach(narrative=>narratives.set(narrative.id,narrative));
  }
  return narratives;
}
export async function fetchMemoryBooks(token: string): Promise<MemoryBookRecord[]> {
  const response = await fetch(`${base()}/memory-books`, { headers: headers(token), cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load memory books (HTTP ${response.status}).`);
  const result = await response.json() as { books?: MemoryBookRecord[] };
  if (!Array.isArray(result.books)) throw new Error("Invalid memory book response.");
  return Promise.all(result.books.map(async book=>{
    if (book.contentMode === "journal-pages") return book;
    const narratives=await fetchMemoryNarratives(token,book.entries);
    return {...book,entries:book.entries.map(entry=>({...entry,...(narratives.get(entry.id) ?? {text:"",original_text:"",quotes:[],favorite:false,meaningful:false,narrativeRevision:0,metadataRevision:0,sourceAvailable:false})}))};
  }));
}
export async function saveMemoryBook(token: string, book: MemoryBookRecord): Promise<MemoryBookRecord> {
  const entries = book.contentMode === "journal-pages"
    ? book.entries.map(({ id, title, date, included }) => ({ id, title, date, included }))
    : book.entries.map(({ original_text: _original, ...entry }) => entry);
  const response = await fetch(`${base()}/memory-books/${encodeURIComponent(book.id)}`, {
    method: "PUT", headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ ...book, entries }), cache: "no-store",
  });
  if (!response.ok) {
    let message = `Unable to save memory book (HTTP ${response.status}).`;
    try { const value = await response.json() as { error?: string }; message = value.error || message; } catch { /* retain status */ }
    throw new Error(message);
  }
  const saved=await response.json() as MemoryBookRecord;
  if (saved.contentMode === "journal-pages") return saved;
  const narratives=await fetchMemoryNarratives(token,saved.entries);
  return {...saved,entries:saved.entries.map(entry=>({...entry,...(narratives.get(entry.id) ?? {text:"",original_text:"",quotes:[],favorite:false,meaningful:false,narrativeRevision:0,sourceAvailable:false})}))};
}
export async function deleteMemoryBook(token: string, bookId: string): Promise<void> {
  const response = await fetch(`${base()}/memory-books/${encodeURIComponent(bookId)}`, {
    method: "DELETE", headers: headers(token), cache: "no-store",
  });
  if (!response.ok) {
    let message = `Unable to delete memory book (HTTP ${response.status}).`;
    try { const value = await response.json() as { error?: string; message?: string }; message = value.error || value.message || message; } catch { /* retain status */ }
    throw new Error(message);
  }
}
export async function startMemoryExport(token: string, bookId: string): Promise<{ book_id: string; revision: number; status: string }> {
  const response = await fetch(`${base()}/memory-books/${encodeURIComponent(bookId)}/exports`, { method: "POST", headers: headers(token), cache: "no-store" });
  const value = await response.json() as { error?: string; book_id?: string; revision?: number; status?: string };
  if (!response.ok) throw new Error(value.error || `Unable to start PDF export (HTTP ${response.status}).`);
  return value as { book_id: string; revision: number; status: string };
}
export async function fetchMemoryExport(token: string, bookId: string, revision: number): Promise<{ status: string; download_url?: string }> {
  const response = await fetch(`${base()}/memory-books/${encodeURIComponent(bookId)}/exports/${revision}`, { headers: headers(token), cache: "no-store" });
  const value = await response.json() as { error?: string; status?: string; download_url?: string };
  if (!response.ok) throw new Error(value.error || `Unable to check PDF export (HTTP ${response.status}).`);
  return value as { status: string; download_url?: string };
}
export async function retryMemoryExport(token: string, bookId: string, revision: number): Promise<{ book_id: string; revision: number; status: string }> {
  const response = await fetch(`${base()}/memory-books/${encodeURIComponent(bookId)}/exports/${revision}/retry`, { method: "POST", headers: headers(token), cache: "no-store" });
  const value = await response.json() as { error?: string; book_id?: string; revision?: number; status?: string };
  if (!response.ok) throw new Error(value.error || `Unable to retry PDF export (HTTP ${response.status}).`);
  return value as { book_id: string; revision: number; status: string };
}
export async function rewriteMemory(token: string, bookId: string, uploadId: string, style: string, amount: string): Promise<{ candidate: string }> {
  const response = await fetch(`${base()}/memory-books/${encodeURIComponent(bookId)}/memories/${encodeURIComponent(uploadId)}/rewrite`, {
    method: "POST", headers: headers(token, { "Content-Type": "application/json" }), body: JSON.stringify({ style, amount }), cache: "no-store",
  });
  const value = await response.json() as { candidate?: string; error?: string };
  if (!response.ok || typeof value.candidate !== "string") throw new Error(value.error || `Unable to rewrite memory (HTTP ${response.status}).`);
  return { candidate: value.candidate };
}
export async function generateMemoryReflection(token: string, bookId: string, period: "month" | "year", key: string, sourceIds: string[] = [], timezone = "UTC", dateStart = "", dateEnd = ""): Promise<MemoryReflection> {
  const response=await fetch(`${base()}/memory-books/${encodeURIComponent(bookId)}/reflections`,{method:"POST",headers:headers(token,{"Content-Type":"application/json"}),body:JSON.stringify({period,key,source_ids:sourceIds,timezone,date_start:dateStart,date_end:dateEnd}),cache:"no-store"});
  const value=await response.json() as {error?:string;text?:string;ai_generated?:boolean;source_ids?:string[];coverage?:MemoryReflection["coverage"]};
  if (!response.ok || !value.text || !value.source_ids || !value.coverage) throw new Error(value.error || `Unable to generate reflection (HTTP ${response.status}).`);
  return {period,key,text:value.text,sourceIds:value.source_ids,coverage:value.coverage,aiGenerated:true,approved:false,included:true};
}

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

/** Stated preferences only; the server never returns anything it has learned. */
export type UserProfile = {
  onboarding_completed: boolean;
  interests: string[];
  music: string[];
  mood_boosters: string[];
  comfort_foods: string[];
  music_note: string;
};
export type ProfileUpdate = Omit<UserProfile, "onboarding_completed"> & {
  complete_onboarding?: boolean;
};

function parseProfile(value: unknown): UserProfile {
  const data = value as Partial<UserProfile> | null;
  const list = (item: unknown) => Array.isArray(item) && item.every(entry => typeof entry === "string");
  if (!data || typeof data !== "object" || typeof data.onboarding_completed !== "boolean" ||
      !list(data.interests) || !list(data.music) || !list(data.mood_boosters) ||
      (data.comfort_foods !== undefined && !list(data.comfort_foods)) ||
      typeof data.music_note !== "string") {
    throw new Error("Invalid profile response.");
  }
  // Tolerate an API deployed before comfort foods existed.
  return { ...data, comfort_foods: data.comfort_foods ?? [] } as UserProfile;
}

export async function fetchProfile(token: string, signal?: AbortSignal): Promise<UserProfile> {
  const response = await fetch(`${base()}/profile`, {
    headers: headers(token), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to load your interests (HTTP ${response.status}).`);
  return parseProfile(await response.json());
}

export async function saveProfile(token: string, update: ProfileUpdate): Promise<UserProfile> {
  const response = await fetch(`${base()}/profile`, {
    method: "PUT",
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(update),
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Unable to save your interests (HTTP ${response.status}).`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch { /* keep the status code */ }
    throw new Error(message);
  }
  return parseProfile(await response.json());
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
  const query = new URLSearchParams({ limit: "50" });
  if (nextToken) query.set("next_token", nextToken);
  const response = await fetch(`${base()}/journals?${query}`, {
    headers: headers(token), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to load journals (HTTP ${response.status}).`);
  return response.json() as Promise<JournalHistory>;
}

/** Fetch only journal summaries in an inclusive local date range. UTC windows
 * are padded to include every IANA timezone offset, then filtered exactly. */
export async function fetchJournalsInRange(token: string, start: string, end: string, timezone: string, signal?: AbortSignal): Promise<JournalSummary[]> {
  if ((start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) || (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) || (start && end && start > end)) {
    throw new Error("Choose a valid date range.");
  }
  const localDay = (value: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
    const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const validDate = (value: string) => !value || (Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
  if (!validDate(start) || !validDate(end)) throw new Error("Choose valid calendar dates.");
  const output = new Map<string, JournalSummary>();
  if (!start && !end) {
    let tokenNext: string | null = null;
    for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
      const page = await fetchJournals(token, signal, tokenNext ?? undefined);
      page.journals.forEach(item => output.set(item.upload_id, item));
      tokenNext = page.next_token;
      if (!tokenNext) break;
    }
  } else {
    const dayMs = 86_400_000;
    let cursor = Date.parse(`${start}T00:00:00.000Z`) - 2 * dayMs;
    const upper = Date.parse(`${end}T00:00:00.000Z`) + 3 * dayMs;
    while (cursor < upper) {
      const stop = Math.min(cursor + 30 * dayMs, upper);
      const lowerText = new Date(cursor).toISOString(), upperText = new Date(stop - 1).toISOString();
      let tokenNext: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "50", start: lowerText, end: upperText });
        if (tokenNext) query.set("next_token", tokenNext);
        const response = await fetch(`${base()}/journals?${query}`, { headers: headers(token), cache: "no-store", signal });
        if (!response.ok) throw new Error(`Unable to load journals (HTTP ${response.status}).`);
        const page = await response.json() as JournalHistory;
        page.journals.forEach(item => { const day = localDay(item.created_at); if (day >= start && day <= end) output.set(item.upload_id, item); });
        tokenNext = page.next_token;
      } while (tokenNext);
      cursor = stop;
    }
  }
  return [...output.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.upload_id.localeCompare(b.upload_id));
}

/** Date-scoped summary fetch: no video, transcript, or model work. */
export async function fetchJournalMonth(token: string, month: string, signal?: AbortSignal, nextToken?: string): Promise<JournalHistory> {
  const [year, number] = month.split("-").map(Number);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !year || !number) throw new Error("Invalid calendar month.");
  const query = new URLSearchParams({ limit: "50", ...localMonthRange(month) });
  if (nextToken) query.set("next_token", nextToken);
  const response = await fetch(`${base()}/journals?${query}`, {
    headers: headers(token), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Unable to load calendar month (HTTP ${response.status}).`);
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

import type { CreateJournalResponse, JournalApi, JournalDetail } from "./types";
import { journalStatuses } from "./types";
import { ApiError, isAbort } from "./errors";

const messages: Record<number, string> = {
  404: "This journal could not be found. It may have been deleted.",
  409: "This journal cannot accept that action right now. Refresh its status before trying again.",
  413: "This video exceeds the 30 MiB upload limit. Choose a smaller MP4.",
  415: "This video is not a supported MP4. Choose another MP4 file.",
  422: "The request could not be accepted. Check your video and try again.",
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(
      0,
      "The API returned an unexpected response. Please check the backend version.",
    );
  return value as Record<string, unknown>;
}
function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}
export function parseJournal(value: unknown): JournalDetail {
  const row = object(value);
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.created_at !== "string" ||
    Number.isNaN(Date.parse(row.created_at)) ||
    !journalStatuses.includes(row.status as JournalDetail["status"]) ||
    !nullableString(row.video_url) ||
    !nullableString(row.transcript) ||
    !nullableString(row.error_message)
  )
    throw new ApiError(
      0,
      "The journal response does not match the repository contract.",
    );
  if (row.analysis !== null) {
    const analysis = object(row.analysis);
    if (
      !["positive", "negative", "neutral"].includes(
        String(analysis.sentiment),
      ) ||
      typeof analysis.summary !== "string" ||
      !Array.isArray(analysis.emotions) ||
      !analysis.emotions.every((x) => typeof x === "string") ||
      !Array.isArray(analysis.themes) ||
      !analysis.themes.every((x) => typeof x === "string")
    )
      throw new ApiError(
        0,
        "The analysis response does not match the repository contract.",
      );
  }
  if (row.status === "completed" && (!row.transcript || row.analysis === null))
    throw new ApiError(
      0,
      "The API marked this journal ready without its results. Please refresh or contact the backend developer.",
    );
  return row as unknown as JournalDetail;
}
export function createHttpJournalApi(
  base: string,
  fetcher: typeof fetch = fetch,
): JournalApi {
  const baseUrl = new URL(base, window.location.origin);
  function url(path: string) {
    const result = new URL(path, baseUrl);
    if (result.origin !== baseUrl.origin)
      throw new ApiError(
        0,
        "The API returned a video URL outside the configured server.",
      );
    return result.href;
  }
  async function request<T>(
    path: string,
    init: RequestInit,
    expected: number,
    decode?: (data: unknown) => T,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, init.method === "PUT" ? 120_000 : 20_000);
    try {
      const response = await fetcher(url(path), {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        // Parse FastAPI's JSON error shape without rendering potentially sensitive server details.
        const body = (await response.json().catch(() => null)) as {
          detail?: unknown;
        } | null;
        const validationError =
          response.status === 422 && Array.isArray(body?.detail);
        throw new ApiError(
          response.status,
          messages[response.status] ||
            (validationError
              ? messages[422]
              : "The server could not finish this request. Please try again."),
        );
      }
      if (response.status !== expected)
        throw new ApiError(
          response.status,
          "The API returned an unexpected status. Please check the backend version.",
        );
      if (expected === 204) return undefined as T;
      const data: unknown = await response.json();
      return decode ? decode(data) : (data as T);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (init.signal?.aborted)
        throw new DOMException("Cancelled", "AbortError");
      if (isAbort(error))
        throw new ApiError(
          0,
          "The request timed out. Check the local API and try again.",
        );
      if (error instanceof SyntaxError)
        throw new ApiError(0, "The API did not return valid JSON.");
      throw new ApiError(
        0,
        "Could not reach the local API. Check that it is running and that the frontend origin is allowed.",
      );
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abort);
    }
  }
  const entryPath = (id: string) => `/api/journals/${encodeURIComponent(id)}`;
  return {
    list: (signal) =>
      request("/api/journals", { signal }, 200, (data) => {
        const body = object(data);
        if (!Array.isArray(body.journals))
          throw new ApiError(
            0,
            "Expected the repository’s journals list response.",
          );
        return body.journals.map(parseJournal);
      }),
    get: (id, signal) => request(entryPath(id), { signal }, 200, parseJournal),
    create: (signal) =>
      request(
        "/api/journals",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        },
        201,
        (data) => {
          const body = object(data);
          if (typeof body.upload_url !== "string")
            throw new ApiError(
              0,
              "Expected the repository’s upload_url response.",
            );
          return {
            journal: parseJournal(body.journal),
            upload_url: body.upload_url,
          };
        },
      ),
    upload: (created, file, signal) =>
      request<void>(
        created.upload_url,
        {
          method: "PUT",
          headers: { "Content-Type": "video/mp4" },
          body: file,
          signal,
        },
        204,
      ),
    complete: (id, signal) =>
      request(
        `${entryPath(id)}/complete`,
        { method: "POST", signal },
        202,
        parseJournal,
      ),
    delete: (id, signal) =>
      request<void>(entryPath(id), { method: "DELETE", signal }, 204),
    videoUrl: url,
  };
}
export async function submitJournal(
  api: JournalApi,
  file: File,
  onStage: (stage: "creating" | "uploading" | "queueing") => void,
  onCreated: (created: CreateJournalResponse) => void,
  signal?: AbortSignal,
) {
  onStage("creating");
  const created = await api.create(signal);
  onCreated(created);
  onStage("uploading");
  await api.upload(created, file, signal);
  onStage("queueing");
  return api.complete(created.journal.id, signal);
}

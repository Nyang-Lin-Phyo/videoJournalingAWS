import type { JournalApi, JournalDetail } from "../api/types";
import { isProcessing } from "../api/types";
import { ApiError } from "../api/errors";
import { validateVideo } from "../api/validation";
import { demoResult, fixtureJournals } from "./fixtures";

// Deliberately in memory: a reload resets examples and discards uploaded video URLs.
export function createMockJournalApi(
  seed: JournalDetail[] = fixtureJournals,
  clock = Date.now,
): JournalApi {
  const entries = new Map(
    seed.map((entry) => [entry.id, structuredClone(entry)]),
  );
  const started = new Map<string, number>();
  const blobs = new Map<string, string>();
  for (const entry of seed)
    if (isProcessing(entry.status)) started.set(entry.id, clock());
  let counter = 100;
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  };
  function get(id: string) {
    const entry = entries.get(id);
    if (!entry)
      throw new ApiError(
        404,
        "This demo journal could not be found. Demo entries reset on refresh.",
      );
    const start = started.get(id);
    if (start !== undefined) {
      const elapsed = clock() - start;
      entry.status =
        elapsed < 2500
          ? "queued"
          : elapsed < 5000
            ? "transcribing"
            : elapsed < 7500
              ? "analyzing"
              : "completed";
      if (entry.status === "completed") {
        Object.assign(entry, structuredClone(demoResult));
        started.delete(id);
      }
    }
    return entry;
  }
  return {
    async list(signal) {
      check(signal);
      return [...entries.keys()]
        .map((id) => structuredClone(get(id)))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async get(id, signal) {
      check(signal);
      return structuredClone(get(id));
    },
    async create(signal) {
      check(signal);
      const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
      const entry: JournalDetail = {
        id,
        created_at: new Date(clock()).toISOString(),
        status: "awaiting_upload",
        video_url: null,
        transcript: null,
        analysis: null,
        error_message: null,
      };
      entries.set(id, entry);
      return {
        journal: structuredClone(entry),
        upload_url: `/api/journals/${id}/video`,
      };
    },
    async upload(created, file, signal) {
      check(signal);
      const entry = get(created.journal.id);
      if (entry.status !== "awaiting_upload" || entry.video_url)
        throw new ApiError(409, "This demo journal already has a video.");
      const invalid = validateVideo(file);
      if (invalid) throw new ApiError(415, invalid);
      const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      check(signal);
      if (String.fromCharCode(...header.slice(4, 8)) !== "ftyp")
        throw new ApiError(
          415,
          "This file does not have a valid MP4 header. Choose another video.",
        );
      const blobUrl = URL.createObjectURL(file);
      blobs.set(entry.id, blobUrl);
      entry.video_url = blobUrl;
    },
    async complete(id, signal) {
      check(signal);
      const entry = get(id);
      if (entry.status !== "awaiting_upload")
        throw new ApiError(409, "This demo journal has already been queued.");
      if (!entry.video_url)
        throw new ApiError(409, "Upload a video before starting processing.");
      entry.status = "queued";
      started.set(id, clock());
      return structuredClone(entry);
    },
    async delete(id, signal) {
      check(signal);
      const entry = get(id);
      if (isProcessing(entry.status))
        throw new ApiError(
          409,
          "Wait until processing finishes before deleting this journal.",
        );
      const blob = blobs.get(id);
      if (blob) URL.revokeObjectURL(blob);
      blobs.delete(id);
      entries.delete(id);
    },
    videoUrl: (path) => path,
  };
}
export const mockJournalApi = createMockJournalApi();

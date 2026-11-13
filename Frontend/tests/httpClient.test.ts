import { describe, it, expect, vi } from "vitest";
import {
  createHttpJournalApi,
  parseJournal,
  submitJournal,
} from "../src/api/httpClient";
import { fixtureJournals } from "../src/mocks/fixtures";
const entry = {
  ...fixtureJournals[0],
  status: "awaiting_upload" as const,
  transcript: null,
  analysis: null,
};
const created = {
  journal: entry,
  upload_url: `/api/journals/${entry.id}/video`,
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
describe("repository HTTP contract", () => {
  it("uses repository shapes and creates → raw PUT → complete in order, resolving the API origin", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(created, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ ...entry, status: "queued" }, 202));
    const api = createHttpJournalApi("http://127.0.0.1:8000", fetcher);
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    const result = await submitJournal(api, file, vi.fn(), vi.fn());
    expect(result.status).toBe("queued");
    expect(
      fetcher.mock.calls.map(([url, options]) => [url, options?.method]),
    ).toEqual([
      ["http://127.0.0.1:8000/api/journals", "POST"],
      [`http://127.0.0.1:8000${created.upload_url}`, "PUT"],
      [`http://127.0.0.1:8000/api/journals/${entry.id}/complete`, "POST"],
    ]);
    expect(fetcher.mock.calls[0][1]?.body).toBe("{}");
    expect(fetcher.mock.calls[1][1]?.body).toBe(file);
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({
      "Content-Type": "video/mp4",
    });
  });

  it("requires a 204 upload response before calling complete", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(created, 201))
      .mockResolvedValueOnce(json({ ok: true }, 200));
    await expect(
      submitJournal(
        createHttpJournalApi("http://127.0.0.1:8000", fetcher),
        new File(["x"], "test.mp4"),
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow("unexpected status");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not complete when PUT fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(created, 201))
      .mockResolvedValueOnce(json({ detail: "Invalid MP4 file" }, 415));
    await expect(
      submitJournal(
        createHttpJournalApi("http://127.0.0.1:8000", fetcher),
        new File(["x"], "test.mp4"),
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ status: 415 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([404, 409, 413, 415, 422, 500])(
    "handles %i with a safe readable error",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json({ detail: "private/internal/path secret" }, status),
        );
      await expect(
        createHttpJournalApi("http://127.0.0.1:8000", fetcher).list(),
      ).rejects.toMatchObject({ status });
      await expect(
        createHttpJournalApi("http://127.0.0.1:8000", fetcher).list(),
      ).rejects.not.toThrow("secret");
    },
  );
  it("handles network failures and malformed JSON", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      createHttpJournalApi("http://127.0.0.1:8000", fetcher).list(),
    ).rejects.toThrow("Could not reach the local API");
    fetcher.mockResolvedValue(new Response("invalid json"));
    await expect(
      createHttpJournalApi("http://127.0.0.1:8000", fetcher).list(),
    ).rejects.toThrow("valid JSON");
  });
  it("requires the repository list shape, preserves order, and reads error_message", async () => {
    const rows = [fixtureJournals[4], fixtureJournals[0]];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ journals: rows }))
      .mockResolvedValueOnce(json({ items: rows }));
    const api = createHttpJournalApi("http://127.0.0.1:8000", fetcher);
    expect(await api.list()).toEqual(rows);
    await expect(api.list()).rejects.toThrow("journals list response");
    expect(parseJournal(fixtureJournals[4]).error_message).toBeTruthy();
  });
  it("uses direct video playback URLs and rejects a foreign upload server", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = createHttpJournalApi("http://127.0.0.1:8000", fetcher);
    expect(api.videoUrl("/api/journals/abc/video")).toBe(
      "http://127.0.0.1:8000/api/journals/abc/video",
    );
    await expect(
      api.upload(
        { ...created, upload_url: "https://other.example/video" },
        new File(["x"], "test.mp4"),
      ),
    ).rejects.toThrow("outside the configured server");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects malformed results instead of inventing a ready entry", () => {
    expect(() =>
      parseJournal({ ...fixtureJournals[0], analysis: null }),
    ).toThrow("without its results");
    expect(() =>
      parseJournal({
        ...fixtureJournals[0],
        analysis: { ...fixtureJournals[0].analysis, sentiment: "mixed" },
      }),
    ).toThrow("analysis response");
  });
  it("deletes without parsing a 204 body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      createHttpJournalApi("http://127.0.0.1:8000", fetcher).delete(entry.id),
    ).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0][1]?.method).toBe("DELETE");
  });
  it("propagates caller cancellation and aborts timed-out requests", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted)
              reject(new DOMException("Cancelled", "AbortError"));
            else
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Cancelled", "AbortError")),
              );
          }),
      );
      const api = createHttpJournalApi("http://127.0.0.1:8000", fetcher);
      const controller = new AbortController();
      const request = api.list(controller.signal).catch((error) => error);
      controller.abort();
      expect((await request).name).toBe("AbortError");
      const timeout = api.list().catch((error) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await timeout).message).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});

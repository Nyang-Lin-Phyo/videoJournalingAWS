import { describe, expect, it, vi } from "vitest";
import { createMockJournalApi } from "../src/mocks/mockClient";
import { fixtureJournals } from "../src/mocks/fixtures";
describe("deterministic demo lifecycle", () => {
  it("progresses by elapsed time, plays uploaded blobs, deletes, and resets on new instance", async () => {
    let now = Date.parse("2026-10-26T22:00:00Z");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:test"),
        revokeObjectURL: vi.fn(),
      }),
    );
    const api = createMockJournalApi([], () => now);
    expect(await api.list()).toEqual([]);
    const created = await api.create();
    expect(created.journal.status).toBe("awaiting_upload");
    await expect(api.complete(created.journal.id)).rejects.toMatchObject({
      status: 409,
    });
    const file = new File(["\x00\x00\x00\x18ftypisom"], "synthetic.mp4", {
      type: "video/mp4",
    });
    await api.upload(created, file);
    expect((await api.get(created.journal.id)).video_url).toBe("blob:test");
    expect((await api.complete(created.journal.id)).status).toBe("queued");
    await expect(api.delete(created.journal.id)).rejects.toMatchObject({
      status: 409,
    });
    now += 2500;
    expect((await api.get(created.journal.id)).status).toBe("transcribing");
    now += 2500;
    expect((await api.get(created.journal.id)).status).toBe("analyzing");
    now += 2500;
    const finished = await api.get(created.journal.id);
    expect(finished.status).toBe("completed");
    expect(finished.transcript).toContain("DEMO");
    await api.delete(created.journal.id);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(await api.list()).toEqual([]);
    expect((await createMockJournalApi().list()).length).toBe(
      fixtureJournals.length,
    );
  });
  it("rejects an invalid MP4 and leaves an unprocessed entry", async () => {
    const api = createMockJournalApi([]);
    const created = await api.create();
    await expect(
      api.upload(
        created,
        new File(["not a video"], "invalid.mp4", { type: "video/mp4" }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    expect((await api.get(created.journal.id)).status).toBe("awaiting_upload");
    expect((await api.get(created.journal.id)).video_url).toBeNull();
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useJournal } from "../src/hooks/useJournal";
import { createMockJournalApi } from "../src/mocks/mockClient";
import { fixtureJournals } from "../src/mocks/fixtures";
afterEach(() => vi.useRealTimers());
describe("processing polling", () => {
  it.each(["completed", "failed"] as const)(
    "stops when %s and cleans up on unmount",
    async (terminal) => {
      vi.useFakeTimers();
      const api = createMockJournalApi([]);
      api.get = vi
        .fn()
        .mockResolvedValueOnce({ ...fixtureJournals[0], status: "queued" })
        .mockResolvedValueOnce({ ...fixtureJournals[0], status: terminal });
      const { result, unmount } = renderHook(() => useJournal(api, "id"));
      await act(async () => {});
      expect(result.current.journal?.status).toBe("queued");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(result.current.journal?.status).toBe(terminal);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(api.get).toHaveBeenCalledTimes(2);
      unmount();
    },
  );
  it("aborts old requests and avoids duplicate loops on manual refresh and navigation", async () => {
    vi.useFakeTimers();
    const api = createMockJournalApi([]);
    api.get = vi
      .fn()
      .mockResolvedValue({ ...fixtureJournals[0], status: "analyzing" });
    const { result, unmount, rerender } = renderHook(
      ({ id }) => useJournal(api, id),
      { initialProps: { id: "one" } },
    );
    await act(async () => {});
    const firstSignal = vi.mocked(api.get).mock.calls[0][1];
    await act(async () => result.current.refresh());
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(api.get).toHaveBeenCalledTimes(3);
    rerender({ id: "two" });
    await act(async () => {});
    const lastSignal = vi.mocked(api.get).mock.calls.at(-1)?.[1];
    unmount();
    expect(lastSignal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(api.get).toHaveBeenCalledTimes(4);
  });
});

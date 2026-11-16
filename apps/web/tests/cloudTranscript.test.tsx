import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudHistoryPage } from "../src/cloud/CloudHistoryPage";

const api = vi.hoisted(() => ({
  fetchJournals: vi.fn(), fetchAnalysis: vi.fn(), fetchVideoUrl: vi.fn(),
  deleteJournal: vi.fn(), renameJournal: vi.fn(),
}));
vi.mock("../src/cloud/analysisApi", () => api);
vi.mock("../src/cloud/CloudEnvironment", () => ({
  useCloudEnvironment: () => ({ accessToken: "test-token", userSub: "test-user", services: api }),
}));

beforeEach(() => {
  api.fetchJournals.mockResolvedValue({ journals: [{
    upload_id: "test-journal", title: "A quiet day", status: "completed", created_at: "2026-11-01T12:00:00Z",
  }], next_token: null });
  api.fetchVideoUrl.mockRejectedValue(new Error("Video unavailable"));
  api.fetchAnalysis.mockResolvedValue({
    upload_id: "test-journal", status: "completed", analysis: null,
    transcript: "A moment I can read without playing a video.",
  });
});

describe("cloud transcript integration", () => {
  it("opens the saved transcript even when video loading fails and closes on tab navigation", async () => {
    const { rerender } = render(<CloudHistoryPage active refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: /A quiet day/ }));
    const read = await screen.findByRole("button", { name: /Read full transcript/ });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Video unavailable"));
    fireEvent.click(read);
    expect(screen.getByRole("region", { name: "Full transcript" }).textContent).toBe("A moment I can read without playing a video.");
    expect(api.fetchAnalysis).toHaveBeenCalledWith("test-journal", "test-token", expect.any(AbortSignal));
    rerender(<CloudHistoryPage active={false} refreshKey={0} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("handles an older API response without inventing a transcript from its reflection", async () => {
    api.fetchAnalysis.mockResolvedValue({ upload_id: "test-journal", status: "completed", analysis: {
      summary: "A summary, not a transcript.", sentiment: "neutral", themes: [], emotions: [],
    } });
    render(<CloudHistoryPage active refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: /A quiet day/ }));
    expect(await screen.findByText("No transcript is available for this entry.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Read full transcript/ })).not.toBeInTheDocument();
    expect(screen.getByText("A summary, not a transcript.")).toBeVisible();
    await screen.findByRole("alert");
  });
});

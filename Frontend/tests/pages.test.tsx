import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { JournalListPage } from "../src/pages/JournalListPage";
import { UploadPage } from "../src/pages/UploadPage";
import { createMockJournalApi } from "../src/mocks/mockClient";
import { fixtureJournals } from "../src/mocks/fixtures";
import { AnalysisPanel } from "../src/components/AnalysisPanel";
import { validateVideo, MAX_VIDEO_BYTES } from "../src/api/validation";
import { ApiError } from "../src/api/errors";
function show(element: React.ReactNode) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}
describe("journal screens", () => {
  it("shows a helpful empty list and upload CTA", async () => {
    show(<JournalListPage api={createMockJournalApi([])} />);
    expect(
      await screen.findByText("Your story starts here."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Create your first entry/ }),
    ).toHaveAttribute("href", "/upload");
  });
  it("shows completed detail with transcript, sentiment, emotions, themes, summary, and a video region", async () => {
    render(
      <MemoryRouter initialEntries={[`/journals/${fixtureJournals[0].id}`]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(fixtureJournals[0].transcript!),
    ).toBeVisible();
    expect(
      screen.getByText(fixtureJournals[0].analysis!.summary),
    ).toBeVisible();
    expect(screen.getByText("positive")).toBeVisible();
    expect(screen.getByText("gratitude")).toBeVisible();
    expect(screen.getByText("friendship")).toBeVisible();
    expect(screen.getByText("An example, just for you")).toBeVisible();
    expect(screen.getByText("Demo/mock results")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    expect(
      screen.getByRole("dialog", { name: "Let this moment go?" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep entry" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete entry" })).toHaveFocus();
  });
  it("filters entries without inventing API fields", async () => {
    show(
      <JournalListPage
        api={createMockJournalApi(fixtureJournals.slice(0, 3))}
      />,
    );
    await screen.findByText("Monday’s reflection");
    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByText("No entries here yet.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /View all entries/ }));
    expect(screen.getByText("Monday’s reflection")).toBeVisible();
  });
  it("reports retryable network errors", async () => {
    const api = createMockJournalApi([]);
    api.list = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "Could not reach the local API."))
      .mockResolvedValueOnce([]);
    show(<JournalListPage api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach",
    );
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Your story starts here.")).toBeVisible();
  });
  it("rejects oversize selection without calling the API", () => {
    const api = createMockJournalApi([]);
    api.create = vi.fn();
    show(<UploadPage api={api} />);
    const file = new File(["x"], "large.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: MAX_VIDEO_BYTES + 1 });
    fireEvent.change(screen.getByLabelText("Choose MP4 video"), {
      target: { files: [file] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("exceeds 30 MiB");
    expect(
      screen.getByRole("button", { name: /Upload & reflect/ }),
    ).toBeDisabled();
    expect(api.create).not.toHaveBeenCalled();
  });
  it("preserves the file after upload error and starts a new journal when retried", async () => {
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:preview"),
        revokeObjectURL: vi.fn(),
      }),
    );
    const api = createMockJournalApi([]);
    const realCreate = api.create;
    api.create = vi.fn(realCreate);
    api.upload = vi
      .fn()
      .mockRejectedValue(
        new ApiError(415, "This video is not a supported MP4."),
      );
    api.complete = vi.fn();
    const { unmount } = show(<UploadPage api={api} />);
    const file = new File(["invalid"], "invalid.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByLabelText("Choose MP4 video"), {
      target: { files: [file] },
    });
    const upload = screen.getByRole("button", { name: /Upload & reflect/ });
    fireEvent.click(upload);
    fireEvent.click(upload);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not a supported MP4",
    );
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText("invalid.mp4")).toBeVisible();
    expect(screen.getByRole("link", { name: "View its status" })).toBeVisible();
    expect(api.complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Upload & reflect/ }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
  it("renders empty analysis lists and treats text as text", () => {
    show(
      <AnalysisPanel
        analysis={{
          sentiment: "neutral",
          emotions: [],
          themes: [],
          summary: "<script>alert(1)</script>",
        }}
      />,
    );
    expect(screen.getByText("<script>alert(1)</script>")).toBeVisible();
    expect(screen.getByText("No emotions returned.")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
  });

  it("confirms deletion, removes a demo entry, and returns to history", async () => {
    render(
      <MemoryRouter initialEntries={[`/journals/${fixtureJournals[4].id}`]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(fixtureJournals[4].error_message!),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete entry" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("heading", { name: /Your journal/ }),
    ).toBeVisible();
    expect(screen.queryByText("Thursday’s reflection")).not.toBeInTheDocument();
  });
  it("shows a retryable not-found state for an unknown detail route", async () => {
    render(
      <MemoryRouter initialEntries={["/journals/missing-id"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be found",
    );
    expect(screen.getByRole("button", { name: /Try again/ })).toBeVisible();
  });
  it("validates extension, MIME, empty files, and the inclusive 30 MiB boundary", () => {
    expect(
      validateVideo(new File(["x"], "wrong.mov", { type: "video/quicktime" })),
    ).toContain("MP4");
    expect(
      validateVideo(new File(["x"], "wrong.mp4", { type: "text/plain" })),
    ).toContain("MP4");
    expect(validateVideo(new File([], "empty.mp4"))).toContain("empty");
    const exact = new File(["x"], "valid.MP4");
    Object.defineProperty(exact, "size", { value: MAX_VIDEO_BYTES });
    expect(validateVideo(exact)).toBeNull();
  });
});

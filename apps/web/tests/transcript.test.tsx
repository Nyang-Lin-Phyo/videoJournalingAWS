import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptPanel } from "../src/components/TranscriptPanel";

const transcript = `${"An ordinary moment worth remembering. ".repeat(20)}\n\nA new paragraph. <script>not executable</script>`;

describe("transcript reader", () => {
  it("shows only a short preview until the full reader is requested", () => {
    render(<TranscriptPanel transcript={transcript} title="A quiet afternoon" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/A new paragraph/)).not.toBeInTheDocument();
    expect(screen.getByText(/An ordinary moment/).textContent!.length).toBeLessThan(245);
    fireEvent.click(screen.getByRole("button", { name: /Read full transcript/ }));
    const dialog = screen.getByRole("dialog", { name: "Your transcript" });
    expect(within(dialog).getByText("A quiet afternoon")).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "Full transcript" }).textContent).toBe(transcript);
    expect(dialog.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "Close transcript" })).toHaveFocus();
  });

  it("contains keyboard focus and restores the background and trigger on Escape", () => {
    document.body.style.overflow = "auto";
    const { container } = render(<TranscriptPanel transcript={transcript} />);
    const trigger = screen.getByRole("button", { name: /Read full transcript/ });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe("hidden");
    expect(container.inert).toBe(true);
    const close = screen.getByRole("button", { name: "Close transcript" });
    const region = screen.getByRole("region", { name: "Full transcript" });
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(region).toHaveFocus();
    fireEvent.keyDown(region, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(container.inert).not.toBe(true);
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  it("closes using the close button or backdrop, but not when reading text", () => {
    render(<TranscriptPanel transcript={transcript} />);
    const trigger = screen.getByRole("button", { name: /Read full transcript/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("region", { name: "Full transcript" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("transcript-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cleans up the portal and scroll lock when navigating away", () => {
    const { unmount } = render(<TranscriptPanel transcript={transcript} />);
    fireEvent.click(screen.getByRole("button", { name: /Read full transcript/ }));
    unmount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("handles short, missing, and processing transcripts", () => {
    const { rerender } = render(<TranscriptPanel pending />);
    expect(screen.getByText(/will appear here/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<TranscriptPanel transcript="  " />);
    expect(screen.getByText(/No transcript is available/)).toBeVisible();
    rerender(<TranscriptPanel transcript="A small win." />);
    expect(screen.getByText("A small win.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Read full transcript/ }));
    expect(screen.getByRole("region", { name: "Full transcript" }).textContent).toBe("A small win.");
  });
});

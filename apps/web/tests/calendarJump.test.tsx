import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CloudPreviewApp from "../src/cloud/CloudPreviewApp";

describe("calendar to timeline navigation", () => {
  it("scrolls to the selected journal day and does not jump back to the header", async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("tl-node") && this.closest('[data-timeline-day="2026-10-25"]')) {
        return { x: 0, y: 1200, top: 1200, left: 0, bottom: 1216, right: 16, width: 16, height: 16, toJSON: () => ({}) } as DOMRect;
      }
      return originalRect.call(this);
    });

    const scrollTo = vi.spyOn(window, "scrollTo");
    render(<CloudPreviewApp onboarded />);

    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    await screen.findByRole("button", { name: /3 moments/ });
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));

    // The month is fetched lazily; wait for its clickable journal day.
    const selected = await screen.findByRole("gridcell", { name: /October 2026 25: 3 journals/ });
    await new Promise(resolve => window.setTimeout(resolve, 35)); // Let the calendar's header scroll settle.
    scrollTo.mockClear();

    fireEvent.click(selected);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Timeline" })).toHaveAttribute("aria-pressed", "true");
      expect(scrollTo).toHaveBeenCalled();
    });
    await new Promise(resolve => window.setTimeout(resolve, 35)); // Catch any later requestAnimationFrame reset.

    const positions = scrollTo.mock.calls.map(args => (args[0] as unknown as ScrollToOptions).top);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toBeCloseTo(1208 - window.innerHeight * 0.6);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: expect.stringMatching(/smooth|instant/) }));
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalBuddy } from "../src/components/mascot/JournalBuddy";
import { BuddyContext, createBuddyChannel } from "../src/components/mascot/buddyChannel";
import { ReflectionPanel } from "../src/cloud/ReflectionPanel";

/** Step time a second at a time so React can render and run effects between timers. */
function advance(ms: number) {
  for (let t = 0; t < ms; t += 1000) act(() => { vi.advanceTimersByTime(Math.min(1000, ms - t)); });
}

describe("journal buddy mascot", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("greets once with a tip and can be closed", () => {
    render(<JournalBuddy context="upload" />);
    expect(screen.queryByRole("region", { name: "Biscuit says" })).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5_000); });
    const bubble = screen.getByRole("region", { name: "Biscuit says" });
    expect(bubble).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
    expect(screen.queryByRole("region", { name: "Biscuit says" })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("reverie.buddy.greeted")).toBe("1");
  });

  it("strolls to the other end of the line after 6–10 minutes of visible time", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // shortest delay: 6 minutes
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    window.sessionStorage.setItem("reverie.buddy.greeted", "1");
    const { container } = render(<JournalBuddy />);
    const buddy = container.querySelector<HTMLElement>(".journal-buddy")!;
    expect(buddy.style.transform).toBe("translateX(876px)"); // starts at the right end
    advance(5 * 60_000);
    expect(container.querySelector(".pixel-dog--walking")).toBeNull();
    // The 4-minute tip has drifted away by now, so the walk starts right at 6:00.
    advance(61_000);
    expect(container.querySelector(".pixel-dog--walking")).not.toBeNull();
    expect(buddy.style.transform).toBe("translateX(20px)");
    expect(buddy.className).toContain("faces-left");
    advance(15_000);
    expect(container.querySelector(".pixel-dog--walking")).toBeNull();
    width.mockRestore();
    vi.restoreAllMocks();
  });

  it("naps on request and wakes up with a tip when clicked", () => {
    render(<JournalBuddy />);
    fireEvent.click(screen.getByRole("button", { name: /your journaling buddy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Let Biscuit nap" }));
    expect(screen.queryByRole("region", { name: "Biscuit says" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("reverie.buddy.napping")).toBe("1");
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(screen.queryByRole("region", { name: "Biscuit says" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Biscuit is napping/ }));
    expect(screen.getByRole("region", { name: "Biscuit says" })).toBeVisible();
    expect(window.localStorage.getItem("reverie.buddy.napping")).toBeNull();
  });

  it("delivers the backend's recommendation even while napping, and keeps it up until closed", () => {
    window.localStorage.setItem("reverie.buddy.napping", "1");
    const channel = createBuddyChannel();
    const reflection = {
      sentiment: "negative" as const, emotions: [], themes: [], summary: "A heavy day.",
      suggestion: "Maybe a mug of hot chocolate tonight?", suggestion_reason: "comfort" as const,
    };
    render(
      <BuddyContext.Provider value={channel}>
        <ReflectionPanel reflection={reflection} />
        <JournalBuddy />
      </BuddyContext.Provider>,
    );
    const bubble = screen.getByRole("region", { name: "Biscuit says" });
    expect(bubble).toHaveTextContent("A gentle thought");
    expect(bubble).toHaveTextContent("hot chocolate");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    advance(10 * 60_000); // routine tips never replace it, and it doesn't drift away
    expect(screen.getByRole("region", { name: "Biscuit says" })).toHaveTextContent("hot chocolate");
    fireEvent.click(screen.getByRole("button", { name: "Thanks, Biscuit" }));
    expect(screen.queryByRole("region", { name: "Biscuit says" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("reverie.buddy.napping")).toBe("1"); // still napping after
    fireEvent.click(screen.getByRole("button", { name: "Hear it again" }));
    expect(screen.getByRole("region", { name: "Biscuit says" })).toHaveTextContent("hot chocolate");
  });

  it("holds a recommendation that arrives before Biscuit is on screen", () => {
    const channel = createBuddyChannel();
    channel.recommend({ text: "It has been a while since a bike ride.", reason: "been_a_while" });
    render(<BuddyContext.Provider value={channel}><JournalBuddy /></BuddyContext.Provider>);
    expect(screen.getByRole("region", { name: "Biscuit says" }))
      .toHaveTextContent("Something you might be missing");
  });
});

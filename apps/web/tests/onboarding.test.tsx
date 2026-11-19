import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CloudPreviewApp from "../src/cloud/CloudPreviewApp";
import { CloudIngestApp } from "../src/cloud/CloudIngestApp";
import { CloudEnvironmentContext, cloudServices } from "../src/cloud/CloudEnvironment";
import { ReflectionPanel } from "../src/cloud/ReflectionPanel";
import type { UserProfile } from "../src/cloud/analysisApi";

const streak = {
  current_streak: 0, longest_streak: 0, points: 0, freezes: 0, freeze_cost: 7,
  uploaded_today: false, freeze_pending: false,
};
const emptyProfile: UserProfile = {
  onboarding_completed: false, interests: [], music: [], mood_boosters: [], comfort_foods: [],
  music_note: "",
};

function renderApp(overrides: Partial<typeof cloudServices>) {
  const services = {
    ...cloudServices,
    fetchStreak: vi.fn().mockResolvedValue(streak),
    fetchJournals: vi.fn().mockResolvedValue({ journals: [], next_token: null }),
    ...overrides,
  };
  render(
    <CloudEnvironmentContext.Provider value={{ userSub: "u", accessToken: "token", isPreview: false, services }}>
      <CloudIngestApp accountEmail="journal@example.com" />
    </CloudEnvironmentContext.Provider>,
  );
  return services;
}

describe("first-run onboarding (issue #7)", () => {
  it("asks interests, music and what helps one screen at a time, then personalizes reflections", async () => {
    render(<CloudPreviewApp />);
    const dialog = await screen.findByRole("dialog", { name: "Let's get to know you a little." });
    fireEvent.click(within(dialog).getByRole("button", { name: /Get started/ }));

    expect(screen.getByRole("heading", { name: "What do you enjoy?" })).toHaveFocus();
    expect(screen.getByText("Step 1 of 4")).toBeVisible();
    const walks = screen.getByRole("button", { name: "Walks" });
    fireEvent.click(walks);
    expect(walks).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    expect(screen.getByRole("heading", { name: "What's on your playlist?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Lo-fi" }));
    fireEvent.change(screen.getByRole("textbox", { name: /favourite artist or song/i }), {
      target: { value: "Nujabes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("button", { name: "Walks" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    expect(screen.getByRole("heading", { name: /what usually helps/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fresh air" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    expect(screen.getByRole("heading", { name: "And your comfort food or drink?" })).toBeVisible();
    expect(screen.getByText("Step 4 of 4")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hot chocolate" }));
    fireEvent.click(screen.getByRole("button", { name: /Finish/ }));
    expect(await screen.findByRole("heading", { name: "You're all set." })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Start journaling/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Your interests" }));
    expect(await screen.findByRole("heading", { name: "The things that make you, you." })).toBeVisible();
    expect(within(screen.getByRole("group", { name: "Interests" })).getByRole("button", { name: "Walks" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: /favourite artist or song/i })).toHaveValue("Nujabes");
    expect(within(screen.getByRole("group", { name: "Comfort food and drink" }))
      .getByRole("button", { name: "Hot chocolate" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    fireEvent.click(await screen.findByRole("button", { name: /One step at a time/ }));
    // Biscuit delivers the recommendation; the reflection only points to him.
    const thought = await screen.findByRole("region", { name: "Biscuit says" });
    expect(thought).toHaveTextContent("A gentle thought");
    expect(thought).toHaveTextContent("hot chocolate");
    expect(screen.getByText(/Biscuit has a gentle thought for you/)).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "A gentle thought" })).not.toBeInTheDocument();

    // Recommendations are not only for sad days: a positive entry can get a "been a while" nudge.
    fireEvent.click(screen.getByRole("button", { name: /A walk after class/ }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Biscuit says" }))
      .toHaveTextContent("Something you might be missing"));
    expect(screen.getByRole("region", { name: "Biscuit says" })).toHaveTextContent("walks");
  });

  it("skip turns the flag on so onboarding is never shown again", async () => {
    let stored: UserProfile = { ...emptyProfile };
    const saveProfile = vi.fn(async (_token: string, update: Parameters<typeof cloudServices.saveProfile>[1]) => {
      const { complete_onboarding: complete, ...rest } = update;
      stored = { ...stored, ...rest, onboarding_completed: stored.onboarding_completed || Boolean(complete) };
      return stored;
    });
    const fetchProfile = vi.fn(async () => stored);
    renderApp({ fetchProfile, saveProfile });
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveProfile).toHaveBeenCalledWith("token", {
      interests: [], music: [], mood_boosters: [], comfort_foods: [], music_note: "",
      complete_onboarding: true,
    });
    expect(stored.onboarding_completed).toBe(true);

    // A later edit from the Interests tab saves without touching the flag.
    fireEvent.click(screen.getByRole("button", { name: "Your interests" }));
    const save = await screen.findByRole("button", { name: /Save changes/ });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cooking & baking" }));
    fireEvent.click(save);
    expect(await screen.findByText(/Saved\./)).toBeVisible();
    expect(saveProfile).toHaveBeenLastCalledWith("token", {
      interests: ["cooking"], music: [], mood_boosters: [], comfort_foods: [], music_note: "",
    });
  });

  it("does not show onboarding to someone who already finished it", async () => {
    const fetchProfile = vi.fn().mockResolvedValue({ ...emptyProfile, onboarding_completed: true });
    renderApp({ fetchProfile, saveProfile: vi.fn() });
    await waitFor(() => expect(fetchProfile).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never blocks journaling when the profile service is unavailable or saving fails", async () => {
    const saveProfile = vi.fn().mockRejectedValue(new Error("Unable to save your interests (HTTP 503)."));
    renderApp({ fetchProfile: vi.fn().mockResolvedValue(emptyProfile), saveProfile });
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
    fireEvent.click(screen.getByRole("button", { name: "Continue without saving" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a retry on the Interests tab when profiles cannot load", async () => {
    const fetchProfile = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValueOnce({ ...emptyProfile, onboarding_completed: true, interests: ["reading"] });
    renderApp({ fetchProfile });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Your interests" }));
    fireEvent.click(await screen.findByRole("button", { name: /Try again/ }));
    expect(await screen.findByRole("button", { name: "Reading" })).toHaveAttribute("aria-pressed", "true");
  });

  it("limits selections per question", async () => {
    renderApp({ fetchProfile: vi.fn().mockResolvedValue(emptyProfile), saveProfile: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    const group = screen.getByRole("group", { name: "What helps" });
    const chips = within(group).getAllByRole("button");
    chips.slice(0, 5).forEach(chip => fireEvent.click(chip));
    expect(chips[5]).toBeDisabled();
    expect(screen.getByText(/5 of 5 selected/)).toBeVisible();
  });
});

describe("gentle suggestion", () => {
  it("labels each kind of recommendation", () => {
    const base = { sentiment: "positive" as const, emotions: [], themes: [], summary: "Sunny day." };
    const { rerender } = render(<ReflectionPanel reflection={{
      ...base, suggestion: "It is sunny out, maybe a lemonade?", suggestion_reason: "context_match",
    }} />);
    expect(screen.getByRole("complementary", { name: "A little idea for today" })).toHaveTextContent("lemonade");
    rerender(<ReflectionPanel reflection={{
      ...base, suggestion: "It has been a while since a bike ride.", suggestion_reason: "been_a_while",
    }} />);
    expect(screen.getByRole("complementary", { name: "Something you might be missing" })).toBeVisible();
  });

  it("appears only when the reflection carries one", () => {
    const base = { sentiment: "negative" as const, emotions: [], themes: [], summary: "A heavy day." };
    const { rerender } = render(<ReflectionPanel reflection={base} />);
    expect(screen.queryByText("A gentle thought")).not.toBeInTheDocument();
    rerender(<ReflectionPanel reflection={{ ...base, suggestion: "If it feels right, maybe a short walk." }} />);
    expect(screen.getByRole("complementary", { name: "A gentle thought" })).toHaveTextContent("short walk");
  });
});

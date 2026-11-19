import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CloudPreviewApp from "../src/cloud/CloudPreviewApp";
import { CloudIngestApp } from "../src/cloud/CloudIngestApp";
import { CloudEnvironmentContext, cloudServices } from "../src/cloud/CloudEnvironment";

describe("cloud interface preview", () => {
  it("uses the cloud upload and history screens with local data and no network requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<CloudPreviewApp onboarded />);
    expect(screen.getByRole("heading", { name: "A moment for you." })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /Journal title/ })).toBeVisible();
    expect(screen.queryByText("LOCAL MVP")).not.toBeInTheDocument();
    expect(screen.queryByText("YOUR NOTEBOOK")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    fireEvent.click(await screen.findByRole("button", { name: /A walk after class/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Read full transcript/ }));
    expect(screen.getByRole("region", { name: "Full transcript" })).toHaveTextContent("[DEMO TRANSCRIPT]");
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload a video" }));
    expect(screen.getByRole("heading", { name: "A moment for you." })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stacks same-day journals and opens each one from the day dialog", async () => {
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    const stack = await screen.findByRole("button", { name: /3 moments/ });
    expect(stack).toHaveTextContent("An ordinary day · A long afternoon · Morning pages");
    // Single-day journals keep their own inline card.
    expect(screen.getByRole("button", { name: /A walk after class/ })).not.toHaveAttribute("aria-haspopup");

    fireEvent.click(stack);
    const dialog = screen.getByRole("dialog");
    const tiles = within(dialog).getAllByRole("listitem");
    expect(tiles).toHaveLength(3);
    fireEvent.click(within(dialog).getByRole("button", { name: /Morning pages/ }));
    expect(await within(dialog).findByRole("heading", { name: "Morning pages" })).toBeVisible();
    expect(await within(dialog).findByRole("button", { name: /Read full transcript/ })).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: /All moments/ }));
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.keyDown(within(dialog).getByRole("list"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens settings and makes preview deletion explicitly local-only", async () => {
    render(<CloudPreviewApp onboarded />);
    const streakCard = await screen.findByRole("button", { name: /Upload to start your streak/ });
    expect(streakCard).toHaveTextContent("Start a streak");
    fireEvent.click(streakCard);
    const rewards = screen.getByRole("region", { name: "Streak rewards" });
    expect(rewards).toHaveTextContent("0 points");
    expect(within(rewards).getByRole("button", { name: "Buy streak freeze" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("region", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete your account?" });
    expect(dialog).toHaveTextContent(
      "only fictional preview data is cleared",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));
    expect(await screen.findByText(/Local preview data was cleared/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    expect(await screen.findByText(/No journals yet/)).toBeVisible();
  });

  it("requires typed confirmation and deletes the authenticated Cognito account", async () => {
    const deleteAccount = vi.fn().mockResolvedValue({ complete: true });
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    const onAccountDeleted = vi.fn().mockResolvedValue(undefined);
    const fetchStreak = vi.fn().mockResolvedValue({
      current_streak: 3,
      longest_streak: 5,
      points: 7,
      freezes: 0,
      freeze_cost: 7,
      uploaded_today: true,
      freeze_pending: false,
    });
    const buyStreakFreeze = vi.fn().mockResolvedValue({
      current_streak: 3,
      longest_streak: 5,
      points: 0,
      freezes: 1,
      freeze_cost: 7,
      uploaded_today: true,
      freeze_pending: false,
    });
    const services = { ...cloudServices, deleteAccount, fetchStreak, buyStreakFreeze };
    render(
      <CloudEnvironmentContext.Provider value={{
        userSub: "test-user",
        accessToken: "test-token",
        isPreview: false,
        services,
      }}>
        <CloudIngestApp
          accountEmail="journal@example.com"
          onSignOut={onSignOut}
          onAccountDeleted={onAccountDeleted}
        />
      </CloudEnvironmentContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Today's upload counted/ }));
    fireEvent.click(screen.getByRole("button", { name: "Buy streak freeze" }));
    await waitFor(() => expect(buyStreakFreeze).toHaveBeenCalledOnce());
    expect(await screen.findByText(/1 freeze owned/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete your account?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete account" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Type DELETE to confirm" }), {
      target: { value: "DELETE" },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith("test-token", "journal@example.com"));
    await waitFor(() => expect(onAccountDeleted).toHaveBeenCalledOnce());
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CloudPreviewApp from "../src/cloud/CloudPreviewApp";

describe("cloud interface preview", () => {
  it("uses the cloud upload and history screens with local data and no network requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<CloudPreviewApp />);
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
});

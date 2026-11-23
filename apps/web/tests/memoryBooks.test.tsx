import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CloudPreviewApp from "../src/cloud/CloudPreviewApp";
import memoryTemplates from "../../../infra/lambda/memory-book-templates.json";

afterEach(() => {
  localStorage.removeItem("reverie-memory-books-v1:local-cloud-preview");
  vi.restoreAllMocks();
});

describe("memory books", () => {
  it("keeps the source transcript intact and requires review before export", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Memory books" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous books and templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Create from an earlier template" }));

    const templatePicker = screen.getByRole("combobox", { name: "Memory book template" });
    expect(within(templatePicker).getAllByRole("option").map(option => option.textContent)).toEqual(memoryTemplates.templates.map(template => template.name));
    expect(memoryTemplates.templates.map(template => template.legacyTheme)).toEqual(expect.arrayContaining([
      "Minimalist", "Vintage", "Scrapbook", "Classic diary", "Editorial",
    ]));
    const designControls = screen.getByRole("group", { name: "Book design" });
    expect(designControls.querySelectorAll("input,select")).toHaveLength(3);

    const journal = await screen.findByRole("option", { name: /A walk after class/ }) as HTMLOptionElement;
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a journal memory" }), {
      target: { value: journal.value },
    });
    const narrative = await screen.findByRole("textbox", { name: "Approved memory text" });
    const original = (narrative as HTMLTextAreaElement).value;
    expect(original).toContain("[DEMO TRANSCRIPT]");
    const approval = screen.getByRole("checkbox", { name: "I reviewed this text" });
    fireEvent.click(approval);
    expect(approval).toBeChecked();
    const page = document.querySelector(".memory-preview .memory-page");
    expect(page).toBeTruthy();
    expect(page?.querySelectorAll(".is-reserved")).toHaveLength(3);
    expect(page).not.toHaveTextContent(/Add a photo|Leave blank/);
    fireEvent.click(page!.querySelector(".image-area")!);
    await waitFor(() => expect(document.querySelector('[data-fill-slot="image"]')).toHaveFocus());

    fireEvent.change(narrative, { target: { value: "My edited memory about walking home." } });
    expect(approval).not.toBeChecked();
    fireEvent.click(screen.getByText(/View original transcript and select an exact quote/));
    const transcript = screen.getByRole("textbox", { name: "Original source transcript" });
    expect(transcript).toHaveAttribute("readonly");
    expect(transcript).toHaveValue(original);

    fireEvent.click(screen.getByRole("button", { name: "Print preview" }));
    expect(screen.getByText("Review and approve every included memory before exporting.")).toBeVisible();
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(approval);
    fireEvent.click(screen.getByRole("button", { name: "Print preview" }));
    expect(print).toHaveBeenCalledOnce();
  });

  it("keeps Notebook stickers and its annotation through template switches and saves one copy", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Memory books" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous books and templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Create from an earlier template" }));
    const entryOption = await screen.findByRole("option", { name: /A walk after class/ }) as HTMLOptionElement;
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a journal memory" }), { target: { value: entryOption.value } });
    const approval = await screen.findByRole("checkbox", { name: "I reviewed this text" });
    fireEvent.click(approval);

    const template = screen.getByRole("combobox", { name: "Memory book template" });
    fireEvent.change(template, { target: { value: "notebook-v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sunrise" }));
    expect(screen.getByRole("button", { name: "Sunrise" })).toHaveAttribute("aria-pressed", "true");
    const annotation = screen.getByRole("textbox", { name: "Personal annotation" });
    fireEvent.change(annotation, { target: { value: "Keep this small note." } });

    fireEvent.change(template, { target: { value: "daily-notes-v1" } });
    fireEvent.change(template, { target: { value: "notebook-v1" } });
    expect(screen.getByText("Entry order")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Move chapter earlier" })).not.toBeInTheDocument();
    const page = document.querySelector(".memory-preview .template-notebook-v1.memory-page");
    expect(page).toBeTruthy();
    expect(within(page as HTMLElement).getAllByText("Keep this small note.")).toHaveLength(1);
    expect(page?.querySelector(".notebook-sticker[aria-label='sunrise'] svg")).toBeTruthy();
    expect(document.querySelectorAll(".memory-preview .memory-chapter-page")).toHaveLength(0);
    expect(document.querySelectorAll(".memory-preview-nav a[href^='#chapter-']")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Print preview" }));
    expect(print).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save book" }));
    const saved = JSON.parse(localStorage.getItem("reverie-memory-books-v1:local-cloud-preview") || "[]");
    const notebook = saved.find((item: { templateId: string }) => item.templateId === "notebook-v1");
    expect(notebook.entries[0].stickers).toEqual(["sunrise"]);
    expect(notebook.entries[0].annotation).toBe("Keep this small note.");
    expect(notebook.entries[0].approved).toBe(true);
  });

  it("requires confirmation before discarding only a local book draft", async () => {
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Memory books" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous books and templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Create from an earlier template" }));
    expect(JSON.parse(localStorage.getItem("reverie-memory-books-v1:local-cloud-preview") || "[]")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete book" }));
    const dialog = screen.getByRole("alertdialog", { name: /Delete "A book of my moments"\?/ });
    expect(within(dialog).getByText("This discards the local book draft.")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("reverie-memory-books-v1:local-cloud-preview") || "[]")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete book" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete book" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("reverie-memory-books-v1:local-cloud-preview") || "[]")).toHaveLength(0));
    expect(screen.getByText("Local book discarded.")).toBeVisible();
  });
});

describe("quick journal PDF export", () => {
  it("opens from history with five templates and shows the download when preparation finishes", async () => {
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));

    const dialog = within(screen.getByRole("dialog", { name: "Export your journals" }));
    expect(dialog.getByLabelText("Start date")).not.toHaveValue("");
    expect(dialog.getByLabelText("End date")).not.toHaveValue("");
    expect(dialog.getByRole("combobox", { name: "Template" })).toHaveValue("Minimalist");
    expect(dialog.getAllByRole("option").map(option => option.textContent)).toEqual([
      "Minimalist", "Vintage", "Scrapbook", "Classic diary", "Editorial",
    ]);
    fireEvent.change(dialog.getByRole("combobox", { name: "Template" }), { target: { value: "Vintage" } });
    fireEvent.click(dialog.getByRole("button", { name: "Export PDF" }));

    expect(await dialog.findByRole("link", { name: "Download PDF" })).toBeVisible();
  });
});

describe("journal pages", () => {
  async function openWalkDay() {
    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    fireEvent.click(await screen.findByRole("button", { name: /A walk after class/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit day" }));
    return await screen.findByRole("article", { name: "Journal page design canvas" });
  }

  it("opens a video's daily page and keeps its original transcript locked", async () => {
    render(<CloudPreviewApp onboarded />);
    const canvas = await openWalkDay();

    expect(within(canvas).getByRole("group", { name: "Original transcript box 1" })).toBeVisible();
    expect(within(canvas).getByText("Transcript locked")).toBeVisible();
    expect(within(canvas).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/1 recording combined/)).toBeVisible();

    fireEvent.click(screen.getByText("View original transcript"));
    expect(document.querySelector(".journal-source pre")).toHaveTextContent("[DEMO TRANSCRIPT]");
    expect(document.querySelector(".journal-source pre")).toHaveTextContent("I took a walk after class");
  });

  it("adds and rearranges personal text, saves a daily revision and reopens it", async () => {
    render(<CloudPreviewApp onboarded />);
    const canvas = await openWalkDay();

    fireEvent.click(within(canvas).getByRole("button", { name: "+ Add text" }));
    const note = within(canvas).getByRole("textbox", { name: "Added text 2" }) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "A small thought to remember." } });
    fireEvent.focus(note);
    fireEvent.click(within(canvas).getByRole("button", { name: "More options" }));
    fireEvent.change(within(canvas).getByRole("slider", { name: "Text box width" }), { target: { value: "60" } });
    fireEvent.change(within(canvas).getByRole("combobox", { name: "Paragraph style" }), { target: { value: "note" } });
    fireEvent.click(within(canvas).getByRole("button", { name: "Move earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));

    expect(await screen.findByText("Page saved.")).toBeVisible();
    expect(screen.getByText(/REVISION 1/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "← Journal history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit day" }));
    const reopened = await screen.findByRole("article", { name: "Journal page design canvas" });
    const savedNote = within(reopened).getByRole("textbox", { name: /Added text/ }) as HTMLTextAreaElement;
    expect(savedNote).toHaveValue("A small thought to remember.");
    expect(savedNote.closest(".journal-design-block")).toHaveClass("is-note");
    expect(savedNote.closest(".journal-design-block")).toHaveStyle({ width: "60%" });
    expect(within(reopened).getByText("Transcript locked")).toBeVisible();
  });

  it("creates a date-range collection, excludes a day, previews and requests a PDF", async () => {
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Memory books" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a book" }));
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-24" } });
    fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-26" } });
    const applyRange = screen.getByRole("button", { name: "Apply range" });
    // Creating a book first loads the current month's days asynchronously.
    // Wait for that request to finish before applying the custom range.
    await waitFor(() => expect(applyRange).toBeEnabled());
    fireEvent.click(applyRange);

    await waitFor(() => expect(screen.getByText(/3 of 3 days included/)).toBeVisible());
    fireEvent.click(screen.getByText("Choose days"));
    fireEvent.click(screen.getByText("October 2026"));
    const included = screen.getByRole("checkbox", { name: "Include October 25, 2026" });
    expect(included).toBeChecked();
    fireEvent.click(included);
    await waitFor(() => expect(screen.getByText(/2 of 3 days included/)).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: "Save collection" }));
    expect(await screen.findByText("Collection saved.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("region", { name: "Daily page preview" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate PDF" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate PDF" }));
    expect(await screen.findByText("Collection saved. The local preview does not generate a PDF.")).toBeVisible();
    expect(screen.getByText("PDF status: preview-only")).toBeVisible();
  });
});

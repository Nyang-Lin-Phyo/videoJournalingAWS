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
  it("uploads UTF-8 text and opens its editable page directly", async () => {
    render(<CloudPreviewApp onboarded />);
    fireEvent.change(screen.getByLabelText("Choose .txt file"), {
      target: { files: [new File(["First paragraph.\n\nSecond paragraph."], "notes.txt", { type: "text/plain" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save and arrange page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit page" }));
    expect(await screen.findByRole("textbox", { name: "Paragraph 1" })).toHaveValue("First paragraph.");
    expect(screen.getByRole("textbox", { name: "Paragraph 2" })).toHaveValue("Second paragraph.");
    fireEvent.click(screen.getByText("View original source"));
    expect(document.querySelector(".journal-source pre")).toHaveTextContent("First paragraph. Second paragraph.");
  });

  it("opens a source page, marks a sentence, resizes and reorders paragraphs, then saves a revision", async () => {
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Journal history" }));
    fireEvent.click(await screen.findByText("A walk after class"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit page" }));

    await screen.findByRole("textbox", { name: "Paragraph 1" });
    fireEvent.click(screen.getByRole("button", { name: "+ Add paragraph" }));
    const paragraphs = screen.getAllByRole("textbox", { name: /^Paragraph / });
    expect(paragraphs).toHaveLength(2);
    const first = paragraphs[0] as HTMLTextAreaElement;
    first.focus();
    first.setSelectionRange(0, Math.min(8, first.value.length));
    fireEvent.select(first);
    fireEvent.click(within(first.closest(".journal-page-block") as HTMLElement).getByRole("button", { name: "Mark selected sentence" }));
    expect(screen.getByText("Highlighted:").parentElement).toHaveTextContent(first.value.slice(0, 8));
    fireEvent.change(screen.getAllByRole("combobox", { name: "Paragraph width" })[0]!, { target: { value: "half" } });
    fireEvent.click(screen.getByRole("button", { name: "Move paragraph 2 up" }));
    fireEvent.change(screen.getByLabelText("Add a private photo"), { target: { files: [new File(["image"], "memory.png", { type: "image/png" })] } });
    expect(await screen.findByAltText("Private journal photo")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Highlight photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(await screen.findByText("Page saved.")).toBeVisible();
    expect(screen.getByText(/REVISION 1/)).toBeVisible();
  });

  it("saves an ordered page collection before confirming a preview export", async () => {
    render(<CloudPreviewApp onboarded />);
    fireEvent.click(screen.getByRole("button", { name: "Memory books" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a book" }));
    const pageOption = await screen.findByRole("option", { name: /A walk after class/ }) as HTMLOptionElement;
    fireEvent.change(screen.getByRole("combobox", { name: "Add a saved page" }), { target: { value: pageOption.value } });
    expect(await screen.findByText("A walk after class")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save collection" }));
    expect(await screen.findByText("Collection saved.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Generate PDF" }));
    expect(await screen.findByText("Collection saved. The local preview does not generate a PDF.")).toBeVisible();
    expect(screen.getByText("PDF status: preview-only")).toBeVisible();
  });
});

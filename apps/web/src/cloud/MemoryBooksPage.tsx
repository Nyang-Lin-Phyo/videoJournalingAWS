import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useCloudEnvironment } from "./CloudEnvironment";
import type { AnalysisResult, JournalSummary, MemoryBookRecord, MemoryPhoto } from "./analysisApi";
import templateCatalog from "../../../../infra/lambda/memory-book-templates.json";
import { JournalPageBooks } from "./JournalPageBooks";

type Entry = { id: string; title: string; date: string; text: string; original_text: string; candidate?: string; quotes: string[]; quoteModes?: Record<string, string>; narrativeRevision: number; metadataRevision: number; sourceAvailable: boolean; areas?: Record<string, import("./analysisApi").MemoryArea>; photoId?: string; photoIds?: string[]; caption?: string; annotation?: string; stickers?: string[]; personalStickerPhotoId?: string; focal?: { x: number; y: number }; layout?: string; quoteDisplay?: string; approved: boolean; favorite: boolean; meaningful: boolean; included: boolean };
type Book = MemoryBookRecord;
const textures = ["Plain", "Linen", "Parchment", "Recycled paper"];
const paperColors = [{ label: "White", value: "#fffefa" }, { label: "Ivory", value: "#f7f3ea" }, { label: "Oat", value: "#f4e8cf" }, { label: "Pale gray", value: "#f2f1ed" }];
type BookTemplate = (typeof templateCatalog.templates)[number];
const templates = templateCatalog.templates as BookTemplate[];
const notebookStickerPaths: Record<string, string> = {
  sunrise: "M5 22h22M9 20a7 7 0 0 1 14 0M16 4v4m-9 0 3 3m15-3-3 3",
  leaf: "M26 5C14 5 7 10 7 19c0 5 4 8 8 8 8 0 11-10 11-22ZM7 27l13-14",
  spark: "M16 3l3 9 9 4-9 3-3 10-3-10-9-3 9-4 3-9Z",
  heart: "M16 27 5 16C-1 7 10 2 16 10c6-8 17-3 11 6L16 27Z",
  flower: "M16 15c-9-10-15 2-1 3-13 3-6 14 2 2 0 15 13 11 3-1 14 4 16-9 1-5 7-12-5-16-5-1ZM16 18v11",
};
const notebookStickerIds = (templates.find(item => item.id === "notebook-v1")?.stickers ?? Object.keys(notebookStickerPaths)) as string[];
function templateFor(book: Book): BookTemplate {
  return templates.find(item => item.id === book.templateId) ?? templates.find(item => item.legacyTheme === book.theme) ?? templates[0]!;
}
function blankAreasFor(book: Book) {
  return Object.fromEntries(templateFor(book).slots.filter(slot => slot.kind === "image-or-text" || slot.kind === "writing").map(slot => [slot.id, { mode: "blank" as const }]));
}
const KEY = "reverie-memory-books-v1";
function chapterMonth(date: string, zone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", year: "numeric", month: "2-digit" }).formatToParts(new Date(date)); }
  catch { parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit" }).formatToParts(new Date(date)); }
  const year = parts.find(part => part.type === "year")?.value ?? "";
  const month = parts.find(part => part.type === "month")?.value ?? "";
  return `${year}-${month}`;
}
function localDateKey(date: string, zone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(date)); }
  catch { parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(date)); }
  const get = (name: string) => parts.find(part => part.type === name)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function highlightExactQuotes(text: string, quotes: string[]) {
  const matches = [...new Set(quotes.filter(quote => quote && text.includes(quote)))].sort((a, b) => b.length - a.length);
  if (!matches.length) return text;
  const pattern = new RegExp(`(${matches.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  const exact = new Set(matches);
  return text.split(pattern).map((part, index) => exact.has(part) ? <mark key={index}>{part}</mark> : part);
}
function templatePageSlots(entry: Entry, template: BookTemplate, book: Book, photoUrl: (id?: string) => string | undefined, onActivate: (slotId: string) => void) {
  return template.slots.map(slot => {
    const activate = { role: "button" as const, tabIndex: 0, "aria-label": `Edit ${slot.id.replaceAll("-", " ")} area for ${entry.title}`, onClick: () => onActivate(slot.id), onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(slot.id); } } };
    const area = entry.areas?.[slot.id];
    const slotHeight = Number("heightMm" in slot ? slot.heightMm : undefined) || 40;
    const quoteHeight = Number("minHeightMm" in slot ? slot.minHeightMm : undefined) || 22;
    const guideValue = "guide" in slot ? slot.guide : undefined;
    const treatmentValue = "imageTreatment" in slot ? slot.imageTreatment : undefined;
    const guide = typeof guideValue === "string" && ["ruled", "dot", "open"].includes(guideValue) ? guideValue : "open";
    const treatment = typeof treatmentValue === "string" && ["frame", "mount", "open"].includes(treatmentValue) ? treatmentValue : "open";
    if (slot.kind === "date") return <p key={slot.id} {...activate} className="template-area date-area">{localDateKey(entry.date, book.timezone ?? "UTC")}</p>;
    if (slot.kind === "title") return <h2 key={slot.id} {...activate} className="template-area title-area">{entry.title}</h2>;
    if (slot.kind === "annotation") return entry.annotation?.trim() ? <aside key={slot.id} className="template-area annotation notebook-annotation">{entry.annotation}</aside> : null;
    if (slot.kind === "stickers") return <div key={slot.id} className="template-area notebook-stickers">{(entry.stickers ?? []).filter(id => notebookStickerPaths[id]).map(id => <span key={id} aria-label={id} className={`notebook-sticker sticker-${id}`}><svg viewBox="0 0 32 32" aria-hidden="true"><path d={notebookStickerPaths[id]}/></svg></span>)}{entry.personalStickerPhotoId && photoUrl(entry.personalStickerPhotoId) && <img className="personal-sticker" src={photoUrl(entry.personalStickerPhotoId)} alt="Personal sticker"/>}</div>;
    if (slot.kind === "narrative") return <div key={slot.id} {...activate} className="template-area story-area">{entry.text.split(/\n\s*\n/).filter(Boolean).map((paragraph, i) => <p key={i}>{highlightExactQuotes(paragraph, (entry.quotes ?? []).filter(quote => !["exclude", "standalone"].includes(entry.quoteModes?.[quote] ?? entry.quoteDisplay ?? "both")))}</p>)}</div>;
    if (slot.kind === "quote") {
      const visible = (entry.quotes ?? []).filter(quote => !["exclude", "inline"].includes(entry.quoteModes?.[quote] ?? entry.quoteDisplay ?? "both"));
      return <div key={slot.id} {...activate} style={{ minHeight: `${quoteHeight}mm` }} className={`template-area quote-area guide-${guide} ${visible.length ? "" : "is-reserved"}`}>{visible.length ? visible.map((quote, i) => <blockquote key={i}>“{quote}”</blockquote>) : <span aria-hidden="true"/>}</div>;
    }
    if (slot.kind === "image-or-text") {
      const isLegacy = !entry.areas || !(slot.id in entry.areas);
      const photoIds = area?.mode === "image" ? [area.photoId].filter((id): id is string => Boolean(id)) : (isLegacy ? entry.photoIds ?? (entry.photoId ? [entry.photoId] : []) : []);
      if (area?.mode === "text" && area.text) return <div key={slot.id} {...activate} style={{ minHeight: `${slotHeight}mm` }} className={`template-area image-area image-${treatment} area-text`}>{area.text}</div>;
      const imageRows = photoIds.length > 1 ? Math.ceil(photoIds.length / 2) : 1;
      const imageHeight = Math.max(8, slotHeight / imageRows - 8);
      if (photoIds.length) return <div key={slot.id} {...activate} style={{ height: `${slotHeight}mm` }} className={`template-area image-area image-${treatment}`}>{photoIds.map(id => photoUrl(id) && <figure key={id}><img style={{ height: `${imageHeight}mm`, maxHeight: `${imageHeight}mm`, width: photoIds.length > 1 ? "48%" : "100%", objectFit: "contain" }} src={photoUrl(id)} alt={entry.caption || entry.title}/>{entry.caption && <figcaption>{entry.caption}</figcaption>}</figure>)}</div>;
      return <div key={slot.id} {...activate} style={{ height: `${slotHeight}mm` }} className={`template-area image-area image-${treatment} is-reserved`} aria-label={`Reserved ${slot.id} area`}><span aria-hidden="true"/></div>;
    }
    if (slot.kind === "writing") {
      const isLegacy = !entry.areas || !(slot.id in entry.areas);
      const text = area?.mode === "text" ? area.text : isLegacy && template.id !== "notebook-v1" ? entry.annotation : "";
      if (text && template.id === "notebook-v1") return <Fragment key={slot.id}><div {...activate} className="template-area writing-area area-text notebook-user-writing">{text}</div><div {...activate} className="template-area writing-area guide-ruled is-reserved notebook-remaining-space" aria-label={`Remaining personal writing space for ${entry.title}`}><span aria-hidden="true"/></div></Fragment>;
      return <div key={slot.id} {...activate} style={text ? { minHeight: `${slotHeight}mm` } : { height: `${slotHeight}mm` }} className={`template-area writing-area guide-${guide} ${text ? "area-text" : "is-reserved"}`}>{text || <span aria-hidden="true"/>}</div>;
    }
    const text = area?.mode === "text" ? area.text : "";
    return <div key={slot.id} {...activate} className={`template-area generic-area ${text ? "area-text" : "is-reserved"}`}>{text || <span aria-hidden="true"/>}</div>;
  });
}

export function MemoryBooksPage() {
  const [legacy, setLegacy] = useState(false);
  return legacy ? <LegacyMemoryBooksPage onPageMode={() => setLegacy(false)} /> : <JournalPageBooks onLegacy={() => setLegacy(true)} />;
}

function LegacyMemoryBooksPage({ onPageMode }: { onPageMode: () => void }) {
  const { userSub, accessToken, services, isPreview } = useCloudEnvironment();
  const storageKey = `${KEY}:${userSub || "preview"}`;
  const [journals, setJournals] = useState<JournalSummary[]>([]);
  const [journalFlags, setJournalFlags] = useState<Map<string, { favorite: boolean; meaningful: boolean }>>(new Map());
  const [pickerFilter, setPickerFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [book, setBook] = useState<Book | null>(null);
  const latestBookRef = useRef<Book | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const [exportRevision, setExportRevision] = useState<number | null>(null);
  const [exportBookId, setExportBookId] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [photos, setPhotos] = useState<MemoryPhoto[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [frameTime, setFrameTime] = useState(0);
  const [quoteSuggestions, setQuoteSuggestions] = useState<string[]>([]);
  const [reflectionPeriod, setReflectionPeriod] = useState<"month" | "year">("month");
  const [reflectionKey, setReflectionKey] = useState("");
  const [generatingReflection, setGeneratingReflection] = useState(false);
  const [writingPreferences, setWritingPreferences] = useState({ style: "reflective", amount: "light", revision: 0 });
  const [notebookContinuations, setNotebookContinuations] = useState<string[]>([]);
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { latestBookRef.current = book; }, [book]);
  useEffect(() => {
    if (!deleteConfirmationOpen) return;
    deleteCancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setDeleteConfirmationOpen(false); setDeleteTarget(null); setDeleteError(""); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteConfirmationOpen, busy]);
  useEffect(() => {
    if (!book || templateFor(book).id !== "notebook-v1") { setNotebookContinuations([]); return; }
    const frame = window.requestAnimationFrame(() => {
      const next = Array.from(document.querySelectorAll<HTMLElement>(".memory-preview .template-notebook-v1.memory-page"))
        .filter(page => page.getBoundingClientRect().height > page.getBoundingClientRect().width * 297 / 210 + 1)
        .map(page => page.id.replace(/^memory-/, ""));
      setNotebookContinuations(previous => previous.join("|") === next.join("|") ? previous : next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [book]);

  useEffect(() => {
    let alive = true;
    if (isPreview) {
      try { const saved = JSON.parse(localStorage.getItem(storageKey) || "[]") as Book[]; setBooks(saved.filter(book => book.contentMode !== "journal-pages")); }
      catch { setBooks([]); }
    } else {
      services.fetchMemoryBooks(accessToken).then(saved => alive && setBooks(saved.filter(book => book.contentMode !== "journal-pages"))).catch(e => alive && setError(e instanceof Error ? e.message : "Unable to load your books."));
    }
    return () => { alive = false; };
  }, [storageKey, isPreview, services, accessToken]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    services.fetchJournals(accessToken).then(async page => {
      const all = [...page.journals]; let next = page.next_token;
      for (let i = 0; next && i < 40; i++) { const more = await services.fetchJournals(accessToken, undefined, next); all.push(...more.journals); next = more.next_token; }
      if (alive) {
        const completed = all.filter(item => item.status === "completed");
        setJournals(completed);
        const memories = await services.fetchMemoryNarratives(accessToken, completed.map(item => ({ id: item.upload_id })));
        if (alive) setJournalFlags(new Map([...memories].map(([id, value]) => [id, { favorite: value.favorite, meaningful: value.meaningful }])));
      }
    }).catch(e => alive && setError(e instanceof Error ? e.message : "Unable to load your journal memories.")).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [accessToken, services]);
  useEffect(() => {
    if (isPreview) return;
    services.fetchMemoryPhotos(accessToken).then(setPhotos).catch(e => setNotice(e instanceof Error ? e.message : "Unable to load photos."));
  }, [accessToken, services, isPreview]);
  useEffect(() => {
    services.fetchMemoryPreferences(accessToken).then(setWritingPreferences).catch(e => setNotice(e instanceof Error ? e.message : "Unable to load writing preferences."));
  }, [accessToken, services]);

  function persist(next: Book[]) { setBooks(next); if (isPreview) localStorage.setItem(storageKey, JSON.stringify(next)); }
  function updateBookById(id: string, update: (current: Book) => Book) {
    setBooks(previous => {
      const next = previous.map(item => item.id === id ? update(item) : item);
      if (isPreview) localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
    setBook(previous => previous?.id === id ? update(previous) : previous);
  }
  function change(update: (current: Book) => Book) {
    if (!book) return;
    updateBookById(book.id, update);
  }
  function focusMemoryArea(entryId: string, slotId: string) {
    setSelected(entryId);
    const focusField = () => {
      const field = Array.from(document.querySelectorAll<HTMLElement>("[data-fill-slot]"))
        .find(element => element.dataset.fillSlot === slotId);
      field?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      field?.focus();
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(focusField);
    else window.setTimeout(focusField, 0);
  }
  function newBook() {
    const next: Book = { id: crypto.randomUUID(), title: "A book of my moments", subtitle: "", templateId: templates[0]!.id, theme: templates[0]!.legacyTheme, texture: "Linen", fontSize: 17, headingSize: 22, coverBackground: "#fffefa", coverFont: "serif", bodyFont: "serif", textColor: "#43332e", pageColor: "#fffefa", marginMm: 18, lineSpacing: 17, headingFont: "serif", pageBorder: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", chapterTitles: {}, chapterOrder: [], dateStart: "", dateEnd: "", yearSectionEnabled: false, yearSectionText: "", rewriteStyle: writingPreferences.style, rewriteAmount: writingPreferences.amount, revision: 0, entries: [] };
    persist([next, ...books]); setBook(next); setNotice("New book created.");
  }
  async function addJournal(journal: JournalSummary) {
    if (!book || book.entries.some(item => item.id === journal.upload_id)) return;
    const targetBookId = book.id;
    setBusy(true); setNotice("");
    try {
      const [detail, memoryMap]: [AnalysisResult, Map<string, import("./analysisApi").MemoryNarrative>] = await Promise.all([
        services.fetchAnalysis(journal.upload_id, accessToken), services.fetchMemoryNarratives(accessToken, [{ id: journal.upload_id }]),
      ]);
      if (!detail.transcript) throw new Error("This journal has no available transcript yet.");
      const saved = memoryMap.get(journal.upload_id);
      const entry: Entry = { id: journal.upload_id, title: journal.title, date: journal.created_at, text: saved?.text ?? detail.transcript, original_text: detail.transcript, candidate: saved?.candidate, quotes: saved?.quotes ?? [], areas: blankAreasFor(book), quoteDisplay: "both", narrativeRevision: saved?.narrativeRevision ?? 0, metadataRevision: saved?.metadataRevision ?? 0, sourceAvailable: true, approved: false, favorite: saved?.favorite ?? false, meaningful: saved?.meaningful ?? false, included: true };
      const entries = [...book.entries, entry].sort((a,b) => a.date.localeCompare(b.date));
      const snapshot = { ...book, entries };
      updateBookById(targetBookId, current => ({ ...current, entries: current.entries.some(item => item.id === entry.id) ? current.entries : [...current.entries, entry].sort((a,b) => a.date.localeCompare(b.date)) })); setSelected(entry.id);
      const hasReusableRewrite = Boolean(saved?.narrativeRevision && saved.text && saved.text !== detail.transcript);
      const rewriteStyle = book.rewriteStyle ?? writingPreferences.style;
      const rewriteAmount = book.rewriteAmount ?? writingPreferences.amount;
      if (!isPreview && !hasReusableRewrite && rewriteAmount !== "original") {
        try {
          const persisted = await persistSnapshot(snapshot);
          const draft = await services.rewriteMemory(accessToken, targetBookId, entry.id, rewriteStyle, rewriteAmount);
          const latest = latestBookRef.current;
          const latestEntry = latest?.id === targetBookId ? latest.entries.find(item => item.id === entry.id) : undefined;
          const useDraft = Boolean(latestEntry && latestEntry.text === entry.text && !latestEntry.approved);
          updateBookById(targetBookId, value => ({ ...value, revision: persisted.revision, entries: value.entries.map(item => item.id === entry.id ? { ...item, text: useDraft ? draft.candidate : item.text, candidate: draft.candidate, approved: useDraft ? false : item.approved } : item) }));
          let draftSaved = true;
          if (useDraft && latest) {
            const draftSnapshot = { ...latest, revision: persisted.revision, entries: latest.entries.map(item => item.id === entry.id ? { ...item, text: draft.candidate, candidate: draft.candidate, approved: false } : item) };
            try { await persistSnapshot(draftSnapshot); } catch { draftSaved = false; }
          }
          if (useDraft) setNotice(draftSaved ? "AI draft is ready. Review the text and approve it before export." : "AI draft is ready. Review it, then save the book to keep this draft.");
          else setNotice("AI draft is ready to review. Your text remains unchanged; choose Use this draft if you want it.");
        } catch {
          setNotice("Memory added with its original transcript. AI rewrite could not finish; select Generate draft to retry.");
        }
      }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to add this memory."); }
    finally { setBusy(false); }
  }
  const current = book?.entries.find(item => item.id === selected) ?? null;
  const editableSlots = book ? templateFor(book).slots.filter(slot => slot.kind === "image-or-text" || slot.kind === "writing") : [];
  const currentPosition = book && selected ? book.entries.findIndex(entry => entry.id === selected) : -1;
  const currentChapter = current && book ? chapterMonth(current.date, book.timezone ?? "UTC") : "";
  const visibleEntries = useMemo(() => book?.entries.filter(item => filter === "all" || (filter === "favorites" ? item.favorite : item.meaningful)) ?? [], [book, filter]);
  const photoUrl = (id?: string) => photos.find(photo => photo.photo_id === id && photo.status === "complete")?.url;
  function duplicate() { if (!book) return; const copy = { ...book, id: crypto.randomUUID(), revision: 0, title: `${book.title.slice(0, 113)} (copy)`, entries: book.entries.map(entry => ({ ...entry })) }; persist([copy, ...books]); setBook(copy); }
  async function deleteCurrentBook() {
    if (!deleteTarget || busy) return;
    const targetBook = deleteTarget;
    const targetId = targetBook.id;
    setBusy(true); setDeleteError("");
    try {
      if (!isPreview && targetBook.revision > 0) await services.deleteMemoryBook(accessToken, targetId);
      const remaining = books.filter(item => item.id !== targetId);
      persist(remaining);
      const nextBook = remaining[0] ?? null;
      setBook(nextBook); setSelected(nextBook?.entries[0]?.id ?? null);
      setExportRevision(null); setExportBookId(null); setExportUrl(""); setExportStatus("");
      setDeleteConfirmationOpen(false); setDeleteTarget(null); setNotice(isPreview || targetBook.revision === 0 ? "Local book discarded." : "Book and its generated PDFs deleted.");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Unable to delete this book. You can retry.");
    } finally { setBusy(false); }
  }
  function moveMemory(direction: -1 | 1) {
    if (!book || currentPosition < 0) return;
    const target = currentPosition + direction;
    if (target < 0 || target >= book.entries.length) return;
    change(value => { const entries = [...value.entries]; [entries[currentPosition], entries[target]] = [entries[target]!, entries[currentPosition]!]; return { ...value, entries }; });
  }
  function moveChapter(direction: -1 | 1) {
    if (!book || !currentChapter) return;
    const chronological = [...new Set(includedEntries.map(entry => chapterMonth(entry.date, book.timezone ?? "UTC")))].sort();
    const ordered = [...(book.chapterOrder ?? []).filter(key => chronological.includes(key)), ...chronological.filter(key => !(book.chapterOrder ?? []).includes(key))];
    const from = ordered.indexOf(currentChapter); const to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
    change(value => ({ ...value, chapterOrder: ordered }));
  }
  async function exportBook() {
    if (!book) return;
    if (includedEntries.some(entry => !entry.approved)) { setNotice("Review and approve every included memory before exporting."); return; }
    if ((book.reflections ?? []).some(reflection => reflection.included && !reflection.approved)) { setNotice("Review and approve every included reflection before exporting."); return; }
    setBusy(true); setNotice("");
    try {
      if (isPreview) { window.print(); setNotice("Preview print dialog opened. Real accounts use the private PDF export service."); return; }
      const saved = await persistSnapshot(book);
      const job = await services.startMemoryExport(accessToken, saved.id);
      setExportRevision(job.revision); setExportBookId(job.book_id); setExportUrl(""); setExportStatus(job.status);
      setNotice(`PDF export ${job.status}. Check status to get your private download link when it is ready.`);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to start PDF export."); }
    finally { setBusy(false); }
  }
  async function persistSnapshot(snapshot: Book): Promise<Book> {
    const saved = await services.saveMemoryBook(accessToken, snapshot);
    const merge = (local: Book): Book => ({ ...local, revision: saved.revision, entries: local.entries.map(entry => {
      const persisted = saved.entries.find(value => value.id === entry.id);
      return persisted ? { ...entry, narrativeRevision: persisted.narrativeRevision, metadataRevision: persisted.metadataRevision } : entry;
    }) });
    setBooks(items => {
      const next = items.map(item => item.id === snapshot.id ? merge(item) : item);
      if (isPreview) localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
    setBook(active => active?.id === snapshot.id ? merge(active) : active);
    return merge(snapshot);
  }
  async function saveBook() {
    if (!book) return;
    setBusy(true); setNotice("");
    try { await persistSnapshot(book); setNotice("Book saved. Narrative text is stored separately as reusable revisions."); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Unable to save this book."); }
    finally { setBusy(false); }
  }
  async function saveWritingPreferences(style = writingPreferences.style, amount = writingPreferences.amount) {
    try {
      const saved = await services.saveMemoryPreferences(accessToken, { ...writingPreferences, style, amount });
      setWritingPreferences(saved); setNotice("Default writing style and rewrite amount saved for future books.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to save writing preferences."); }
  }
  async function reloadBooks() {
    try {
      const loaded = await services.fetchMemoryBooks(accessToken);
      const previousBooks = loaded.filter(item => item.contentMode !== "journal-pages");
      setBooks(previousBooks);
      const reloaded = previousBooks.find(item => item.id === book?.id) ?? null;
      setBook(reloaded); setSelected(reloaded?.entries[0]?.id ?? null); setNotice("Reloaded the latest saved book and memory revisions.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to reload books."); }
  }
  async function checkExport() {
    if (!exportBookId || exportRevision === null) return;
    try {
      const result = await services.fetchMemoryExport(accessToken, exportBookId, exportRevision);
      setExportStatus(result.status);
      if (result.download_url) { setExportUrl(result.download_url); setNotice("Your private PDF download is ready."); }
      else setNotice(`PDF export status: ${result.status}. ${result.status === "failed" ? "Retry this export." : "Check again in a moment."}`);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to check PDF export."); }
  }
  async function retryExport() {
    if (!exportBookId || exportRevision === null) return;
    try { const result = await services.retryMemoryExport(accessToken, exportBookId, exportRevision); setExportStatus(result.status); setExportUrl(""); setNotice(`PDF export retry status: ${result.status}.`); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Unable to retry PDF export."); }
  }
  async function generateRewrite() {
    if (!book || !current) return;
    const targetBookId = book.id; const targetEntryId = current.id;
    setRewriting(true); setNotice("");
    try {
      const persistedBook = !isPreview && book.revision === 0 ? await persistSnapshot(book) : book;
      const result = await services.rewriteMemory(accessToken, targetBookId, current.id, book.rewriteStyle ?? "reflective", book.rewriteAmount ?? "light");
      updateBookById(targetBookId, b => ({ ...b, revision: persistedBook.revision, entries: b.entries.map(entry => { const savedEntry = persistedBook.entries.find(value => value.id === entry.id); return entry.id === targetEntryId ? { ...entry, text: result.candidate, candidate: result.candidate, approved: false, narrativeRevision: savedEntry?.narrativeRevision ?? entry.narrativeRevision, metadataRevision: savedEntry?.metadataRevision ?? entry.metadataRevision } : entry; }) }));
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to generate a rewrite."); }
    finally { setRewriting(false); }
  }
  async function generateReflection(period = reflectionPeriod, key = reflectionKey) {
    if (!book || !key) return;
    const targetBookId = book.id;
    setGeneratingReflection(true); setNotice("");
    try {
      const sourceIds = includedEntries.filter(entry => {
        const local = localDateKey(entry.date, book.timezone ?? "UTC");
        return (period === "month" ? chapterMonth(entry.date, book.timezone ?? "UTC") === key : local.slice(0, 4) === key) &&
          (!book.dateStart || local >= book.dateStart) && (!book.dateEnd || local <= book.dateEnd);
      }).map(entry => entry.id);
      if (!isPreview) await persistSnapshot(book);
      const generated = await services.generateMemoryReflection(accessToken, targetBookId, period, key, sourceIds, book.timezone ?? "UTC", book.dateStart ?? "", book.dateEnd ?? "");
      updateBookById(targetBookId, currentBook => ({ ...currentBook, reflections: [...(currentBook.reflections ?? []).filter(item => !(item.period === generated.period && item.key === generated.key)), generated] }));
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to generate a reflection."); }
    finally { setGeneratingReflection(false); }
  }
  async function addPhoto(file: File | Blob, requestedSlotId?: string, asSticker = false) {
    if (!book || !current || isPreview) return;
    const targetBookId = book.id; const targetEntryId = current.id;
    const imageSlotId = requestedSlotId ?? templateFor(book).slots.find(slot => slot.kind === "image-or-text")?.id ?? "image";
    setPhotoBusy(true); setNotice("");
    try {
      const photoId = await services.uploadMemoryPhoto(accessToken, file);
      setPhotos(await services.fetchMemoryPhotos(accessToken));
      const attach = (entry: Entry): Entry => entry.id !== targetEntryId ? entry : asSticker ? { ...entry, personalStickerPhotoId: photoId } : { ...entry, photoId, areas: { ...(entry.areas ?? {}), [imageSlotId]: { mode: "image", photoId } } };
      setBooks(all => all.map(item => item.id !== targetBookId ? item : ({ ...item, entries: item.entries.map(attach) })));
      setBook(active => active?.id !== targetBookId ? active : ({ ...active, entries: active.entries.map(attach) }));
      setNotice("Private photo is ready. Save the book to keep this selection.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Photo upload failed."); }
    finally { setPhotoBusy(false); }
  }
  async function captureFrame() {
    if (!current || isPreview) return;
    setPhotoBusy(true); setNotice("");
    let video: HTMLVideoElement | undefined;
    try {
      const { url } = await services.fetchVideoUrl(current.id, accessToken);
      video = document.createElement("video"); video.crossOrigin = "anonymous"; video.preload = "auto"; video.muted = true; video.src = url;
      await new Promise<void>((resolve, reject) => { video!.onloadedmetadata = () => resolve(); video!.onerror = () => reject(new Error("This recording cannot be used for frame capture.")); });
      const time = Number.isFinite(video.duration) ? Math.min(Math.max(frameTime, 0), Math.max(0, video.duration - 0.05)) : 0;
      if (time > 0) await new Promise<void>((resolve, reject) => { video!.onseeked = () => resolve(); video!.currentTime = time; video!.onerror = () => reject(new Error("Unable to seek the recording.")); });
      const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      if (!canvas.width || !canvas.height) throw new Error("The recording has no capturable frame.");
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("The frame could not be captured. Check video CORS settings.")), "image/jpeg", 0.9));
      await addPhoto(blob);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Frame capture failed."); }
    finally { if (video) { video.pause(); video.removeAttribute("src"); video.load(); } setPhotoBusy(false); }
  }
  function addExactQuote() {
    if (!current || !sourceRef.current) return;
    const { selectionStart, selectionEnd } = sourceRef.current;
    const selectedText = (current.original_text ?? "").slice(selectionStart, selectionEnd);
    if (!selectedText || selectionStart === selectionEnd) { setNotice("Select exact words from the original transcript first."); return; }
    change(b => ({ ...b, entries: b.entries.map(entry => entry.id === current.id ? { ...entry, quotes: [...new Set([...(entry.quotes ?? []), selectedText])] } : entry) }));
    setNotice("Exact source quote added.");
  }
  function suggestQuotes() {
    if (!current?.original_text) return;
    const candidates = current.original_text.split(/(?<=[.!?])\s+|\n+/).map(value => value.trim()).filter(value => value.length >= 35 && value.length <= 240);
    const ranked = candidates.map((text, index) => ({ text, index, score: (text.length >= 55 && text.length <= 180 ? 2 : 0) + (/\b(I|we|my|our|felt|remember|realized|decided|hope|love|afraid|happy)\b/i.test(text) ? 3 : 0) + (/[.!?]$/.test(text) ? 1 : 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
    setQuoteSuggestions(ranked.slice(0, 5).map(item => item.text));
  }
  const includedEntries = book?.entries.filter(entry => {
    if (!entry.included || !book) return false;
    const day = localDateKey(entry.date, book.timezone ?? "UTC");
    return (!book.dateStart || day >= book.dateStart) && (!book.dateEnd || day <= book.dateEnd);
  }) ?? [];
  const chronologicalChapters = [...new Set(includedEntries.map(entry => chapterMonth(entry.date, book?.timezone ?? "UTC")))].sort();
  const chapterOrder = [...(book?.chapterOrder ?? []).filter(key => chronologicalChapters.includes(key)), ...chronologicalChapters.filter(key => !(book?.chapterOrder ?? []).includes(key))];
  const chapterRank = new Map(chapterOrder.map((key, index) => [key, index]));
  const notebookTemplateSelected = Boolean(book && templateFor(book).id === "notebook-v1");
  const orderedIncludedEntries = notebookTemplateSelected ? [...includedEntries] : [...includedEntries].sort((a, b) => (chapterRank.get(chapterMonth(a.date, book?.timezone ?? "UTC")) ?? 0) - (chapterRank.get(chapterMonth(b.date, book?.timezone ?? "UTC")) ?? 0) || (book?.entries.indexOf(a) ?? 0) - (book?.entries.indexOf(b) ?? 0));
  const previewEntries = orderedIncludedEntries.filter(entry => entry.approved);
  const annualQuotes = previewEntries.flatMap(entry => entry.quotes
    .filter(quote => (entry.quoteModes?.[quote] ?? entry.quoteDisplay ?? "both") !== "exclude")
    .map(quote => ({ id: entry.id, quote, date: localDateKey(entry.date, book?.timezone ?? "UTC") })));
  const chapterKeys = chapterOrder.filter(key => previewEntries.some(entry => chapterMonth(entry.date, book?.timezone ?? "UTC") === key));
  const yearKeys = [...new Set(includedEntries.map(entry => chapterMonth(entry.date, book?.timezone ?? "UTC").slice(0, 4)))];
  const availableReflectionKeys = reflectionPeriod === "month" ? chapterOrder : yearKeys;
  const activeReflectionKey = availableReflectionKeys.includes(reflectionKey) ? reflectionKey : (availableReflectionKeys[0] ?? "");
  const includedDayKeys = includedEntries.map(entry => localDateKey(entry.date, book?.timezone ?? "UTC")).sort();
  const coverStart = book?.dateStart || includedDayKeys[0] || "";
  const coverEnd = book?.dateEnd || includedDayKeys.at(-1) || "";

  return <section className="memory-books">
    <header className="memory-head"><div><p className="eyebrow">YOUR STORIES, GATHERED</p><h1>Previous memory books</h1><p>Your earlier template layouts remain available here.</p></div><div className="memory-actions"><button className="button button-secondary" onClick={onPageMode}>Back to journal page collections</button><button className="button button-secondary" onClick={newBook}>Create from an earlier template</button>{book && <><button className="button" onClick={duplicate}>Duplicate book</button><button className="button button-secondary" disabled={busy} onClick={() => { setDeleteError(""); setDeleteTarget(book); setDeleteConfirmationOpen(true); }}>Delete book</button></>}</div></header>
    <div className="memory-grid">
      <aside className="memory-library"><h2>Your books</h2>{books.length ? books.map(item => <button className={`memory-book-choice ${book?.id === item.id ? "chosen" : ""}`} key={item.id} onClick={() => { setBook(item); setSelected(item.entries[0]?.id ?? null); }}>{item.title}<small>{item.entries.length} memories</small></button>) : <p className="memory-muted">Create a book to begin.</p>}
        <h2>Journal entries</h2><label className="memory-search">Filter journals<select value={pickerFilter} onChange={e => setPickerFilter(e.target.value)}><option value="all">All</option><option value="favorites">Favorites</option><option value="meaningful">Meaningful</option></select></label><label className="memory-search">Add a memory<select aria-label="Choose a journal memory" value="" disabled={!book || busy} onChange={event => { const found = journals.find(j => j.upload_id === event.target.value); if (found) void addJournal(found); }}><option value="">Choose an entry…</option>{journals.filter(j => !book?.entries.some(e => e.id === j.upload_id) && (pickerFilter === "all" || (pickerFilter === "favorites" ? journalFlags.get(j.upload_id)?.favorite : journalFlags.get(j.upload_id)?.meaningful)) && (!book?.dateStart || localDateKey(j.created_at, book.timezone ?? "UTC") >= book.dateStart) && (!book?.dateEnd || localDateKey(j.created_at, book.timezone ?? "UTC") <= book.dateEnd)).map(j => <option key={j.upload_id} value={j.upload_id}>{new Date(j.created_at).toLocaleDateString()} · {j.title}</option>)}</select></label>
        {loading && <p role="status">Loading journals…</p>}{error && <div role="alert">{error} <button onClick={() => setError("")}>Dismiss</button></div>}
      </aside>
      {book ? <div className={`memory-editor ${book.entries.some(entry => entry.photoIds?.length || entry.layout && entry.layout !== "text" || entry.caption || entry.focal || entry.annotation) ? "has-legacy-tools" : ""}`}>
        <div className="memory-settings"><label>Book title<input value={book.title} maxLength={120} onChange={e => change(b => ({ ...b, title: e.target.value }))}/></label><label>Subtitle<input value={book.subtitle} maxLength={160} onChange={e => change(b => ({ ...b, subtitle: e.target.value }))}/></label><label>Template<select aria-label="Memory book template" value={templateFor(book).id} onChange={e => { const selectedTemplate = templates.find(item => item.id === e.target.value)!; change(b => ({ ...b, templateId: selectedTemplate.id, theme: selectedTemplate.legacyTheme, marginMm: selectedTemplate.page.marginMm })); }}>
          {templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{templateFor(book).identity}</small></label><label>Cover photo<select value={book.coverPhotoId ?? ""} onChange={e => change(b => ({ ...b, coverPhotoId: e.target.value || undefined }))}><option value="">No photo</option>{photos.filter(p => p.status === "complete").map(photo => <option key={photo.photo_id} value={photo.photo_id}>Private photo {photo.photo_id.slice(0, 8)}</option>)}</select></label><label>Book timezone<input value={book.timezone ?? "UTC"} maxLength={128} onChange={e => change(b => ({ ...b, timezone: e.target.value }))}/></label><label>Start date<input type="date" value={book.dateStart ?? ""} onChange={e => change(b => ({ ...b, dateStart: e.target.value }))}/></label><label>End date<input type="date" value={book.dateEnd ?? ""} onChange={e => change(b => ({ ...b, dateEnd: e.target.value }))}/></label></div>
        <div role="group" className="memory-design-controls" aria-label="Book design"><label>Paper color<select aria-label="Paper color" value={book.pageColor ?? "#fffefa"} onChange={e => change(b => ({ ...b, pageColor: e.target.value, coverBackground: e.target.value }))}>{!paperColors.some(color => color.value.toLowerCase() === (book.pageColor ?? "#fffefa").toLowerCase()) && <option value={book.pageColor}>{`Saved color ${book.pageColor}`}</option>}{paperColors.map(color => <option key={color.value} value={color.value}>{color.label}</option>)}</select></label><label>Material<select aria-label="Paper material" value={book.texture} onChange={e => change(b => ({ ...b, texture: e.target.value }))}>{textures.map(x => <option key={x}>{x}</option>)}</select></label><label>Typography<select aria-label="Typography" value={book.bodyFont ?? "serif"} onChange={e => change(b => ({ ...b, bodyFont: e.target.value, coverFont: e.target.value, headingFont: e.target.value }))}><option value="serif">Book serif</option><option value="sans">Clean sans</option></select></label></div>
        <section className="memory-year-words"><label><input type="checkbox" checked={book.yearSectionEnabled ?? false} onChange={e => change(b => ({ ...b, yearSectionEnabled: e.target.checked }))}/> Include “Year in My Own Words”</label>{book.yearSectionEnabled && <><p>Selected original quotes appear here with their journal dates. Add a separate personal note if you want.</p>{includedEntries.flatMap(entry => (entry.quotes ?? []).filter(quote => !["exclude"].includes(entry.quoteModes?.[quote] ?? entry.quoteDisplay ?? "both")).map((quote, i) => <blockquote key={`${entry.id}-${i}`}>“{quote}” <small>{localDateKey(entry.date, book.timezone ?? "UTC")}</small></blockquote>))}<textarea aria-label="Optional year annotation" maxLength={20000} placeholder="Optional personal note about your year…" value={book.yearSectionText ?? ""} onChange={e => change(b => ({ ...b, yearSectionText: e.target.value }))}/></>}</section>
        <details className="memory-advanced"><summary>Optional AI reflections</summary><section className="memory-reflections"><h3>AI-generated reflections</h3><p>Each reflection uses every included original journal in the chosen period. If the complete source set is too long, generation will explain the limit instead of skipping entries.</p><div className="memory-rewrite-row"><label>Period<select value={reflectionPeriod} onChange={e => { const period = e.target.value as "month" | "year"; setReflectionPeriod(period); setReflectionKey(""); }}><option value="month">Month</option><option value="year">Year</option></select></label><label>Source period<select value={activeReflectionKey} onChange={e => setReflectionKey(e.target.value)}>{availableReflectionKeys.map(key => <option key={key} value={key}>{key}</option>)}</select></label><button className="button button-secondary" disabled={generatingReflection || !activeReflectionKey} onClick={() => { setReflectionKey(activeReflectionKey); void generateReflection(reflectionPeriod, activeReflectionKey); }}>{generatingReflection ? "Generating…" : "Generate reflection"}</button></div>{(book.reflections ?? []).map((reflection, index) => <article className="memory-reflection-card" key={`${reflection.period}-${reflection.key}-${index}`}><strong>AI generated · {reflection.period === "month" ? reflection.key : `Year ${reflection.key}`}</strong><p>{reflection.coverage.journal_count} original journals · {reflection.coverage.start_date} to {reflection.coverage.end_date}</p><textarea aria-label={`Editable ${reflection.period} reflection`} maxLength={5000} value={reflection.text} onChange={e => change(b => ({ ...b, reflections: (b.reflections ?? []).map(item => item === reflection ? { ...item, text: e.target.value, approved: false } : item) }))}/><div className="memory-toggle-row"><label><input type="checkbox" checked={reflection.included} onChange={e => change(b => ({ ...b, reflections: (b.reflections ?? []).map(item => item === reflection ? { ...item, included: e.target.checked } : item) }))}/> Include</label><label><input type="checkbox" checked={reflection.approved} onChange={e => change(b => ({ ...b, reflections: (b.reflections ?? []).map(item => item === reflection ? { ...item, approved: e.target.checked } : item) }))}/> Reviewed and approved</label></div></article>)}</section></details>
        <div className="memory-workspace"><div className="memory-entry-list"><div className="memory-entry-tools"><label>Show<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All</option><option value="favorites">Favorites</option><option value="meaningful">Meaningful</option></select></label></div>{visibleEntries.map((entry, index) => <button key={entry.id} className={`memory-entry-pick ${selected === entry.id ? "selected" : ""}`} onClick={() => setSelected(entry.id)}>{index + 1}. {entry.title}<small>{new Date(entry.date).toLocaleDateString()}</small></button>)}{!visibleEntries.length && <p className="memory-muted">Add a journal entry to start your book.</p>}</div>
          {current ? <article className="memory-review"><div className="memory-review-heading"><div><p className="eyebrow">REVIEW THIS MEMORY</p><h2>{current.title}</h2><time data-fill-slot="date" tabIndex={-1}>{new Date(current.date).toLocaleDateString(undefined, { dateStyle: "long" })}</time></div><div className="memory-toggle-row"><button aria-pressed={current.favorite} onClick={() => change(b => ({ ...b, entries: b.entries.map(e => e.id === current.id ? { ...e, favorite: !e.favorite } : e) }))}>★ Favorite</button><button aria-pressed={current.meaningful} onClick={() => change(b => ({ ...b, entries: b.entries.map(e => e.id === current.id ? { ...e, meaningful: !e.meaningful } : e) }))}>♥ Meaningful</button></div></div>
              <label className="memory-title-field">Memory title<input aria-label="Memory title" data-fill-slot="title" maxLength={160} value={current.title} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, title: e.target.value } : item) }))}/></label>
              <details className="memory-advanced"><summary>{notebookTemplateSelected ? "Entry order" : "Chapter and memory ordering"}</summary><div className="memory-chapter-tools">{!notebookTemplateSelected && <><label>Monthly chapter title<input maxLength={80} value={book.chapterTitles?.[currentChapter] ?? new Date(`${currentChapter}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })} onChange={e => change(b => ({ ...b, chapterTitles: { ...(b.chapterTitles ?? {}), [currentChapter]: e.target.value } }))}/></label><button className="button button-secondary" aria-label="Move chapter earlier" onClick={() => moveChapter(-1)}>Chapter up</button><button className="button button-secondary" aria-label="Move chapter later" onClick={() => moveChapter(1)}>Chapter down</button></>}<button className="button button-secondary" aria-label="Move memory earlier" disabled={currentPosition <= 0} onClick={() => moveMemory(-1)}>Move earlier</button><button className="button button-secondary" aria-label="Move memory later" disabled={currentPosition < 0 || currentPosition >= book.entries.length - 1} onClick={() => moveMemory(1)}>Move later</button></div></details>
              <p className="memory-muted">Editable book text · original journal transcript stays unchanged.</p><textarea data-fill-slot="story" aria-label="Approved memory text" value={current.text} maxLength={30000} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, text: e.target.value, approved: false } : item) }))}/>
              <section className="memory-fill-controls" aria-label="Fill reserved page areas"><h3>Reserved page areas</h3><p>Each area keeps its place in the printed page when left blank.</p>
                {editableSlots.map(slot => {
                  const legacyPhoto = slot.kind === "image-or-text" && current.layout !== "text" ? current.photoIds?.[0] ?? current.photoId : undefined;
                  const area = current.areas?.[slot.id] ?? (legacyPhoto ? { mode: "image" as const, photoId: legacyPhoto } : { mode: "blank" as const });
                  const label = slot.id.replaceAll("-", " ").replace(/\b\w/g, value => value.toUpperCase());
                  const setMode = (mode: "blank" | "text" | "image") => change(b => ({ ...b, entries: b.entries.map(item => {
                    if (item.id !== current.id) return item;
                    const photoId = item.areas?.[slot.id]?.photoId ?? item.photoId;
                    const area = mode === "blank" ? { mode } : mode === "text" ? { mode, text: item.areas?.[slot.id]?.text ?? "" } : photoId ? { mode, photoId } : { mode: "blank" as const };
                    return { ...item, areas: { ...(item.areas ?? {}), [slot.id]: area } };
                  }) }));
                  return <Fragment key={slot.id}><label>{label}<select data-fill-slot={slot.id} aria-label={`${label} content`} value={area.mode} onChange={e => setMode(e.target.value as "blank" | "text" | "image")}><option value="blank">Leave blank</option><option value="text">Add text</option>{slot.kind === "image-or-text" && <option value="image">Place an image</option>}</select></label>
                    {area.mode === "text" && <label>{label} text<textarea data-fill-slot={slot.id} aria-label={`${label} text`} maxLength={2000} value={area.text ?? ""} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, areas: { ...(item.areas ?? {}), [slot.id]: { mode: "text", text: e.target.value } } } : item) }))}/></label>}
                    {area.mode === "image" && slot.kind === "image-or-text" && <label>{label} image<select data-fill-slot={slot.id} aria-label={`${label} photo`} value={area.photoId ?? ""} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, areas: { ...(item.areas ?? {}), [slot.id]: e.target.value ? { mode: "image", photoId: e.target.value } : { mode: "blank" } }, photoId: e.target.value || undefined } : item) }))}><option value="">Choose uploaded image…</option>{photos.filter(p => p.status === "complete").map(photo => <option key={photo.photo_id} value={photo.photo_id}>Private photo {photo.photo_id.slice(0, 8)}</option>)}</select><small>Upload one in Photo tools below.</small></label>}
                    {slot.kind === "image-or-text" && <label>{label} upload<input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy || isPreview} onChange={e => { const file = e.target.files?.[0]; if (file) void addPhoto(file, slot.id); e.currentTarget.value = ""; }}/></label>}
                  </Fragment>;
                })}
              </section>
              <div className="memory-rewrite-row"><label>Writing style<select value={book.rewriteStyle ?? "reflective"} onChange={e => change(b => ({ ...b, rewriteStyle: e.target.value }))}><option value="conversational">Conversational</option><option value="reflective">Reflective</option><option value="storytelling">Storytelling</option><option value="minimal">Minimal</option></select></label><label>Amount<select value={book.rewriteAmount ?? "light"} onChange={e => change(b => ({ ...b, rewriteAmount: e.target.value }))}><option value="original">Original text</option><option value="light">Light</option><option value="medium">Medium</option><option value="deep">Deep</option></select></label><button disabled={rewriting} className="button button-secondary" onClick={() => void generateRewrite()}>{rewriting ? "Generating…" : "Generate draft"}</button><button className="button button-secondary" onClick={() => void saveWritingPreferences(book.rewriteStyle ?? "reflective", book.rewriteAmount ?? "light")}>Save as writing defaults</button></div>
              {current.candidate && <div className="memory-candidate"><strong>AI generated candidate · review before applying</strong><p>{current.candidate}</p><button className="button button-secondary" onClick={() => change(b => ({ ...b, entries: b.entries.map(entry => entry.id === current.id ? { ...entry, text: current.candidate!, approved: false } : entry) }))}>Use this draft</button></div>}
              <details className="memory-source" data-fill-slot="quote" tabIndex={-1}><summary>View original transcript and select an exact quote</summary>{!current.sourceAvailable && <p role="status">The source journal is unavailable or was removed. Existing saved words remain in the book; new quotes cannot be added.</p>}<textarea ref={sourceRef} aria-label="Original source transcript" readOnly value={current.original_text ?? ""}/><button className="button button-secondary" disabled={!current.sourceAvailable} onClick={addExactQuote}>Add selected exact quote</button><button className="button button-secondary" disabled={!current.sourceAvailable} onClick={suggestQuotes}>Suggest exact quotes</button>{quoteSuggestions.map((quote, i) => <button key={`suggest-${i}`} className="memory-quote-suggestion" onClick={() => { if (current.original_text.includes(quote)) change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, quotes: [...new Set([...(item.quotes ?? []), quote])] } : item) })); }}>{quote} ? Add</button>)}{(current.quotes ?? []).map((quote, i) => <div className="memory-quote-control" key={`${quote}-${i}`}><blockquote>“{quote}”</blockquote><label>Quote placement<select aria-label={`Placement for quote ${i + 1}`} value={current.quoteModes?.[quote] ?? current.quoteDisplay ?? "both"} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, quoteModes: { ...(item.quoteModes ?? {}), [quote]: e.target.value } } : item) }))}><option value="both">Inline and standalone</option><option value="inline">Inline</option><option value="standalone">Standalone</option><option value="exclude">Exclude</option></select></label><button aria-label={`Remove quote ${i + 1}`} onClick={() => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, quotes: item.quotes.filter((_, index) => index !== i) } : item) }))}>Remove quote</button></div>)}<label>Use selected quotes<select value={current.quoteDisplay ?? "both"} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, quoteDisplay: e.target.value } : item) }))}><option value="both">Inline highlights and standalone pages</option><option value="inline">Inline highlights</option><option value="standalone">Standalone quote pages</option><option value="exclude">Keep saved, leave out of this book</option></select></label></details>
              {!isPreview && <section className="memory-photo-controls" aria-label="Memory photographs"><h3>Photos and page layout</h3><label>Photos for this memory<select multiple size={Math.min(5, Math.max(2, photos.filter(p => p.status === "complete").length))} value={current.photoIds ?? (current.photoId ? [current.photoId] : [])} onChange={e => { const photoIds = Array.from(e.target.selectedOptions, option => option.value); change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, photoIds, photoId: photoIds[0] } : item) })); }}><option value="" disabled>No uploaded photos yet</option>{photos.filter(p => p.status === "complete").map(photo => <option key={photo.photo_id} value={photo.photo_id}>Photo {photo.photo_id.slice(0, 8)}</option>)}</select><small>Use Ctrl or Command to select several for a gallery or collage.</small></label><label>Caption<input maxLength={500} value={current.caption ?? ""} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, caption: e.target.value } : item) }))}/></label><div className="memory-photo-buttons"><label className="button button-secondary">Upload a private photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy} onChange={e => { const file = e.target.files?.[0]; if (file) void addPhoto(file); e.currentTarget.value = ""; }}/></label><label>Frame time ? seconds<input type="number" min="0" step="0.1" value={frameTime} onChange={e => setFrameTime(Math.max(0, Number(e.target.value) || 0))}/></label><button className="button button-secondary" disabled={photoBusy} onClick={() => void captureFrame()}>{photoBusy ? "Processing photo…" : "Capture frame from video"}</button></div><label>Crop focal point · horizontal<input type="range" min="0" max="100" value={current.focal?.x ?? 50} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, focal: { ...(item.focal ?? { x: 50, y: 50 }), x: Number(e.target.value) } } : item) }))}/></label><label>Crop focal point · vertical<input type="range" min="0" max="100" value={current.focal?.y ?? 50} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, focal: { ...(item.focal ?? { x: 50, y: 50 }), y: Number(e.target.value) } } : item) }))}/></label>{current.photoId && photoUrl(current.photoId) && <img className="memory-photo-thumb" src={photoUrl(current.photoId)} alt="Selected private memory photo preview"/>}</section>}
              <div className="memory-toggle-row"><label><input type="checkbox" checked={current.included} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, included: e.target.checked } : item) }))}/> Include in this book</label><label><input type="checkbox" checked={current.approved} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, approved: e.target.checked } : item) }))}/> I reviewed this text</label><button className="button button-secondary" onClick={() => change(b => ({ ...b, entries: b.entries.filter(item => item.id !== current.id) }))}>Remove from book</button></div>
              {templateFor(book).id === "notebook-v1" && <section className="memory-sticker-controls" aria-label="Notebook stickers"><h3>Stickers for this page</h3><div className="memory-sticker-options">{notebookStickerIds.map(id => <button type="button" key={id} aria-pressed={(current.stickers ?? []).includes(id)} onClick={() => { const selectedStickers = current.stickers ?? []; const stickers = selectedStickers.includes(id) ? selectedStickers.filter(value => value !== id) : [...selectedStickers, id].slice(0, 5); change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, stickers } : item) })); }}>{id[0]?.toUpperCase() + id.slice(1)}</button>)}</div><small>Choose up to five. They print in the reserved sticker row.</small>{!isPreview && <label className="button button-secondary">Upload a personal sticker or scanned drawing<input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy} onChange={e => { const file = e.target.files?.[0]; if (file) void addPhoto(file, undefined, true); e.currentTarget.value = ""; }}/></label>}{current.personalStickerPhotoId && <div className="memory-personal-sticker-choice"><small>A personal sticker is attached to this entry.</small><button type="button" className="button button-secondary" onClick={() => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, personalStickerPhotoId: undefined } : item) }))}>Remove personal sticker</button></div>}</section>}
              <label className="memory-notes">Personal annotation<textarea maxLength={1500} placeholder="Add a note for your future self" value={current.annotation ?? ""} onChange={e => change(b => ({ ...b, entries: b.entries.map(item => item.id === current.id ? { ...item, annotation: e.target.value } : item) }))}/></label>
            </article> : <div className="memory-empty">Choose a memory or add one from your journal entries.</div>}</div>
        <div className="memory-book-controls">
          <div className="memory-actions">
            <button className="button button-secondary" disabled={busy} onClick={() => void saveBook()}>Save book</button>
            <button className="button" disabled={busy} onClick={() => void exportBook()}>{isPreview ? "Print preview" : "Export PDF"}</button>
            {exportRevision !== null && !isPreview && (
              <button className="button button-secondary" onClick={() => void checkExport()}>Check export status</button>
            )}
            {exportStatus === "failed" && (
              <button className="button button-secondary" onClick={() => void retryExport()}>Retry this export</button>
            )}
            {exportUrl && <a className="button button-secondary" href={exportUrl} target="_blank" rel="noreferrer">Download ready PDF</a>}
          </div>
          <span>{includedEntries.length} included · {includedEntries.filter(entry => !entry.approved).length} still to review</span>
        </div>
        <section className={`memory-preview theme-${book.theme.toLowerCase().replaceAll(" ", "-")} paper-${book.texture.toLowerCase().replaceAll(" ", "-")} font-${book.headingFont ?? "serif"} ${book.pageBorder === false ? "without-page-border" : ""}`} style={{ fontSize: notebookTemplateSelected ? "12.5px" : `${book.fontSize}px`, lineHeight: notebookTemplateSelected ? 1.5 : (book.lineSpacing ?? 17) / 10, color: book.textColor ?? "#43332e", backgroundColor: book.pageColor ?? "#fffefa", padding: `${book.marginMm ?? 20}px`, fontFamily: book.bodyFont === "sans" ? "Arial, sans-serif" : "Georgia, serif", ["--cover-background"]: book.coverBackground ?? book.pageColor ?? "#fffefa", ["--cover-font"]: book.coverFont === "sans" ? "Arial, sans-serif" : "Georgia, serif", ["--heading-size"]: `${book.headingSize ?? 22}px` } as CSSProperties}>
          <div className="memory-cover">{photoUrl(book.coverPhotoId) && <img className="memory-preview-cover-photo" src={photoUrl(book.coverPhotoId)} alt="Selected book cover"/>}<p>MY MEMORY BOOK</p><h2>{book.title}</h2>{book.subtitle && <p>{book.subtitle}</p>}<small>{coverStart && coverEnd ? `${coverStart} — ${coverEnd} · ` : ""}{book.entries.filter(e => e.included).length} moments · {book.texture} paper</small></div>
          <nav className="memory-preview-nav" aria-label="Book pages">{!notebookTemplateSelected && chapterKeys.map(key => <a key={key} href={`#chapter-${key}`}>{book.chapterTitles?.[key] || new Date(`${key}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</a>)}{previewEntries.map((entry, index) => <a key={entry.id} href={`#memory-${entry.id}`}>{index + 1}. {entry.title}</a>)}{(book.reflections ?? []).filter(reflection => reflection.included && reflection.approved).map(reflection => <a key={`ref-${reflection.period}-${reflection.key}`} href={`#reflection-${reflection.period}-${reflection.key}`}>{reflection.period} reflection · {reflection.key}</a>)}</nav>
          {previewEntries.map((entry, index) => {
            const month = chapterMonth(entry.date, book.timezone ?? "UTC");
            const previousMonth = index > 0 ? chapterMonth(previewEntries[index - 1]!.date, book.timezone ?? "UTC") : "";
            return <Fragment key={entry.id}>{month !== previousMonth && templateFor(book).id !== "notebook-v1" && <div className="memory-chapter-page" id={`chapter-${month}`}><p className="eyebrow">CHAPTER</p><h2>{book.chapterTitles?.[month] || new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2></div>}<article className={`memory-page template-${templateFor(book).id}`} id={`memory-${entry.id}`}>{templatePageSlots(entry, templateFor(book), book, photoUrl, slotId => focusMemoryArea(entry.id, slotId))}</article>{notebookContinuations.includes(entry.id) && <p className="notebook-continuation-hint" role="status">This entry will continue onto another printed page.</p>}</Fragment>;
          })}
          {book.yearSectionEnabled && (book.yearSectionText?.trim() || annualQuotes.length > 0) && (
            <article className="memory-page memory-year-section">
              <h2>Year in My Own Words</h2>
              {annualQuotes.map(({ id, quote, date }) => (
                <blockquote key={`${id}-${quote}`}>
                  <p>“{quote}”</p>
                  <small>{date}</small>
                </blockquote>
              ))}
              {book.yearSectionText?.trim() && <aside className="memory-annotation">{book.yearSectionText}</aside>}
            </article>
          )}
          {(book.reflections ?? []).filter(reflection => reflection.included && reflection.approved).map(reflection => <article className="memory-page memory-ai-reflection" id={`reflection-${reflection.period}-${reflection.key}`} key={`${reflection.period}-${reflection.key}`}><p className="eyebrow">AI-GENERATED {reflection.period.toUpperCase()} REFLECTION · {reflection.key}</p><p className="memory-muted">Based on {reflection.coverage.journal_count} included original journals · {reflection.coverage.start_date} to {reflection.coverage.end_date}</p><p>{reflection.text}</p></article>)}
        </section>
      </div> : <div className="memory-empty">Create a book to gather your favorite journal moments.</div>}
    </div>{notice && <p role="status" className="memory-notice">{notice} {notice.includes("changed elsewhere") && <button className="button button-secondary" onClick={() => void reloadBooks()}>Reload saved version</button>}</p>}{!isPreview && <p className="memory-footnote">Original transcripts remain unchanged. Approved narrative revisions are reusable across books; each saved book keeps its selected revision.</p>}
    {deleteConfirmationOpen && deleteTarget && <div className="memory-delete-backdrop"><section className="memory-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="memory-delete-title" aria-describedby="memory-delete-copy"><h2 id="memory-delete-title">Delete &quot;{deleteTarget.title}&quot;?</h2><p id="memory-delete-copy">{isPreview || deleteTarget.revision === 0 ? "This discards the local book draft." : "This permanently deletes this book and its generated PDFs. Your journals, reusable narrative revisions, private uploaded photos, and other books will remain."}</p>{deleteError && <p role="alert" className="memory-delete-error">{deleteError}</p>}<div className="memory-actions"><button ref={deleteCancelRef} type="button" className="button button-secondary" disabled={busy} onClick={() => { setDeleteConfirmationOpen(false); setDeleteTarget(null); setDeleteError(""); }}>Cancel</button><button type="button" className="button" disabled={busy} onClick={() => void deleteCurrentBook()}>{busy ? "Deleting..." : "Delete book"}</button></div></section></div>}
    <style>{`@media print { body * { visibility:hidden } .memory-preview,.memory-preview * { visibility:visible } .memory-preview { position:absolute;inset:0;width:100%;box-shadow:none } .memory-preview-nav,.notebook-continuation-hint { display:none!important } .memory-page,.memory-chapter-page { break-before:page } .memory-cover { break-after:page } .memory-books { display:block } }`}</style>
  </section>;
}

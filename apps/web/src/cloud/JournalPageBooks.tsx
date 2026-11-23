import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useCloudEnvironment } from "./CloudEnvironment";
import type { JournalPage, JournalPageBlock, JournalSummary, MemoryBookRecord, MemoryPhoto } from "./analysisApi";
import templateCatalog from "../../../../infra/lambda/memory-book-templates.json";

function titleFor(entries: MemoryBookRecord["entries"]) {
  const dates = entries.filter(entry => entry.included).map(entry => new Date(entry.date).getTime()).filter(Number.isFinite);
  if (!dates.length) return "Journal pages · New collection";
  const format = (time: number) => new Date(time).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const first = Math.min(...dates), last = Math.max(...dates);
  return first === last || format(first) === format(last)
    ? `Journal pages · ${format(first)}`
    : `Journal pages · ${format(first)} – ${format(last)}`;
}
function makeBook(): MemoryBookRecord {
  return { id: crypto.randomUUID(), title: "Journal pages · New collection", subtitle: "", contentMode: "journal-pages", includeHighlights: false, templateId: "notebook-v1", theme: "Notebook", texture: "Plain", fontSize: 16, revision: 0, entries: [], excludedDays: [], dateStart: "", dateEnd: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
}

function dayCount(entries: MemoryBookRecord["entries"], timezone: string) {
  return new Set(entries.filter(entry => entry.included).map(entry => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(entry.date));
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  })).size;
}

function entryFromJournal(journal: JournalSummary) {
  return { id: journal.upload_id, title: journal.title, date: journal.created_at, included: true, approved: true,
    text: "", original_text: "", quotes: [], favorite: false, meaningful: false, narrativeRevision: 0, metadataRevision: 0, sourceAvailable: true };
}

function localDayKey(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function monthRange(timezone: string, offset: number) {
  const today = localDayKey(new Date().toISOString(), timezone);
  const [year, month] = today.split("-").map(Number);
  const first = new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year!, month! + offset, 0)).toISOString().slice(0, 10);
  return { start: first, end: last };
}

function rangePresetFor(start: string, end: string, timezone: string): "this-month" | "last-month" | "custom" {
  const current = monthRange(timezone, 0), previous = monthRange(timezone, -1);
  if (start === current.start && end === current.end) return "this-month";
  if (start === previous.start && end === previous.end) return "last-month";
  return "custom";
}

function pageBlockPreview(block: JournalPageBlock, photos: MemoryPhoto[], includeHighlights: boolean) {
  const style = {
    width: `${block.widthPercent ?? (block.width === "half" ? 50 : block.width === "wide" ? 75 : 100)}%`,
    transform: `translate(${block.x ?? 0}mm, ${block.y ?? 0}mm) rotate(${block.rotation ?? 0}deg)`,
    minHeight: block.heightMm ? `${block.heightMm}mm` : undefined,
    fontSize: block.kind === "text" ? `${block.fontSize ?? 16}pt` : undefined,
  };
  if (block.kind === "text") {
    const parts = includeHighlights && block.highlight && block.text.includes(block.highlight) ? block.text.split(block.highlight).flatMap((part, index, all) => index === all.length - 1 ? [part] : [part, <mark key={`${block.id}-highlight-${index}`}>{block.highlight}</mark>]) : [block.text];
    return <p key={block.id} className={`journal-preview-block ${block.style === "note" ? "journal-note-text" : ""}`} style={style}>{parts}</p>;
  }
  const url = photos.find(photo => photo.photo_id === block.photoId)?.url;
  return <figure key={block.id} className={`journal-preview-block journal-preview-image ${includeHighlights && block.highlight ? "is-highlighted" : ""}`} style={style}>{url && <img src={url} alt={block.caption || "Journal photo"}/>}<figcaption>{block.caption || "Photo"}</figcaption></figure>;
}

function previewBlocks(page: JournalPage, photos: MemoryPhoto[], includeHighlights: boolean) {
  const seen = new Set<string>();
  const sourceTitles = new Map((page.sources ?? []).map(source => [source.id, source.title]));
  return page.blocks.flatMap(block => {
    const sourceJournalId = block.kind === "text" && block.source ? block.sourceJournalId : undefined;
    const title = sourceJournalId && !seen.has(sourceJournalId) ? sourceTitles.get(sourceJournalId) : undefined;
    if (sourceJournalId) seen.add(sourceJournalId);
    return [
      ...(title ? [<h2 className="journal-preview-source" key={`source-${sourceJournalId}`}>{title}</h2>] : []),
      pageBlockPreview(block, photos, includeHighlights),
    ];
  });
}

export function JournalPageBooks({ onLegacy }: { onLegacy: () => void }) {
  const { accessToken, services, isPreview } = useCloudEnvironment();
  const [journals, setJournals] = useState<JournalSummary[]>([]);
  const [books, setBooks] = useState<MemoryBookRecord[]>([]);
  const [book, setBook] = useState<MemoryBookRecord | null>(null);
  const [rangePreset, setRangePreset] = useState<"this-month" | "last-month" | "custom">("this-month");
  const [rangeDraft, setRangeDraft] = useState({ start: "", end: "" });
  const [rangeLoading, setRangeLoading] = useState(false);
  const [showDayPicker, setShowDayPicker] = useState(false);
  const [excludedOnly, setExcludedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [exportRevision, setExportRevision] = useState<number | null>(null);
  const [exportUrl, setExportUrl] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [previewPage, setPreviewPage] = useState<JournalPage | null>(null);
  const [previewDay, setPreviewDay] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPhotos, setPreviewPhotos] = useState<MemoryPhoto[]>([]);
  const requestGeneration = useRef(0);
  const previewRef = useRef<HTMLElement | null>(null);
  const previewGeneration = useRef(0);
  const previewCache = useRef(new Map<string, JournalPage>());
  const photosLoaded = useRef(false);

  async function reload() {
    setError("");
    const bookList = await services.fetchMemoryBooks(accessToken);
    const pageBooks = bookList.filter(item => item.contentMode === "journal-pages");
    setBooks(pageBooks);
    setBook(current => current ?? pageBooks[0] ?? null);
  }
  useEffect(() => { void reload().catch(e => setError(e instanceof Error ? e.message : "Unable to load journal pages.")); }, [accessToken, services]);

  function dayKey(value: string) {
    return localDayKey(value, book?.timezone || "UTC");
  }
  const dateStart = book?.dateStart ?? "", dateEnd = book?.dateEnd ?? "";
  const currentBookId = book?.id;
  useEffect(() => {
    if (!book) return;
    const start = book.dateStart ?? "", end = book.dateEnd ?? "";
    setRangeDraft({ start, end });
    setRangePreset(rangePresetFor(start, end, book.timezone ?? "UTC"));
  }, [book?.id]);
  useEffect(() => {
    if (book) setBooks(value => value.map(item => item.id === book.id ? book : item));
  }, [book]);
  function excludedDaysFor(value: MemoryBookRecord) {
    const excluded = new Set(value.excludedDays ?? []), groups = new Map<string, MemoryBookRecord["entries"]>();
    for (const entry of value.entries) groups.set(dayKey(entry.date), [...(groups.get(dayKey(entry.date)) ?? []), entry]);
    for (const [day, entries] of groups) if (entries.length && entries.every(entry => !entry.included)) excluded.add(day);
    return excluded;
  }
  const rangeTimezone = book?.timezone || "UTC";
  const eligibleDayGroups = useMemo(() => {
    const groups = new Map<string, JournalSummary[]>();
    for (const journal of journals) {
      const day = localDayKey(journal.created_at, rangeTimezone);
      groups.set(day, [...(groups.get(day) ?? []), journal]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [journals, rangeTimezone]);
  const excludedInRange = useMemo(() => {
    const excluded = book ? excludedDaysFor(book) : new Set<string>();
    return eligibleDayGroups.filter(([day]) => excluded.has(day)).map(([day]) => day);
  }, [book, eligibleDayGroups]);
  const includedDayKeys = useMemo(() => {
    const excluded = new Set(excludedInRange);
    return eligibleDayGroups.map(([day]) => day).filter(day => !excluded.has(day));
  }, [eligibleDayGroups, excludedInRange]);
  const months = useMemo(() => {
    const groups = new Map<string, [string, JournalSummary[]][]>();
    for (const item of eligibleDayGroups) {
      const month = item[0].slice(0, 7);
      groups.set(month, [...(groups.get(month) ?? []), item]);
    }
    return [...groups.entries()];
  }, [eligibleDayGroups]);

  useEffect(() => {
    if (!currentBookId) { setJournals([]); setRangeLoading(false); return; }
    const controller = new AbortController();
    let active = true;
    setRangeLoading(true); setError("");
    void services.fetchJournalsInRange(accessToken, dateStart, dateEnd, rangeTimezone, controller.signal)
      .then(records => {
        if (!active) return;
        const ready = records.filter(item => item.page_available ?? item.status === "completed");
        setJournals(ready);
        setBook(current => {
          if (!current || current.id !== currentBookId) return current;
          const excluded = excludedDaysFor(current);
          const entries = current.entries.filter(entry => {
            const day = localDayKey(entry.date, rangeTimezone);
            return (!dateStart || day >= dateStart) && (!dateEnd || day <= dateEnd);
          });
          const byId = new Map(entries.map(entry => [entry.id, entry]));
          for (const journal of ready) {
            const day = localDayKey(journal.created_at, rangeTimezone);
            const previous = byId.get(journal.upload_id);
            byId.set(journal.upload_id, previous
              ? { ...previous, title: journal.title, date: journal.created_at, included: !excluded.has(day) && previous.included }
              : { ...entryFromJournal(journal), included: !excluded.has(day) });
          }
          const next = { ...current, entries: [...byId.values()], excludedDays: [...excluded] };
          return next;
        });
      })
      .catch(error => { if (active && !controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to load pages for this range."); })
      .finally(() => { if (active) setRangeLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [accessToken, currentBookId, dateStart, dateEnd, rangeTimezone, services]);
  useEffect(() => {
    if (previewPage) requestAnimationFrame(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [previewPage]);
  function commit(next: MemoryBookRecord) {
    requestGeneration.current += 1; previewGeneration.current += 1; previewCache.current.clear();
    setBook(next); setBooks(value => value.map(item => item.id === next.id ? next : item)); setPreviewPage(null); setPreviewDay(""); setExportUrl(""); setExportRevision(null); setExportStatus("");
  }
  function changeTemplate(templateId: string) {
    if (!book) return;
    const template = templateCatalog.templates.find(value => value.id === templateId);
    if (!template) return;
    const next = { ...book, templateId, theme: template.legacyTheme };
    requestGeneration.current += 1;
    setBook(next); setBooks(value => value.map(item => item.id === next.id ? next : item));
    setExportUrl(""); setExportRevision(null); setExportStatus(""); setNotice("Preview updated for the selected print template.");
  }
  function create() {
    requestGeneration.current += 1;
    previewGeneration.current += 1; previewCache.current.clear();
    const next = makeBook();
    const range = monthRange(next.timezone ?? "UTC", 0);
    next.dateStart = range.start; next.dateEnd = range.end;
    setRangePreset("this-month"); setRangeDraft(range); setJournals([]); setRangeLoading(true);
    setBooks(value => [next, ...value]); setBook(next); setPreviewPage(null); setPreviewDay("");
    setNotice("All available days this month are selected. Change the range or exclude specific days.");
    setExportRevision(null); setExportUrl(""); setExportStatus("");
  }
  function updateRange(start: string, end: string, preset: "this-month" | "last-month" | "custom" = "custom") {
    if (!book || Boolean(start) !== Boolean(end) || (start && end && start > end)) return;
    if (start === dateStart && end === dateEnd) { setRangePreset(preset); setRangeDraft({ start, end }); return; }
    const excluded = excludedDaysFor(book);
    const entriesById = new Map(book.entries.filter(entry => {
      const key = dayKey(entry.date);
      return (!start || key >= start) && (!end || key <= end);
    }).map(entry => [entry.id, entry]));
    const entries = [...entriesById.values()];
    setRangePreset(preset); setRangeDraft({ start, end }); setRangeLoading(true); setJournals([]);
    commit({ ...book, dateStart: start, dateEnd: end, entries, excludedDays: [...excluded], title: titleFor(entries) });
  }
  function setDaysIncluded(days: string[], include: boolean) {
    if (!book) return;
    const selectedDays = new Set(days), excluded = excludedDaysFor(book);
    for (const day of days) { if (include) excluded.delete(day); else excluded.add(day); }
    const byId = new Map(book.entries.map(entry => [entry.id, entry]));
    for (const journal of journals) {
      const day = dayKey(journal.created_at);
      if (!selectedDays.has(day)) continue;
      const current = byId.get(journal.upload_id);
      byId.set(journal.upload_id, current
        ? { ...current, title: journal.title, date: journal.created_at, included: include }
        : { ...entryFromJournal(journal), included: include });
    }
    const entries = [...byId.values()];
    commit({ ...book, entries, excludedDays: [...excluded], title: titleFor(entries) });
  }
  function restoreExcludedDays() {
    if (!book || !excludedInRange.length) return;
    const visible = new Set(excludedInRange), excluded = excludedDaysFor(book);
    const byId = new Map(book.entries.map(entry => [entry.id, entry]));
    for (const day of excludedInRange) excluded.delete(day);
    for (const journal of journals) {
      if (!visible.has(dayKey(journal.created_at))) continue;
      const current = byId.get(journal.upload_id);
      byId.set(journal.upload_id, current ? { ...current, included: true } : { ...entryFromJournal(journal), included: true });
    }
    const entries = [...byId.values()];
    commit({ ...book, entries, excludedDays: [...excluded], title: titleFor(entries) });
  }
  async function save(explicitNotice = true) {
    if (!book || rangeLoading) return null;
    const updated = { ...book, title: titleFor(book.entries) };
    setBusy(true); setError("");
    try {
      const saved = await services.saveMemoryBook(accessToken, updated);
      commit(saved); setBooks(value => [saved, ...value.filter(item => item.id !== saved.id)]);
      if (explicitNotice) setNotice("Collection saved.");
      return saved;
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save this collection."); return null; }
    finally { setBusy(false); }
  }
  async function exportPdf() {
    if (!book || rangeLoading || !includedDayKeys.length) return;
    const saved = await save(false); if (!saved) return;
    if (isPreview) { setExportRevision(saved.revision); setExportStatus("preview-only"); setNotice("Collection saved. The local preview does not generate a PDF."); return; }
    setBusy(true); setNotice("");
    try { const job = await services.startMemoryExport(accessToken, saved.id); setExportRevision(job.revision); setExportStatus(job.status); setExportUrl(""); setNotice(`PDF export ${job.status}.`); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to start PDF export."); }
    finally { setBusy(false); }
  }
  async function openPreviewDay(day: string) {
    if (!book || rangeLoading) return;
    const requestId = ++previewGeneration.current;
    setPreviewDay(day); setPreviewLoading(true); setBusy(true); setError("");
    try {
      const page = previewCache.current.get(day) ?? await services.fetchDailyPage(accessToken, day, book.timezone || "UTC");
      if (previewGeneration.current !== requestId) return;
      if (!previewCache.current.has(day)) previewCache.current.set(day, page);
      const photos = photosLoaded.current ? previewPhotos : await services.fetchMemoryPhotos(accessToken).catch(() => []);
      if (previewGeneration.current !== requestId) return;
      if (!photosLoaded.current) { photosLoaded.current = true; setPreviewPhotos(photos); }
      if (previewGeneration.current === requestId) setPreviewPage(page);
    } catch (e) { if (previewGeneration.current === requestId) setError(e instanceof Error ? e.message : "Unable to preview this day."); }
    finally { if (previewGeneration.current === requestId) { setPreviewLoading(false); setBusy(false); } }
  }
  async function preview() {
    if (!includedDayKeys.length || rangeLoading) return;
    setPreviewPage(null);
    await openPreviewDay(includedDayKeys[0]!);
  }
  async function checkExport() {
    if (!book || exportRevision === null) return;
    const requestId = ++requestGeneration.current, bookId = book.id, revision = exportRevision;
    try { const result = await services.fetchMemoryExport(accessToken, bookId, revision); if (requestGeneration.current !== requestId) return; setExportStatus(result.status); if (result.download_url) setExportUrl(result.download_url); setNotice(result.download_url ? "PDF is ready." : `PDF status: ${result.status}.`); }
    catch (e) { if (requestGeneration.current === requestId) setError(e instanceof Error ? e.message : "Unable to check PDF status."); }
  }
  async function remove() {
    if (!book || !window.confirm(`Delete “${book.title}”?`)) return;
    try { if (book.revision > 0) await services.deleteMemoryBook(accessToken, book.id); requestGeneration.current += 1; setBooks(value => value.filter(item => item.id !== book.id)); setBook(null); setNotice("Collection deleted."); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to delete this collection."); }
  }

  const summaryText = rangeLoading ? "Loading days in this range…" : `${includedDayKeys.length} of ${eligibleDayGroups.length} days included · ${excludedInRange.length} excluded`;
  const previewIndex = includedDayKeys.indexOf(previewDay);
  const selectedTemplate = templateCatalog.templates.find(value => value.id === book?.templateId) ?? templateCatalog.templates.find(value => value.id === "notebook-v1")!;
  const dailyPrint = selectedTemplate.dailyPrint;
  const previewStyle = {
    "--daily-accent": dailyPrint.accent,
    "--daily-note-background": dailyPrint.noteBackground,
    "--daily-note-border": dailyPrint.noteBorder,
    "--daily-photo-border": dailyPrint.photoBorder,
    "--daily-page-color": book?.pageColor || "#fffefa",
    "--daily-text-color": book?.textColor || "#43332e",
    "--daily-margin": `${book?.marginMm ?? 18}mm`,
    fontFamily: book?.bodyFont === "sans" ? "Arial, sans-serif" : "Georgia, serif",
  } as CSSProperties;
  const previewHeadingFont = book?.headingFont === "sans" ? "Arial, sans-serif" : "Georgia, serif";
  const validDraftRange = (!rangeDraft.start && !rangeDraft.end) || (!!rangeDraft.start && !!rangeDraft.end && rangeDraft.start <= rangeDraft.end);
  const displayDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" });

  return <section className="journal-page-books">
    <header className="memory-head"><div><p className="eyebrow">SAVED PAGES, GATHERED</p><h1>Memory books</h1><p>Choose a date range. Each included day becomes one page; longer days can continue across printed sheets.</p></div><div className="memory-actions"><button className="button button-secondary" disabled={busy} onClick={create}>Create a book</button><button className="button button-secondary" disabled={busy} onClick={onLegacy}>Previous books and templates</button></div></header>
    {error && <p role="alert" className="journal-editor-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy} className="journal-books-fieldset"><div className="journal-books-layout">
      <aside className="journal-book-list"><h2>Your collections</h2>{books.map(item => <button key={item.id} className={`memory-book-choice ${item.id === book?.id ? "chosen" : ""}`} onClick={() => {
        requestGeneration.current += 1; previewGeneration.current += 1; previewCache.current.clear();
        setBook(item); setRangeDraft({ start: item.dateStart ?? "", end: item.dateEnd ?? "" });
        setRangePreset(rangePresetFor(item.dateStart ?? "", item.dateEnd ?? "", item.timezone ?? "UTC"));
        setJournals([]); setRangeLoading(true); setPreviewPage(null); setPreviewDay(""); setExportRevision(null); setExportUrl(""); setExportStatus(""); setShowDayPicker(false);
      }}>{item.title}<small>{dayCount(item.entries, item.timezone ?? "UTC")} days</small></button>)}{!books.length && <p className="memory-muted">Create a collection to gather journal pages.</p>}</aside>
      {book ? <section className="journal-book-editor">
        <h2>{titleFor(book.entries)}</h2>
        <section className="journal-book-range-panel" aria-labelledby="journal-book-range-heading">
          <p className="eyebrow">STEP 1 · CHOOSE YOUR DATE RANGE</p><h3 id="journal-book-range-heading">Which days should be in this book?</h3>
          <div className="journal-range-presets" role="group" aria-label="Date range preset">
            <button type="button" aria-pressed={rangePreset === "this-month"} onClick={() => { const range = monthRange(rangeTimezone, 0); updateRange(range.start, range.end, "this-month"); }}>This month</button>
            <button type="button" aria-pressed={rangePreset === "last-month"} onClick={() => { const range = monthRange(rangeTimezone, -1); updateRange(range.start, range.end, "last-month"); }}>Last month</button>
            <button type="button" aria-pressed={rangePreset === "custom"} onClick={() => setRangePreset("custom")}>Custom</button>
          </div>
          {rangePreset === "custom" && <div className="journal-book-date-range"><label>From<input type="date" value={rangeDraft.start} onChange={e => setRangeDraft(value => ({ ...value, start: e.target.value }))}/></label><label>Through<input type="date" value={rangeDraft.end} min={rangeDraft.start || undefined} onChange={e => setRangeDraft(value => ({ ...value, end: e.target.value }))}/></label><button type="button" className="button button-secondary" disabled={!validDraftRange || rangeLoading || (rangeDraft.start === dateStart && rangeDraft.end === dateEnd)} onClick={() => updateRange(rangeDraft.start, rangeDraft.end)}>Apply range</button></div>}
          <p className="journal-book-range-count" role="status" aria-live="polite">{summaryText}</p>
          <p className="memory-muted">All ready pages in {book.timezone || "UTC"} are included automatically. You can exclude individual days below.</p>
          <div className="memory-actions journal-book-range-actions"><button className="button button-secondary" disabled={rangeLoading || busy || !includedDayKeys.length} onClick={() => void preview()}>Preview</button><button className="button" disabled={rangeLoading || busy || !includedDayKeys.length} onClick={() => void exportPdf()}>{busy ? "Preparing…" : "Generate PDF"}</button>{exportRevision !== null && <><button className="button button-secondary" onClick={() => void checkExport()}>Check PDF status</button><span>PDF status: {exportStatus}</span></>}{exportUrl && <a className="button button-secondary" href={exportUrl} target="_blank" rel="noreferrer">Download PDF</a>}</div>
        </section>

        <details className="journal-day-picker" open={showDayPicker} onToggle={event => setShowDayPicker(event.currentTarget.open)}>
          <summary>Choose days <span>{excludedInRange.length ? `${excludedInRange.length} excluded` : "All days included"}</span></summary>
          <div className="journal-day-picker-tools"><div role="group" aria-label="Filter days"><button type="button" aria-pressed={!excludedOnly} onClick={() => setExcludedOnly(false)}>All days</button><button type="button" aria-pressed={excludedOnly} onClick={() => setExcludedOnly(true)}>Excluded ({excludedInRange.length})</button></div><button type="button" className="button button-secondary" disabled={!excludedInRange.length || rangeLoading} onClick={restoreExcludedDays}>Restore all excluded</button></div>
          {rangeLoading ? <p className="memory-muted">Loading day summaries…</p> : !months.length ? <p className="memory-muted">No ready video transcripts were found in this range.</p> : <div className="journal-month-groups">{months.map(([month, days]) => {
            const monthIncluded = days.filter(([day]) => !excludedInRange.includes(day)).length;
            const monthLabel = new Date(`${month}-01T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
            const visibleDays = excludedOnly ? days.filter(([day]) => excludedInRange.includes(day)) : days;
            return <details className="journal-month-group" key={month}><summary>{monthLabel}<small>{monthIncluded} of {days.length} included</small></summary><ul className="journal-book-pages">{visibleDays.map(([day, records]) => {
              const selected = !excludedInRange.includes(day);
              return <li key={day}><label><input type="checkbox" checked={selected} aria-label={`Include ${displayDay(day)}`} onChange={event => setDaysIncluded([day], event.target.checked)}/><span><strong>{displayDay(day)}</strong><small>{records.length} recording{records.length === 1 ? "" : "s"}</small></span></label><details className="journal-day-record-list"><summary>Recordings</summary><ul>{records.map(record => <li key={record.upload_id}>{record.title}</li>)}</ul></details></li>;
            })}</ul></details>;
          })}</div>}
        </details>

        <label className="journal-highlight-toggle"><input type="checkbox" checked={book.includeHighlights === true} onChange={e => { const next = { ...book, includeHighlights: e.target.checked }; requestGeneration.current += 1; setBook(next); setBooks(value => value.map(item => item.id === next.id ? next : item)); setExportUrl(""); setExportRevision(null); setExportStatus(""); }}/> Include page highlights in the PDF</label>
        <label className="journal-book-template">Print template<select value={book.templateId ?? "notebook-v1"} onChange={e => changeTemplate(e.target.value)}>{templateCatalog.templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
        <div className="memory-actions"><button className="button button-secondary" disabled={busy || rangeLoading} onClick={() => void save()}>Save collection</button><button className="button button-secondary" disabled={busy} onClick={() => void remove()}>Delete collection</button></div>
        {previewDay && <section ref={previewRef} id="journal-book-preview" className="journal-book-preview" aria-label="Daily page preview"><div className="journal-preview-navigation"><div><p className="eyebrow">PDF PREVIEW · {includedDayKeys.length} DAYS · {selectedTemplate.name.toUpperCase()}</p><h3>{displayDay(previewDay)}{previewPage ? ` · ${previewPage.sources?.length ?? 0} recording${previewPage.sources?.length === 1 ? "" : "s"}` : ""}</h3></div><button type="button" className="button button-secondary" onClick={() => { previewGeneration.current += 1; setPreviewDay(""); setPreviewPage(null); }}>Close preview</button></div><div className="journal-preview-navigation"><button type="button" className="button button-secondary" disabled={previewIndex <= 0 || previewLoading} onClick={() => void openPreviewDay(includedDayKeys[previewIndex - 1]!)}>Previous day</button><label>Go to day<select value={previewDay} onChange={event => void openPreviewDay(event.target.value)}>{includedDayKeys.map(day => <option key={day} value={day}>{displayDay(day)}</option>)}</select></label><button type="button" className="button button-secondary" disabled={previewIndex < 0 || previewIndex >= includedDayKeys.length - 1 || previewLoading} onClick={() => void openPreviewDay(includedDayKeys[previewIndex + 1]!)}>Next day</button></div>{previewLoading && <p role="status">Loading this day…</p>}{previewPage && <article className={`journal-a4-preview journal-day-preview template-${dailyPrint.treatment} ${book.includeHighlights === true && previewPage.highlightPage ? "is-page-highlight" : ""}`} style={{ ...previewStyle, "--daily-heading-font": previewHeadingFont } as CSSProperties}><header><strong>{displayDay(previewDay)}</strong></header>{previewBlocks(previewPage, previewPhotos, book.includeHighlights === true)}</article>}</section>}
      </section> : <div className="memory-empty">Create a new collection and choose a date range.</div>}
    </div></fieldset>
  </section>;
}

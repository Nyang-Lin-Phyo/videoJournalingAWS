import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useCloudEnvironment } from "./CloudEnvironment";
import type { JournalPage, JournalPageBlock, MemoryPhoto } from "./analysisApi";

type Gesture = {
  id: string; mode: "move" | "resize" | "rotate"; edge?: string; pointerId: number;
  startX: number; startY: number; x: number; y: number; width: number; height: number; frameWidth: number;
  rotation: number; centerX: number; centerY: number; startAngle: number;
};
const defaultWidth = (block: JournalPageBlock) => block.widthPercent ?? (block.width === "half" ? 50 : block.width === "wide" ? 75 : 100);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function uniqueBlockId(blocks: JournalPageBlock[]) {
  let id = crypto.randomUUID();
  while (blocks.some(block => block.id === id)) id = `${id}-${blocks.length + 1}`;
  return id;
}

export function JournalPageEditor({ dayKey, timezone, onBack }: { dayKey: string; timezone: string; onBack: () => void }) {
  const { accessToken, services } = useCloudEnvironment();
  const [page, setPage] = useState<JournalPage | null>(null);
  const [photos, setPhotos] = useState<MemoryPhoto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selection, setSelection] = useState<{ id: string; start: number; end: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [optionsId, setOptionsId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([services.fetchDailyPage(accessToken, dayKey, timezone), services.fetchMemoryPhotos(accessToken).catch(() => [])])
      .then(([loaded, library]) => {
        if (!live) return;
        const normalized = loaded.blocks.some(block => block.kind === "text" && block.id.startsWith("source-"))
          ? { ...loaded, blocks: loaded.blocks.map(block => block.kind === "text" && block.id.startsWith("source-") ? { ...block, source: true } : block) }
          : loaded;
        setPage(normalized); setPhotos(library); setError("");
      })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Unable to load this page."); });
    return () => { live = false; };
  }, [accessToken, dayKey, services, timezone, reloadKey]);

  if (!page) return <section className="journal-page-editor"><button className="button button-secondary" onClick={onBack}>Back to history</button>{error ? <p role="alert">{error}</p> : <p>Opening your page…</p>}</section>;
  const pageSnapshot = page;
  const photoUrl = (id: string) => photos.find(photo => photo.photo_id === id && photo.status === "complete")?.url;
  const update = (id: string, change: (block: JournalPageBlock) => JournalPageBlock) => setPage(current => current ? ({ ...current, blocks: current.blocks.map(block => block.id === id ? change(block) : block) }) : current);
  const move = (index: number, direction: -1 | 1) => setPage(current => {
    if (!current) return current;
    const blocks = [...current.blocks], target = index + direction;
    if (target < 0 || target >= blocks.length) return current;
    [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!];
    return { ...current, blocks };
  });

  function startGesture(id: string, mode: Gesture["mode"], event: ReactPointerEvent<HTMLElement>, edge?: string) {
    if (busy) return;
    const block = page.blocks.find(value => value.id === id);
    if (!block) return;
    event.stopPropagation();
    const target = event.currentTarget;
    if ("setPointerCapture" in target) (target as HTMLElement).setPointerCapture(event.pointerId);
    const frameElement = document.getElementById(`journal-frame-${id}`);
    const frame = frameElement?.getBoundingClientRect();
    const centerX = frame ? frame.left + frame.width / 2 : event.clientX;
    const centerY = frame ? frame.top + frame.height / 2 : event.clientY;
    gesture.current = {
      id, mode, edge, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: block.x ?? 0, y: block.y ?? 0, width: defaultWidth(block), height: block.heightMm ?? Math.round((frameElement?.offsetHeight ?? 180) / 3.78),
      frameWidth: frameElement?.offsetWidth ?? 500,
      rotation: block.rotation ?? 0, centerX, centerY,
      startAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI,
    };
    setSelectedId(id);
  }
  function updateGesture(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX, dy = event.clientY - active.startY;
    if (active.mode === "move") {
      update(active.id, block => ({ ...block, x: clamp(active.x + Math.round(dx / 3.78), -80, 80), y: clamp(active.y + Math.round(dy / 3.78), -80, 80) }));
    } else if (active.mode === "resize") {
      const edge = active.edge ?? "se";
      const left = edge.includes("w"), right = edge.includes("e"), top = edge.includes("n"), bottom = edge.includes("s");
      const radians = active.rotation * Math.PI / 180;
      const localDx = dx * Math.cos(radians) + dy * Math.sin(radians);
      const localDy = -dx * Math.sin(radians) + dy * Math.cos(radians);
      const width = clamp(active.width + (right ? 1 : left ? -1 : 0) * localDx / Math.max(1, active.frameWidth) * 100, 20, 100);
      const height = clamp(active.height + (bottom ? 1 : top ? -1 : 0) * localDy / 3.78, 15, 260);
      const x = clamp(active.x + (left ? localDx * Math.cos(radians) : 0) / 3.78 - (top ? localDy * Math.sin(radians) : 0) / 3.78, -80, 80);
      const y = clamp(active.y + (left ? localDx * Math.sin(radians) : 0) / 3.78 + (top ? localDy * Math.cos(radians) : 0) / 3.78, -80, 80);
      update(active.id, block => ({ ...block, widthPercent: Math.round(width), heightMm: Math.round(height), x: Math.round(x), y: Math.round(y) }));
    } else {
      const angle = Math.atan2(event.clientY - active.centerY, event.clientX - active.centerX) * 180 / Math.PI;
      let delta = angle - active.startAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      update(active.id, block => ({ ...block, rotation: clamp(active.rotation + Math.round(delta), -30, 30) }));
    }
  }
  function endGesture(event: ReactPointerEvent<HTMLElement>) {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  }

  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await services.saveDailyPage(accessToken, dayKey, timezone, { revision: pageSnapshot.revision, blocks: pageSnapshot.blocks, highlightPage: pageSnapshot.highlightPage });
      setPage(saved); setNotice("Page saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save this page."); }
    finally { setBusy(false); }
  }
  async function addPhoto(file?: File) {
    if (!file) return;
    setUploading(true); setError("");
    try {
      const photoId = await services.uploadMemoryPhoto(accessToken, file);
      const library = await services.fetchMemoryPhotos(accessToken); setPhotos(library);
      setPage(current => current ? ({ ...current, blocks: [...current.blocks, { id: uniqueBlockId(current.blocks), kind: "image", width: "wide", photoId }] }) : current);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to add photo."); }
    finally { setUploading(false); }
  }
  function markSelection(id: string) {
    const active = selection?.id === id ? selection : null;
    const area = document.getElementById(`journal-block-${id}`) as HTMLTextAreaElement | null;
    const selected = active ? area?.value.slice(active.start, active.end) : "";
    if (!selected?.trim()) { setError("Select a sentence in added text first."); return; }
    update(id, block => block.kind === "text" ? { ...block, highlight: selected } : block);
    setSelection(null); setNotice("Sentence marked as a highlight. Save the page to keep it."); setError("");
  }
  function deleteBlock(id: string) {
    const block = page.blocks.find(value => value.id === id);
    if (!block || (block.kind === "text" && block.source)) return;
    setPage(current => current ? ({ ...current, blocks: current.blocks.filter(value => value.id !== id) }) : current);
    setOptionsId(null); setSelectedId(null);
  }

  return <section className="journal-page-editor">
    <div className="journal-editor-top"><button className="button button-secondary" onClick={onBack}>← Journal history</button><span>DAY {page.revision ? `REVISION ${page.revision}` : "DRAFT"}</span><button type="button" className="button button-secondary" disabled={busy || uploading} onClick={() => setReloadKey(value => value + 1)}>Refresh recordings</button></div>
    <div className="journal-editor-heading"><p className="eyebrow">YOUR DAILY PAGE</p><h1>{new Date(page.date).toLocaleDateString(undefined, { dateStyle: "long", timeZone: timezone })}</h1><p>{page.sources?.length ?? 0} recording{page.sources?.length === 1 ? "" : "s"} combined · Arrange the whole day here. Original transcript text stays locked.</p>{!!page.sources?.length && <ul className="journal-day-sources">{page.sources.map(source => <li key={source.id}>{source.title} <time>{new Date(source.date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: timezone })}</time></li>)}</ul>}</div>
    <div className="journal-editor-actions"><label><input type="checkbox" checked={page.highlightPage} disabled={busy} onChange={e => setPage({ ...page, highlightPage: e.target.checked })}/> Mark this whole page as a highlight</label><label className="button button-secondary">Add a private photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading || busy} onChange={e => { void addPhoto(e.target.files?.[0]); e.currentTarget.value = ""; }}/></label><button className="button button-primary" disabled={busy || uploading} onClick={() => void save()}>{busy ? "Saving…" : "Save page"}</button></div>
    <p className="journal-canvas-hint">Drag a box by its border to move it. Side handles change width or height; corner handles change both. Text stays visible as the box grows. Drag R to rotate. Double-click a border or choose More options for style and delete controls.</p>
    {error && <p className="journal-editor-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <article className={`journal-a4-preview journal-design-canvas ${page.highlightPage ? "is-page-highlight" : ""}`} aria-label="Journal page design canvas">
      <header><strong>{page.title}</strong><time>{new Date(page.date).toLocaleDateString(undefined, { dateStyle: "long" })}</time></header>
      <fieldset disabled={busy} className="journal-canvas-fieldset">
      <div className="journal-page-blocks">
        {page.blocks.map((block, index) => {
          const selected = selectedId === block.id;
          const optionsOpen = optionsId === block.id;
          const width = defaultWidth(block);
          const source = block.kind === "text" && block.source ? page.sources?.find(value => value.id === block.sourceJournalId) : undefined;
          const firstSourceBlock = !!source && !page.blocks.slice(0, index).some(value => value.kind === "text" && value.source && value.sourceJournalId === source.id);
          return <div className="journal-block-wrap" key={block.id}>
            <section id={`journal-frame-${block.id}`} className={`journal-page-block journal-design-block width-${block.width} ${selected ? "is-selected" : ""} ${block.kind === "text" && block.style === "note" ? "is-note" : ""}`}
              tabIndex={0} role="group" aria-label={`${block.kind === "text" ? (block.source ? "Original transcript box" : "Added text box") : "Photo box"} ${index + 1}`}
              style={{ width: `${width}%`, minHeight: block.heightMm ? `${block.heightMm}mm` : undefined, transform: `translate(${block.x ?? 0}mm, ${block.y ?? 0}mm) rotate(${block.rotation ?? 0}deg)` }}
              onClick={() => setSelectedId(block.id)} onFocus={() => setSelectedId(block.id)}
              onKeyDown={e => { if (busy || e.target !== e.currentTarget) return; const step = e.shiftKey ? 5 : 1; const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0; const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0; if (dx || dy) { e.preventDefault(); update(block.id, value => ({ ...value, x: clamp((value.x ?? 0) + dx, -80, 80), y: clamp((value.y ?? 0) + dy, -80, 80) })); } }}
              onPointerDown={e => { if (e.target === e.currentTarget) startGesture(block.id, "move", e); }}
              onPointerMove={updateGesture} onPointerUp={endGesture} onPointerCancel={endGesture}
              onDoubleClick={e => { if (e.target === e.currentTarget) { e.preventDefault(); setSelectedId(block.id); setOptionsId(block.id); } }}>
              {firstSourceBlock && <div className="journal-source-block-heading">{source?.title}</div>}
              {selected && <>
                <button type="button" className="journal-design-handle journal-rotate-handle" aria-label={`Rotate ${block.kind === "text" ? "text box" : "photo"}`} title="Drag to rotate" onPointerDown={e => startGesture(block.id, "rotate", e)} onPointerMove={updateGesture} onPointerUp={endGesture} onPointerCancel={endGesture}>R</button>
                {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map(edge => <button key={edge} type="button" className={`journal-design-handle journal-edge-${edge}`} aria-label={`Resize ${edge} edge`} title={edge.length === 2 ? "Drag corner to change width and height" : "Drag edge to change width or height"} onPointerDown={e => startGesture(block.id, "resize", e, edge)} onPointerMove={updateGesture} onPointerUp={endGesture} onPointerCancel={endGesture}/>) }
              </>}
              {block.kind === "text" ? <>
                {block.source ? <p id={`journal-block-${block.id}`} className="journal-transcript-source" style={{ fontSize: `${block.fontSize ?? 16}px` }}>{block.text}</p> : <textarea id={`journal-block-${block.id}`} aria-label={`Added text ${index + 1}`} value={block.text} onChange={e => { const changed = e.target.value; update(block.id, value => value.kind === "text" ? { ...value, text: changed, highlight: value.highlight && !changed.includes(value.highlight) ? undefined : value.highlight } : value); setSelection({ id: block.id, start: e.target.selectionStart, end: e.target.selectionEnd }); }} onSelect={e => setSelection({ id: block.id, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} className={block.style === "note" ? "journal-note-text" : ""} style={{ fontSize: `${block.fontSize ?? 16}px` }} />}
                {block.source && <span className="journal-source-lock" aria-label="Transcript text is locked">Transcript locked</span>}
                {!block.source && block.highlight && <p className="journal-highlight-chip">Highlighted: <mark>{block.highlight}</mark> <button type="button" onClick={() => update(block.id, value => value.kind === "text" ? { ...value, highlight: undefined } : value)}>Clear</button></p>}
              </> : <figure className={block.highlight ? "is-photo-highlight" : ""}>{photoUrl(block.photoId) ? <img src={photoUrl(block.photoId)} alt={block.caption || "Private journal photo"}/> : <div className="journal-photo-pending">Private photo</div>}<figcaption><input aria-label="Photo caption" placeholder="Add a caption" value={block.caption ?? ""} onChange={e => update(block.id, value => value.kind === "image" ? { ...value, caption: e.target.value } : value)}/></figcaption></figure>}
              {selected && <button type="button" className="journal-more-options" aria-expanded={optionsOpen} aria-controls={`journal-options-${block.id}`} onClick={() => setOptionsId(optionsOpen ? null : block.id)}>More options</button>}
              {selected && optionsOpen && <div id={`journal-options-${block.id}`} className="journal-options-panel" role="group" aria-label={`Options for ${block.kind === "text" ? "text box" : "photo"}`}>
                {block.kind === "text" && <label>Text style<select aria-label="Paragraph style" value={block.style ?? "paragraph"} onChange={e => update(block.id, value => value.kind === "text" ? { ...value, style: e.target.value as "paragraph" | "note" } : value)}><option value="paragraph">Paragraph</option><option value="note">Note</option></select></label>}
                <label>Width<input aria-label="Text box width" type="range" min="20" max="100" value={width} onChange={e => update(block.id, value => ({ ...value, widthPercent: Number(e.target.value) }))}/></label>
                <label>Minimum height<input aria-label="Text box minimum height" type="range" min="15" max="260" value={block.heightMm ?? Math.round((document.getElementById(`journal-frame-${block.id}`)?.offsetHeight ?? 180) / 3.78)} onChange={e => update(block.id, value => ({ ...value, heightMm: Number(e.target.value) }))}/></label>
                {block.kind === "text" && <label>Text size<input aria-label="Text size" type="range" min="10" max="32" value={block.fontSize ?? 16} onChange={e => update(block.id, value => value.kind === "text" ? { ...value, fontSize: Number(e.target.value) } : value)}/></label>}
                <label>Rotation<input aria-label="Rotation angle" type="range" min="-30" max="30" value={block.rotation ?? 0} onChange={e => update(block.id, value => ({ ...value, rotation: Number(e.target.value) }))}/></label>
                <label>Left / right<input aria-label="Horizontal position" type="number" min="-80" max="80" value={block.x ?? 0} onChange={e => update(block.id, value => ({ ...value, x: clamp(Number(e.target.value) || 0, -80, 80) }))}/></label>
                <label>Up / down<input aria-label="Vertical position" type="number" min="-80" max="80" value={block.y ?? 0} onChange={e => update(block.id, value => ({ ...value, y: clamp(Number(e.target.value) || 0, -80, 80) }))}/></label>
                <div className="journal-options-actions"><button type="button" disabled={index === 0} onClick={() => move(index, -1)}>Move earlier</button><button type="button" disabled={index === page.blocks.length - 1} onClick={() => move(index, 1)}>Move later</button>{block.kind === "text" && !block.source && <button type="button" onClick={() => markSelection(block.id)}>Highlight selection</button>}{!(block.kind === "text" && block.source) && <button type="button" className="journal-delete-block" aria-label={`Delete ${block.kind === "text" ? "added text" : "photo"}`} onClick={() => deleteBlock(block.id)}>{"\u{1F5D1}"} Delete</button>}</div>
              </div>}
            </section>
          </div>;
        })}
      </div>
      <button type="button" className="journal-add-paragraph" onClick={() => { const id = uniqueBlockId(page.blocks); setPage(current => current ? ({ ...current, blocks: [...current.blocks, { id, kind: "text", width: "full", widthPercent: 100, text: "", fontSize: 16 }] }) : current); setSelectedId(null); setOptionsId(null); }}>+ Add text</button>
      </fieldset>
    </article>
    <details className="journal-source"><summary>View original transcript</summary><pre>{page.originalText ?? "Original transcript is unavailable."}</pre></details>
  </section>;
}

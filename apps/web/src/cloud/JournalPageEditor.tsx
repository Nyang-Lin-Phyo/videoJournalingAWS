import "./journal-editor-v2.css";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useCloudEnvironment } from "./CloudEnvironment";
import type { JournalPage, JournalPageBlock, MemoryPhoto } from "./analysisApi";
import { constrainDrag, correctionToBounds } from "./journalCanvasGeometry";
import { addFrontLayer, layersFrontToBack, moveLayerToIndex, normalizeLayers, nudgeLayer } from "./journalLayering";

type Gesture = {
  id: string; mode: "move" | "resize" | "rotate"; edge?: string; pointerId: number;
  startX: number; startY: number; x: number; y: number; width: number; height: number;
  frameWidth: number; rotation: number; centerX: number; centerY: number; startAngle: number;
  rect: DOMRect; bounds: DOMRect;
};
type LayerPointerDrag = {
  id: string;
  pointerId: number;
  originY: number;
  y: number;
  grabOffsetY: number;
  left: number;
  width: number;
  height: number;
  active: boolean;
  settling: boolean;
  settleY: number;
  originalOrder: string[];
  name: string;
  icon: string;
};
const LAYER_DRAG_THRESHOLD = 5;
const LAYER_SETTLE_MS = 190;
const MM = 96 / 25.4;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const X_LIMIT = 180, Y_LIMIT = 300;
const defaultWidth = (block: JournalPageBlock) => block.widthPercent ?? (block.width === "half" ? 50 : block.width === "wide" ? 75 : 100);
const blockIsSource = (block: JournalPageBlock) => block.kind === "text" && block.source === true;
const fallbackName = (block: JournalPageBlock, index: number) => block.kind === "image" ? `Photo ${index + 1}` : block.source ? `Transcript ${index + 1}` : `Text box ${index + 1}`;
const boxName = (block: JournalPageBlock, index: number) => block.name?.trim() || fallbackName(block, index);
/** Match a flowing transcript paragraph: the textarea grows instead of scrolling internally.
 * Measure after the DOM value and wrapping width are current, including after React updates. */
function fitNote(node: HTMLTextAreaElement | null) {
  if (!node) return;
  node.style.height = "auto";
  node.style.height = `${Math.max(40, node.scrollHeight)}px`;
  node.scrollTop = 0;
}


function uniqueBlockId(blocks: JournalPageBlock[]) {
  let id = crypto.randomUUID();
  while (blocks.some(block => block.id === id)) id = `${id}-${blocks.length + 1}`;
  return id;
}

/** Drag the label left/right like an inspector's scrub control; click the number for exact values. */
function ScrubField({ label, value, min, max, unit, onChange, onReset }: {
  label: string; value: number; min: number; max: number; unit: string; onChange: (n: number) => void; onReset: () => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; value: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);
  const scrub = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, value, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = event.clientX - current.x;
    if (Math.abs(delta) > 2) current.moved = true;
    if (current.moved) onChange(clamp(Math.round(current.value + delta * (event.shiftKey ? 0.1 : 0.45)), min, max));
  };
  return <div className="journal-scrub-field">
    <button type="button" className="journal-scrub-label" title={`Drag horizontally to change ${label.toLowerCase()}`} aria-label={`Scrub ${label.toLowerCase()}`} onPointerDown={scrub} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>{label}<span aria-hidden="true"> ↔</span></button>
    <div className="journal-scrub-value"><div className="journal-scrub-number"><input type="number" aria-label={label} min={min} max={max} step="1" value={draft} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; if (draft !== "" && Number.isFinite(Number(draft))) onChange(clamp(Math.round(Number(draft)), min, max)); setDraft(String(Number.isFinite(Number(draft)) ? clamp(Math.round(Number(draft)), min, max) : value)); }} onChange={e => { setDraft(e.target.value); if (e.target.value !== "" && e.target.value !== "-" && Number.isFinite(Number(e.target.value))) onChange(clamp(Math.round(Number(e.target.value)), min, max)); }}/><span aria-hidden="true">{unit}</span></div><button type="button" className="journal-field-reset" title={`Reset ${label.toLowerCase()}`} aria-label={`Reset ${label.toLowerCase()}`} onClick={onReset}>↺</button></div>
  </div>;
}

export function JournalPageEditor({ dayKey, timezone, onBack }: { dayKey: string; timezone: string; onBack: () => void }) {
  const { accessToken, services, isPreview } = useCloudEnvironment();
  const [page, setPage] = useState<JournalPage | null>(null);
  const [photos, setPhotos] = useState<MemoryPhoto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selection, setSelection] = useState<{ id: string; start: number; end: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Selection and text editing are separate, as in a slide editor.
  // Click-and-drag moves a box; double-click unlocks only the added note.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"properties" | "layers">("properties");
  const layerListRef = useRef<HTMLOListElement>(null);
  const layerPointer = useRef<LayerPointerDrag | null>(null);
  const layerOrder = useRef<string[]>([]);
  const beforeLayerReorder = useRef<Map<string, number> | null>(null);
  const [layerOverlay, setLayerOverlay] = useState<LayerPointerDrag | null>(null);
  const layerSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const retryPhotos = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    void Promise.all([services.fetchDailyPage(accessToken, dayKey, timezone), services.fetchMemoryPhotos(accessToken).catch(() => [])])
      .then(([loaded, library]) => {
        if (!live) return;
        const normalized = loaded.blocks.some(block => block.kind === "text" && block.id.startsWith("source-"))
          ? { ...loaded, blocks: loaded.blocks.map(block => block.kind === "text" && block.id.startsWith("source-") ? { ...block, source: true } : block) }
          : loaded;
        setPage({ ...normalized, blocks: normalizeLayers(normalized.blocks) }); setPhotos(library); retryPhotos.current.clear(); setError("");
      })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Unable to load this page."); });
    return () => { live = false; };
  }, [accessToken, dayKey, services, timezone, reloadKey]);

  // A callback ref only runs when a textarea mounts. Refit after *every* content,
  // font-size or box-width change too; otherwise typing reveals a small internal viewport.
  useLayoutEffect(() => {
    canvasRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea.journal-editable-paragraph").forEach(fitNote);
  }, [page?.blocks]);

  // Focus an added note when the user double-clicks it (or inserts a new one).
  useEffect(() => {
    if (!editingId) return;
    const field = document.getElementById(`journal-block-${editingId}`) as HTMLTextAreaElement | null;
    field?.focus({ preventScroll: true });
  }, [editingId]);

  // Editing stays active until the user clicks *outside* this box. Clicking the
  // note again must never unexpectedly start moving it while typing.
  useEffect(() => {
    if (!editingId) return;
    const leaveEditOnOutsidePress = (event: PointerEvent) => {
      const frame = document.getElementById(`journal-frame-${editingId}`);
      if (event.target instanceof Node && !frame?.contains(event.target)) setEditingId(null);
    };
    document.addEventListener("pointerdown", leaveEditOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", leaveEditOnOutsidePress, true);
  }, [editingId]);

  // The paper column can change width when the window or sidebar changes size.
  // Reflow every note at that new width, without triggering a state update per keystroke.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    let previousWidth = canvas.getBoundingClientRect().width;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width ?? previousWidth;
      if (nextWidth > 0 && Math.abs(nextWidth - previousWidth) > 0.5) {
        previousWidth = nextWidth;
        canvas.querySelectorAll<HTMLTextAreaElement>("textarea.journal-editable-paragraph").forEach(fitNote);
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [page?.date]);

  useLayoutEffect(() => {
    layerOrder.current = page ? layersFrontToBack(page.blocks).map(block => block.id) : [];
  }, [page?.blocks]);

  // FLIP: glide all neighbors from their previous on-screen positions into the
  // new layer order. The moving row remains a dashed placeholder until release.
  useLayoutEffect(() => {
    const previous = beforeLayerReorder.current;
    if (!previous) return;
    beforeLayerReorder.current = null;
    const list = layerListRef.current;
    if (!list) return;
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.querySelectorAll<HTMLElement>("li[data-layer-id]").forEach(row => {
      const start = previous.get(row.dataset.layerId || "");
      if (start === undefined || typeof row.animate !== "function") return;
      const oldAnimations = row.getAnimations?.() ?? [];
      const now = row.getBoundingClientRect().top;
      oldAnimations.forEach(animation => animation.cancel());
      const finish = row.getBoundingClientRect().top;
      const distance = start - finish || now - finish;
      if (Math.abs(distance) > 0.5 && !reduceMotion) {
        row.animate([{ transform: `translateY(${distance}px)` }, { transform: "translateY(0px)" }],
          { duration: 190, easing: "cubic-bezier(.2,.82,.24,1)" });
      }
    });
  }, [page?.blocks]);

  useEffect(() => () => { if (layerSettleTimer.current) clearTimeout(layerSettleTimer.current); }, []);

  // Correct the *measured, rotated* rectangle after resize, rotation and layout changes.
  // Using its bounding box rather than only x/y means even angled corners stay on the page.
  useLayoutEffect(() => {
    if (!page || gesture.current?.mode === "move") return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const corrections = new Map<string, { x: number; y: number; widthPercent?: number }>();
    for (const block of page.blocks) {
      const element = document.getElementById(`journal-frame-${block.id}`);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) continue; // e.g. JSDOM, before layout
      const maxWidth = Math.max(40, bounds.width - 14);
      if (rect.width > maxWidth + 1 && defaultWidth(block) > 20) {
        corrections.set(block.id, { x: block.x ?? 0, y: block.y ?? 0, widthPercent: clamp(Math.floor(defaultWidth(block) * maxWidth / rect.width) - 1, 20, 100) });
        continue;
      }
      const correction = correctionToBounds(rect, bounds, 7);
      if (Math.abs(correction.dx) >= MM * 0.55 || Math.abs(correction.dy) >= MM * 0.55) {
        corrections.set(block.id, { x: clamp(Math.round((block.x ?? 0) + correction.dx / MM), -X_LIMIT, X_LIMIT), y: clamp(Math.round((block.y ?? 0) + correction.dy / MM), -Y_LIMIT, Y_LIMIT) });
      }
    }
    if (corrections.size) setPage(current => current ? {
      ...current, blocks: current.blocks.map(block => corrections.has(block.id) ? { ...block, ...corrections.get(block.id)! } : block),
    } : current);
  }, [page]);

  if (!page) return <section className="journal-page-editor"><button className="button button-secondary" onClick={onBack}>Back to history</button>{error ? <p role="alert">{error}</p> : <p>Opening your page…</p>}</section>;
  const pageSnapshot = page;
  const selectedBlock = page.blocks.find(block => block.id === selectedId);
  const rankedLayers = layersFrontToBack(page.blocks);
  const photoUrl = (id: string) => photos.find(photo => photo.photo_id === id && photo.status === "complete")?.url;
  const update = (id: string, change: (block: JournalPageBlock) => JournalPageBlock) => setPage(current => current ? ({ ...current, blocks: current.blocks.map(block => block.id === id ? change(block) : block) }) : current);
  function beginLayerDrag(event: ReactPointerEvent<HTMLElement>, block: JournalPageBlock, position: number) {
    if (busy || event.button !== 0 || layerPointer.current) return;
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    const list = layerListRef.current;
    if (layerSettleTimer.current) { clearTimeout(layerSettleTimer.current); layerSettleTimer.current = null; }
    setLayerOverlay(null);
    const row = (event.currentTarget as HTMLElement).closest<HTMLElement>("li[data-layer-id]");
    if (!list || !row) return;
    const rect = row.getBoundingClientRect();
    // Capture on the stable list, not on the row that React will reorder.
    if (typeof list.setPointerCapture === "function") list.setPointerCapture(event.pointerId);
    layerPointer.current = {
      id: block.id, pointerId: event.pointerId, originY: event.clientY, y: event.clientY,
      grabOffsetY: event.clientY - rect.top, left: rect.left, width: rect.width, height: rect.height,
      active: false, settling: false, settleY: 0,
      originalOrder: rankedLayers.map(item => item.id),
      name: boxName(block, position), icon: block.kind === "image" ? "▧" : block.source ? "▤" : "T",
    };
    setSelectedId(block.id);
    event.preventDefault();
  }

  // Replace native HTML5 drag-and-drop (which uses a lagging browser ghost) with
  // a pointer-following floating layer and live insertion when row centers cross.
  function moveLayerPointer(event: ReactPointerEvent<HTMLOListElement>) {
    const drag = layerPointer.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.settling) return;
    if (!drag.active && Math.abs(event.clientY - drag.originY) < LAYER_DRAG_THRESHOLD) return;
    drag.active = true;
    drag.y = event.clientY;
    event.preventDefault();
    setLayerOverlay({ ...drag });

    const list = layerListRef.current;
    if (!list) return;
    // Keep working on a long, scrollable Layers list, including on touch devices.
    const listRect = list.getBoundingClientRect();
    if (list.scrollHeight > list.clientHeight && list.clientHeight > 0) {
      if (event.clientY > listRect.bottom - 28) list.scrollTop += 12;
      else if (event.clientY < listRect.top + 28) list.scrollTop -= 12;
    }
    const centerY = event.clientY - drag.grabOffsetY + drag.height / 2;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("li[data-layer-id]"));
    // offsetTop ignores the smooth FLIP animation. This prevents bouncing when
    // the next row slides underneath the floating layer.
    const candidate = rows.filter(row => row.dataset.layerId !== drag.id).reduce((count, row) => {
      const middle = listRect.top + row.offsetTop - list.scrollTop + row.offsetHeight / 2;
      return count + (centerY > middle ? 1 : 0);
    }, 0);
    const currentIndex = layerOrder.current.indexOf(drag.id);
    if (currentIndex < 0 || candidate === currentIndex) return;
    const before = new Map<string, number>();
    rows.forEach(row => {
      if (row.dataset.layerId && row.dataset.layerId !== drag.id) before.set(row.dataset.layerId, row.getBoundingClientRect().top);
    });
    beforeLayerReorder.current = before;
    const nextOrder = [...layerOrder.current];
    nextOrder.splice(currentIndex, 1);
    nextOrder.splice(candidate, 0, drag.id);
    layerOrder.current = nextOrder;
    setPage(current => current ? { ...current, blocks: moveLayerToIndex(current.blocks, drag.id, candidate) } : current);
  }

  function endLayerDrag(event: ReactPointerEvent<HTMLOListElement>, cancelled = false) {
    const drag = layerPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    layerPointer.current = null;
    const list = layerListRef.current;
    if (list && typeof list.hasPointerCapture === "function" && list.hasPointerCapture(event.pointerId)) {
      list.releasePointerCapture(event.pointerId);
    }
    if (cancelled) {
      // A cancelled touch gesture should not quietly change the saved layout.
      setPage(current => {
        if (!current) return current;
        const order = drag.originalOrder;
        const ranks = new Map(order.map((id, index) => [id, index + 1]));
        return { ...current, blocks: current.blocks.map(block => ({ ...block, layer: ranks.get(block.id) ?? block.layer })) };
      });
      layerOrder.current = drag.originalOrder;
      setLayerOverlay(null);
      return;
    }
    if (!drag.active) { setLayerOverlay(null); return; }
    const destination = Array.from(list?.querySelectorAll<HTMLElement>("li[data-layer-id]") ?? [])
      .find(row => row.dataset.layerId === drag.id);
    const settleY = destination ? destination.getBoundingClientRect().top - (drag.y - drag.grabOffsetY) : 0;
    setLayerOverlay({ ...drag, settling: true, settleY });
    if (layerSettleTimer.current) clearTimeout(layerSettleTimer.current);
    layerSettleTimer.current = setTimeout(() => { setLayerOverlay(null); layerSettleTimer.current = null; }, LAYER_SETTLE_MS);
  }

  function cancelLayerDrag() {
    const drag = layerPointer.current;
    if (!drag) return;
    const list = layerListRef.current;
    if (list && typeof list.hasPointerCapture === "function" && list.hasPointerCapture(drag.pointerId)) {
      list.releasePointerCapture(drag.pointerId);
    }
    layerPointer.current = null;
    setPage(current => {
      if (!current) return current;
      const ranks = new Map(drag.originalOrder.map((id, index) => [id, index + 1]));
      return { ...current, blocks: current.blocks.map(block => ({ ...block, layer: ranks.get(block.id) ?? block.layer })) };
    });
    layerOrder.current = drag.originalOrder;
    setLayerOverlay(null);
  }

  function nudge(id: string, direction: -1 | 1) {
    setPage(current => current ? ({ ...current, blocks: nudgeLayer(current.blocks, id, direction) }) : current);
  }

  function startGesture(id: string, mode: Gesture["mode"], event: ReactPointerEvent<HTMLElement>, edge?: string) {
    if (busy || event.button !== 0) return;
    const block = pageSnapshot.blocks.find(value => value.id === id);
    const frameElement = document.getElementById(`journal-frame-${id}`);
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!block || !frameElement || !bounds) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = frameElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
    gesture.current = {
      id, mode, edge, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: block.x ?? 0, y: block.y ?? 0, width: defaultWidth(block),
      height: block.heightMm ?? Math.round(frameElement.offsetHeight / MM),
      frameWidth: canvasRef.current?.clientWidth ?? 500, rotation: block.rotation ?? 0,
      centerX, centerY, startAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI,
      rect, bounds,
    };
    setSelectedId(id);
  }
  function updateGesture(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX, dy = event.clientY - active.startY;
    if (active.mode === "move") {
      const bounded = constrainDrag(active.rect, active.bounds, dx, dy, 7);
      update(active.id, block => ({ ...block, x: clamp(Math.round(active.x + bounded.dx / MM), -X_LIMIT, X_LIMIT), y: clamp(Math.round(active.y + bounded.dy / MM), -Y_LIMIT, Y_LIMIT) }));
    } else if (active.mode === "resize") {
      const edge = active.edge ?? "se";
      const left = edge.includes("w"), right = edge.includes("e"), top = edge.includes("n"), bottom = edge.includes("s");
      const radians = active.rotation * Math.PI / 180;
      const localDx = dx * Math.cos(radians) + dy * Math.sin(radians);
      const localDy = -dx * Math.sin(radians) + dy * Math.cos(radians);
      const width = clamp(active.width + (right ? 1 : left ? -1 : 0) * localDx / Math.max(1, active.frameWidth) * 100, 20, 100);
      const height = clamp(active.height + (bottom ? 1 : top ? -1 : 0) * localDy / MM, 15, 260);
      update(active.id, block => ({ ...block, widthPercent: Math.round(width), heightMm: Math.round(height),
        x: clamp(Math.round(active.x + (left ? localDx * Math.cos(radians) : 0) / MM - (top ? localDy * Math.sin(radians) : 0) / MM), -X_LIMIT, X_LIMIT),
        y: clamp(Math.round(active.y + (left ? localDx * Math.sin(radians) : 0) / MM + (top ? localDy * Math.cos(radians) : 0) / MM), -Y_LIMIT, Y_LIMIT),
      }));
    } else {
      const angle = Math.atan2(event.clientY - active.centerY, event.clientX - active.centerX) * 180 / Math.PI;
      let delta = angle - active.startAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      let value = clamp(Math.round(active.rotation + delta), -30, 30);
      if (event.shiftKey) value = Math.round(value / 15) * 15;
      else if (Math.abs(value) < 3) value = 0;
      update(active.id, block => ({ ...block, rotation: value }));
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
  async function refreshPhotos() {
    const library = await services.fetchMemoryPhotos(accessToken);
    setPhotos(library);
    retryPhotos.current.clear();
  }
  async function addPhoto(file?: File) {
    if (!file) return;
    setUploading(true); setError(""); setNotice("");
    try {
      const photoId = await services.uploadMemoryPhoto(accessToken, file);
      const library = await services.fetchMemoryPhotos(accessToken);
      // The list uses an eventually consistent index; a newly finalized photo can lag behind.
      if (!library.some(photo => photo.photo_id === photoId)) {
        const single = await services.fetchMemoryPhoto(accessToken, photoId);
        library.unshift(single);
      }
      setPhotos(library);
      const id = crypto.randomUUID();
      setPage(current => current ? ({ ...current, blocks: addFrontLayer(current.blocks, { id, kind: "image", width: "wide", photoId, heightMm: 80 }) }) : current);
      setSelectedId(id);
      setNotice(isPreview ? "Photo added to this local preview. Save the page to keep its placement." : "Private photo uploaded. Save the page to keep its placement.");
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
    const block = pageSnapshot.blocks.find(value => value.id === id);
    if (!block || blockIsSource(block)) return;
    setPage(current => current ? ({ ...current, blocks: current.blocks.filter(value => value.id !== id) }) : current);
    setSelectedId(null); setEditingId(null);
  }
  function addText() {
    const id = uniqueBlockId(pageSnapshot.blocks);
    setPage(current => current ? ({ ...current, blocks: addFrontLayer(current.blocks, { id, kind: "text", width: "wide", widthPercent: 75, text: "", fontSize: 16, heightMm: 15 }) }) : current);
    setSelectedId(id);
    setEditingId(id); // Inserting a blank box should let the user type immediately.
  }

  return <section className="journal-page-editor">
    <div className="journal-editor-top"><button type="button" className="button button-secondary" onClick={onBack}>← Journal history</button><span>DAY {page.revision ? `REVISION ${page.revision}` : "DRAFT"}</span><button type="button" className="button button-secondary" disabled={busy || uploading} onClick={() => setReloadKey(value => value + 1)}>Refresh recordings</button></div>
    <div className="journal-editor-heading"><p className="eyebrow">YOUR DAILY PAGE</p><h1>{new Date(page.date).toLocaleDateString(undefined, { dateStyle: "long", timeZone: timezone })}</h1><p>{page.sources?.length ?? 0} recording{page.sources?.length === 1 ? "" : "s"} combined · Original transcript wording is locked, but you can arrange its box.</p>{!!page.sources?.length && <ul className="journal-day-sources">{page.sources.map(source => <li key={source.id}>{source.title} <time>{new Date(source.date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: timezone })}</time></li>)}</ul>}</div>
    <div className="journal-editor-actions"><label><input type="checkbox" checked={page.highlightPage} disabled={busy} onChange={e => setPage({ ...page, highlightPage: e.target.checked })}/> Highlight this page</label><label className="button button-secondary journal-photo-add">{uploading ? "Uploading photo…" : "+ Add private photo"}<input aria-label="Add a private photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading || busy} onChange={e => { void addPhoto(e.target.files?.[0]); e.currentTarget.value = ""; }}/></label><button type="button" className="button button-primary" disabled={busy || uploading} onClick={() => void save()}>{busy ? "Saving…" : "Save page"}</button></div>
    <p className="journal-canvas-hint">Click and drag a box to move it. Double-click an added text box to edit its words; click outside to move it again. Use the corner handles to resize and the round handle to rotate. Original recordings stay locked.</p>
    {error && <p className="journal-editor-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {layerOverlay && typeof document !== "undefined" && createPortal(
      <div className={`journal-layer-floating ${layerOverlay.settling ? "is-settling" : ""}`} aria-hidden="true"
        style={{ left: layerOverlay.left, top: layerOverlay.y - layerOverlay.grabOffsetY,
          width: layerOverlay.width, minHeight: layerOverlay.height,
          transform: layerOverlay.settling ? `translate3d(0, ${layerOverlay.settleY}px, 0)` : "translate3d(0, 0, 0)" }}>
        <span className="journal-layer-floating-grip">⠿</span>
        <span className="journal-layer-floating-icon">{layerOverlay.icon}</span>
        <span className="journal-layer-floating-name">{layerOverlay.name}</span>
      </div>, document.body)}
    <div className="journal-editor-workspace">
      <article className={`journal-a4-preview journal-design-canvas ${page.highlightPage ? "is-page-highlight" : ""}`} aria-label="Journal page design canvas" onClick={e => { if (e.target === e.currentTarget) { setSelectedId(null); setEditingId(null); } }}>
        <header><strong>{page.title}</strong><time>{new Date(page.date).toLocaleDateString(undefined, { dateStyle: "long" })}</time></header>
        <fieldset disabled={busy} className="journal-canvas-fieldset">
          <div className="journal-page-blocks journal-editor-canvas-area" ref={canvasRef}>
            {page.blocks.map((block, index) => {
              const selected = selectedId === block.id;
              const source = block.kind === "text" && block.source ? page.sources?.find(value => value.id === block.sourceJournalId) : undefined;
              const firstSourceBlock = !!source && !page.blocks.slice(0, index).some(value => value.kind === "text" && value.source && value.sourceJournalId === source.id);
              return <div className="journal-block-wrap" key={block.id} style={{ zIndex: 600 - (block.layer ?? index + 1) }}>
                <section id={`journal-frame-${block.id}`} className={`journal-page-block journal-design-block width-${block.width} ${selected ? "is-selected" : ""} ${editingId === block.id ? "is-text-editing" : ""} ${block.kind === "text" && block.style === "note" ? "is-note" : ""}`}
                  tabIndex={0} role="group" aria-label={`${block.kind === "text" ? (block.source ? "Original transcript box" : "Added text box") : "Photo box"} ${index + 1}`}
                  style={{ width: `${defaultWidth(block)}%`, minHeight: block.heightMm ? `${block.heightMm}mm` : undefined, transform: `translate(${block.x ?? 0}mm, ${block.y ?? 0}mm) rotate(${block.rotation ?? 0}deg)` }}
                  onClick={e => {
                    setSelectedId(block.id);
                    // Fallback for browsers where the second click arrives before dblclick.
                    if (e.detail >= 2 && block.kind === "text" && !block.source && !(e.target as HTMLElement).closest("button, input, select, label")) setEditingId(block.id);
                  }}
                  onDoubleClick={e => {
                    if (block.kind === "text" && !block.source && !(e.target as HTMLElement).closest("button, input, select, label")) { e.stopPropagation(); setEditingId(block.id); }
                  }}
                  onFocus={() => setSelectedId(block.id)}
                  onKeyDown={e => { if (busy || e.target !== e.currentTarget) return; if (e.key === "Enter" && block.kind === "text" && !block.source) { e.preventDefault(); setEditingId(block.id); return; } const step = e.shiftKey ? 5 : 1; const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0; const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0; if (dx || dy) { e.preventDefault(); update(block.id, value => ({ ...value, x: clamp((value.x ?? 0) + dx, -X_LIMIT, X_LIMIT), y: clamp((value.y ?? 0) + dy, -Y_LIMIT, Y_LIMIT) })); } }}
                  onPointerDown={e => {
                    // In edit mode the textarea gets all text-selection gestures. Outside
                    // edit mode even clicking the displayed text may start a drag.
                    if (editingId === block.id) return;
                    if (!(e.target as HTMLElement).closest("input, button, select, label")) startGesture(block.id, "move", e);
                  }}
                  onPointerMove={updateGesture} onPointerUp={endGesture} onPointerCancel={endGesture}>
                  {firstSourceBlock && <div className="journal-source-block-heading">{source?.title}</div>}
                  {selected && <>
                    <button type="button" className="journal-design-handle journal-rotate-handle" aria-label={`Rotate ${block.kind === "text" ? "text box" : "photo"}`} title="Drag in an arc to rotate · Hold Shift for 15° steps" onPointerDown={e => startGesture(block.id, "rotate", e)} onPointerMove={updateGesture} onPointerUp={endGesture} onPointerCancel={endGesture}>↻</button>
                    {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map(edge => <button key={edge} type="button" className={`journal-design-handle journal-edge-${edge}`} aria-label={`Resize ${edge} edge`} onPointerDown={e => startGesture(block.id, "resize", e, edge)} onPointerMove={updateGesture} onPointerUp={endGesture} onPointerCancel={endGesture}/>)}
                  </>}
                  {block.kind === "text" ? <>
                    {block.source ? <p id={`journal-block-${block.id}`} className="journal-transcript-source" style={{ fontSize: `${block.fontSize ?? 16}px` }}>{block.text}</p> : <textarea id={`journal-block-${block.id}`} ref={fitNote} rows={1} wrap="soft" aria-label={`Added text ${index + 1}`} readOnly={editingId !== block.id} tabIndex={editingId === block.id ? 0 : -1} value={block.text} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditingId(null); e.currentTarget.blur(); } }} onChange={e => { fitNote(e.currentTarget); const changed = e.target.value; update(block.id, value => value.kind === "text" ? { ...value, text: changed, highlight: value.highlight && !changed.includes(value.highlight) ? undefined : value.highlight } : value); setSelection({ id: block.id, start: e.target.selectionStart, end: e.target.selectionEnd }); }} onSelect={e => setSelection({ id: block.id, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} className={`journal-editable-paragraph${editingId === block.id ? " is-editing" : ""}${block.style === "note" ? " journal-note-text" : ""}`} style={{ fontSize: `${block.fontSize ?? 16}px` }}/>}
                    {block.source && <span className="journal-source-lock" aria-label="Transcript text is locked">Transcript locked</span>}
                    {!block.source && block.highlight && <p className="journal-highlight-chip">Highlighted: <mark>{block.highlight}</mark> <button type="button" onClick={() => update(block.id, value => value.kind === "text" ? { ...value, highlight: undefined } : value)}>Clear</button></p>}
                  </> : <figure className={block.highlight ? "is-photo-highlight" : ""}>{photoUrl(block.photoId) ? <img src={photoUrl(block.photoId)} alt={block.caption || "Private journal photo"} draggable={false} onError={() => { if (retryPhotos.current.has(block.photoId)) return; retryPhotos.current.add(block.photoId); void services.fetchMemoryPhotos(accessToken).then(library => setPhotos(library)).catch(() => {}); }}/> : <div className="journal-photo-pending">Photo preview unavailable · Refresh photos from the inspector</div>}<figcaption><input aria-label="Photo caption" placeholder="Add a caption" value={block.caption ?? ""} onChange={e => update(block.id, value => value.kind === "image" ? { ...value, caption: e.target.value } : value)}/></figcaption></figure>}
                </section>
              </div>;
            })}
          </div>
          <button type="button" className="journal-add-paragraph" onClick={addText}>＋ Add text box</button>
        </fieldset>
      </article>
      <aside className="journal-inspector" aria-label="Selected box properties">
        <div className="journal-inspector-heading"><p className="eyebrow">PAGE TOOLS</p><h2>{selectedBlock ? (blockIsSource(selectedBlock) ? "Transcript box" : selectedBlock.kind === "image" ? "Photo" : "Text box") : "Arrange your page"}</h2></div>
        <div className="journal-inspector-tabs" role="tablist" aria-label="Page tools tabs">
          <button type="button" id="journal-properties-tab" role="tab" aria-selected={inspectorTab === "properties"} aria-controls="journal-properties-panel" onClick={() => setInspectorTab("properties")}>Properties</button>
          <button type="button" id="journal-layers-tab" role="tab" aria-selected={inspectorTab === "layers"} aria-controls="journal-layers-panel" onClick={() => setInspectorTab("layers")}>Layers <span>{page.blocks.length}</span></button>
        </div>
        {inspectorTab === "properties" ? <div id="journal-properties-panel" role="tabpanel" aria-labelledby="journal-properties-tab">
          {selectedBlock ? <div className="journal-inspector-content" key={selectedBlock.id}>
            <label className="journal-style-select">Box name<input type="text" aria-label="Box name" maxLength={80} placeholder={fallbackName(selectedBlock, page.blocks.indexOf(selectedBlock))} value={selectedBlock.name ?? ""} onChange={e => update(selectedBlock.id, value => ({ ...value, name: e.target.value }))}/></label>
            {blockIsSource(selectedBlock) && <p className="journal-inspector-help">Original transcript wording is locked. You can name, position, resize and arrange its layer.</p>}
            {selectedBlock.kind === "text" && <label className="journal-style-select">Text style<select aria-label="Paragraph style" value={selectedBlock.style ?? "paragraph"} onChange={e => update(selectedBlock.id, value => value.kind === "text" ? { ...value, style: e.target.value as "paragraph" | "note" } : value)}><option value="paragraph">Paragraph</option><option value="note">Note</option></select></label>}
            <ScrubField label="Width" value={defaultWidth(selectedBlock)} min={20} max={100} unit="%" onChange={n => update(selectedBlock.id, value => ({ ...value, widthPercent: n }))} onReset={() => update(selectedBlock.id, value => ({ ...value, widthPercent: undefined }))}/>
            <ScrubField label="Height" value={selectedBlock.heightMm ?? (selectedBlock.kind === "image" ? 80 : 15)} min={15} max={260} unit="mm" onChange={n => update(selectedBlock.id, value => ({ ...value, heightMm: n }))} onReset={() => update(selectedBlock.id, value => ({ ...value, heightMm: undefined }))}/>
            {selectedBlock.kind === "text" && <ScrubField label="Text size" value={selectedBlock.fontSize ?? 16} min={10} max={32} unit="px" onChange={n => update(selectedBlock.id, value => value.kind === "text" ? { ...value, fontSize: n } : value)} onReset={() => update(selectedBlock.id, value => value.kind === "text" ? { ...value, fontSize: undefined } : value)}/>}
            <ScrubField label="Angle" value={selectedBlock.rotation ?? 0} min={-30} max={30} unit="°" onChange={n => update(selectedBlock.id, value => ({ ...value, rotation: n }))} onReset={() => update(selectedBlock.id, value => ({ ...value, rotation: 0 }))}/>
            <ScrubField label="Horizontal" value={selectedBlock.x ?? 0} min={-X_LIMIT} max={X_LIMIT} unit="mm" onChange={n => update(selectedBlock.id, value => ({ ...value, x: n }))} onReset={() => update(selectedBlock.id, value => ({ ...value, x: 0 }))}/>
            <ScrubField label="Vertical" value={selectedBlock.y ?? 0} min={-Y_LIMIT} max={Y_LIMIT} unit="mm" onChange={n => update(selectedBlock.id, value => ({ ...value, y: n }))} onReset={() => update(selectedBlock.id, value => ({ ...value, y: 0 }))}/>
            <div className="journal-options-actions">{selectedBlock.kind === "text" && !selectedBlock.source && <button type="button" onClick={() => markSelection(selectedBlock.id)}>Highlight selection</button>}{selectedBlock.kind === "image" && <button type="button" onClick={() => void refreshPhotos().catch(e => setError(e instanceof Error ? e.message : "Unable to reload photos."))}>Refresh photos</button>}{!blockIsSource(selectedBlock) && <button type="button" className="journal-delete-block" aria-label={`Delete ${selectedBlock.kind === "text" ? "added text" : "photo"}`} onClick={() => deleteBlock(selectedBlock.id)}>Delete {selectedBlock.kind === "text" ? "text" : "photo"}</button>}</div>
            <p className="journal-inspector-help">Scrub the label sideways or type a number. Use ↺ beside a value to reset only that property. Text boxes grow to show every line, just like the transcript; Height is only a minimum.</p>
          </div> : <div className="journal-inspector-empty"><span aria-hidden="true">✦</span><p>Select a text or photo box to edit its layout here.</p></div>}
        </div> : <div id="journal-layers-panel" role="tabpanel" aria-labelledby="journal-layers-tab" className="journal-layers-panel">
          <p className="journal-inspector-help">Layer 1 is frontmost. Press and drag a row vertically: the row follows your pointer and the others slide out of the way. Drop to finish. Use ↑ / ↓ on the grip for keyboard ordering.</p>
          <ol ref={layerListRef} className="journal-layer-list" aria-label="Front-to-back layers"
            onPointerMove={moveLayerPointer}
            onPointerUp={event => endLayerDrag(event)}
            onPointerCancel={event => endLayerDrag(event, true)}
            onLostPointerCapture={event => { if (layerPointer.current?.pointerId === event.pointerId) endLayerDrag(event, true); }}
            onKeyDown={event => { if (event.key === "Escape" && layerPointer.current) { event.preventDefault(); cancelLayerDrag(); } }}>
            {rankedLayers.map((block, position) => <li key={block.id} data-layer-id={block.id}
              className={`journal-layer-row ${selectedId === block.id ? "is-active" : ""} ${layerOverlay?.active && layerOverlay.id === block.id ? "is-drag-placeholder" : ""}`}
              onPointerDown={event => beginLayerDrag(event, block, position)}>
              <button type="button" className="journal-layer-grip" aria-label={`Move ${boxName(block, position)} layer`} title="Drag this row vertically · Arrow Up/Down to reorder" disabled={busy}
                onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); nudge(block.id, event.key === "ArrowUp" ? -1 : 1); } }}>⠿</button>
              <button type="button" className="journal-layer-select" aria-label={`Select ${boxName(block, position)}`} onClick={() => setSelectedId(block.id)} title={`Select ${boxName(block, position)}`}>{block.kind === "image" ? "▧" : block.source ? "▤" : "T"}</button>
              <input type="text" maxLength={80} aria-label={`Name layer ${position + 1}`} placeholder={fallbackName(block, position)} value={block.name ?? ""} onFocus={() => setSelectedId(block.id)} onChange={event => update(block.id, value => ({ ...value, name: event.target.value }))}/>
              <span className="journal-layer-rank" aria-label={`Layer ${position + 1}`}>{position + 1}</span>
            </li>)}
          </ol>
        </div>}
      </aside>
    </div>
    <details className="journal-source"><summary>View original transcript</summary><pre>{page.originalText ?? "Original transcript is unavailable."}</pre></details>
  </section>;
}

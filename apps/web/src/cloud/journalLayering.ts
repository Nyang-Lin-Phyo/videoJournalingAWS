import type { JournalPageBlock } from "./analysisApi";

/** Layer 1 is frontmost. Independent of block-array order, which preserves source/print flow. */
export function layersFrontToBack(blocks: JournalPageBlock[]): JournalPageBlock[] {
  return blocks.map((block, index) => ({ block, index }))
    .sort((a, b) => (a.block.layer ?? (a.index + 1)) - (b.block.layer ?? (b.index + 1)) || a.index - b.index)
    .map(item => item.block);
}

export function normalizeLayers(blocks: JournalPageBlock[]): JournalPageBlock[] {
  const ranks = new Map(layersFrontToBack(blocks).map((block, index) => [block.id, index + 1]));
  return blocks.map(block => ({ ...block, layer: ranks.get(block.id)! }));
}

/** Dragging a layer over another inserts it immediately above the hovered layer. */
export function moveLayerAbove(blocks: JournalPageBlock[], movingId: string, hoveredId: string): JournalPageBlock[] {
  if (movingId === hoveredId) return blocks;
  const sorted = layersFrontToBack(blocks);
  const from = sorted.findIndex(block => block.id === movingId);
  const to = sorted.findIndex(block => block.id === hoveredId);
  if (from < 0 || to < 0) return blocks;
  const [moving] = sorted.splice(from, 1);
  const destination = sorted.findIndex(block => block.id === hoveredId);
  sorted.splice(destination, 0, moving);
  const ranks = new Map(sorted.map((block, index) => [block.id, index + 1]));
  return blocks.map(block => ({ ...block, layer: ranks.get(block.id)! }));
}

/** Accessible keyboard alternative to drag/drop. */
export function nudgeLayer(blocks: JournalPageBlock[], id: string, delta: -1 | 1): JournalPageBlock[] {
  const sorted = layersFrontToBack(blocks);
  const from = sorted.findIndex(block => block.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sorted.length) return blocks;
  [sorted[from], sorted[to]] = [sorted[to], sorted[from]];
  const ranks = new Map(sorted.map((block, index) => [block.id, index + 1]));
  return blocks.map(block => ({ ...block, layer: ranks.get(block.id)! }));
}

export function addFrontLayer(blocks: JournalPageBlock[], block: JournalPageBlock): JournalPageBlock[] {
  const normalized = normalizeLayers(blocks);
  return [...normalized.map(item => ({ ...item, layer: item.layer! + 1 })), { ...block, layer: 1 }];
}

/** Insert a floating row at any vertical slot while keeping page/reading order fixed. */
export function moveLayerToIndex(blocks: JournalPageBlock[], movingId: string, toIndex: number): JournalPageBlock[] {
  const layers = layersFrontToBack(blocks);
  const from = layers.findIndex(block => block.id === movingId);
  if (from < 0 || from === toIndex) return blocks;
  const [moving] = layers.splice(from, 1);
  layers.splice(Math.max(0, Math.min(toIndex, layers.length)), 0, moving);
  const rank = new Map(layers.map((block, index) => [block.id, index + 1]));
  return blocks.map(block => ({ ...block, layer: rank.get(block.id)! }));
}

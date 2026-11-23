import { describe, expect, it } from "vitest";
import type { JournalPageBlock } from "../src/cloud/analysisApi";
import { addFrontLayer, layersFrontToBack, moveLayerAbove, moveLayerToIndex, normalizeLayers, nudgeLayer } from "../src/cloud/journalLayering";

const make = (id: string, layer?: number): JournalPageBlock => ({ id, kind: "text", width: "wide", text: id, ...(layer === undefined ? {} : { layer }) });
const ids = (items: JournalPageBlock[]) => items.map(item => item.id);

describe("named journal layers", () => {
  it("normalizes older pages without changing their underlying reading order", () => {
    const legacy = [make("a"), make("b"), make("c")];
    const normalized = normalizeLayers(legacy);
    expect(ids(normalized)).toEqual(["a", "b", "c"]);
    expect(normalized.map(item => item.layer)).toEqual([1, 2, 3]);
  });
  it("places new text and photos on top without rewriting transcript order", () => {
    const blocks = addFrontLayer([make("source", 1)], make("note"));
    expect(ids(blocks)).toEqual(["source", "note"]);
    expect(ids(layersFrontToBack(blocks))).toEqual(["note", "source"]);
  });
  it("moves box 3 above box 2 and shifts box 2 down one layer", () => {
    const blocks = [make("1", 1), make("2", 2), make("3", 3), make("4", 4)];
    const moved = moveLayerAbove(blocks, "3", "2");
    expect(ids(layersFrontToBack(moved))).toEqual(["1", "3", "2", "4"]);
    expect(ids(moved)).toEqual(["1", "2", "3", "4"]);
    expect(moved.find(item => item.id === "2")?.layer).toBe(3);
    expect(moved.find(item => item.id === "3")?.layer).toBe(2);
    expect(ids(layersFrontToBack(nudgeLayer(moved, "4", -1)))).toEqual(["1", "3", "4", "2"]);
  });
  it("inserts any layer at a vertical slot while preserving underlying source order", () => {
    const blocks = [make("1", 1), make("2", 2), make("3", 3), make("4", 4)];
    const upward = moveLayerToIndex(blocks, "3", 1);
    expect(ids(layersFrontToBack(upward))).toEqual(["1", "3", "2", "4"]);
    expect(ids(upward)).toEqual(["1", "2", "3", "4"]);
    const downward = moveLayerToIndex(upward, "1", 3);
    expect(ids(layersFrontToBack(downward))).toEqual(["3", "2", "4", "1"]);
    expect(downward.map(item => item.layer)).toEqual([4, 2, 1, 3]);
    expect(moveLayerToIndex(downward, "missing", 0)).toBe(downward);
  });
});

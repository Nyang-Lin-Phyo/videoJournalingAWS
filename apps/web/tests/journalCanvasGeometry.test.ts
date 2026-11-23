import { describe, it, expect } from "vitest";
import { constrainDrag, correctionToBounds } from "../src/cloud/journalCanvasGeometry";
const page = { left: 0, top: 0, right: 400, bottom: 550, width: 400, height: 550 };
describe("rotated journal block confinement", () => {
  it("clamps movement using actual rotated bounding edges", () => {
    const rotated = { left: 300, top: 150, right: 390, bottom: 270, width: 90, height: 120 };
    expect(constrainDrag(rotated, page, 80, 0).dx).toBe(3);
    expect(constrainDrag(rotated, page, -500, 0).dx).toBe(-293);
    expect(constrainDrag(rotated, page, 0, -500).dy).toBe(-143);
  });
  it("returns a correction for boxes partially beyond the page", () => {
    const box = { left: -15, top: -10, right: 110, bottom: 115, width: 125, height: 125 };
    expect(correctionToBounds(box, page)).toEqual({ dx: 22, dy: 17 });
  });
  it("centers oversized boxes safely without producing NaN", () => {
    const box = { left: -5, top: -5, right: 450, bottom: 600, width: 455, height: 605 };
    const result = constrainDrag(box, page, 100, -100);
    expect(Number.isFinite(result.dx) && Number.isFinite(result.dy)).toBe(true);
  });
});

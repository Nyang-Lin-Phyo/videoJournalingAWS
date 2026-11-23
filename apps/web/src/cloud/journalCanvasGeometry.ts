/** Measurements are in CSS pixels. Caller supplies the *rotated* DOM bounding rect. */
export type CanvasRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
/** Constrain a drag using the measured, rotated outer corners, not the unrotated box. */
export function constrainDrag(box: CanvasRect, page: CanvasRect, dx: number, dy: number, pad = 7) {
  const left = page.left + pad - box.left, right = page.right - pad - box.right;
  const top = page.top + pad - box.top, bottom = page.bottom - pad - box.bottom;
  return {
    dx: left > right ? (left + right) / 2 : clamp(dx, left, right),
    dy: top > bottom ? (top + bottom) / 2 : clamp(dy, top, bottom),
  };
}
export function correctionToBounds(box: CanvasRect, page: CanvasRect, pad = 7) {
  return constrainDrag(box, page, 0, 0, pad);
}

import { memo } from "react";

/*
 * A 26×24 pixel-art puppy drawn as SVG rects. The body is described as a
 * left half that is mirrored, so it stays perfectly symmetric; the tail,
 * eyes and mouth are overlays that CSS swaps to animate.
 */

const PALETTE: Record<string, string> = {
  o: "#5a2a25", // outline
  f: "#ef9c44", // orange fur
  d: "#c9712f", // inner-ear shade
  c: "#fbeedb", // cream fur
  e: "#2b1512", // eye / nose
  w: "#ffffff", // eye shine
  p: "#f2a08e", // blush
  r: "#9f4740", // brick scarf
  s: "#c25a50", // scarf highlight
  g: "#ffd27a", // tag
  t: "#e7726a", // tongue
};

const LEFT_HALF = [
  "...oo.....",
  "..odfo....",
  "..odcfo...",
  ".odccfoooo",
  ".odcffffff",
  ".offffffff",
  "offfffffff",
  "offfffffff",
  "offfffffff",
  "offcccffcc",
  "ocpccccccc",
  "occccccccc",
  ".occcccccc",
  "..oooccccc",
  "..orsrrrrr",
  "..offfcccc",
  "..offccccc",
  ".offfccccc",
  ".offfccccc",
  ".offfccccc",
  ".offffcccc",
  ".offfoccco",
  ".offfoccco",
  "..oooooooo",
];

const BODY = LEFT_HALF.map(half => half + [...half].reverse().join(""));

type Pixel = { x: number; y: number; c: string };

function toPixels(rows: string[], ox = 0, oy = 0): Pixel[] {
  const out: Pixel[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== ".") out.push({ x: x + ox, y: y + oy, c: ch });
    });
  });
  return out;
}

const TAIL_UP = toPixels([
  "....oo.",
  "...ocfo",
  "...offo",
  "..offo.",
  ".offo..",
  "fffo...",
  "ffo....",
  "oo.....",
], 18, 13);

const TAIL_SIDE = toPixels([
  ".......",
  ".......",
  "....oo.",
  "...ocfo",
  "..offfo",
  "fffffo.",
  "ffooo..",
  "oo.....",
], 18, 13);

const EYES_OPEN = toPixels(["wee", "eee"], 4, 7).concat(toPixels(["wee", "eee"], 13, 7));
const EYES_CLOSED = toPixels(["fff", "eee"], 4, 7).concat(toPixels(["fff", "eee"], 13, 7));
const NOSE = toPixels([".ee.", "eeee"], 8, 9).concat(toPixels(["w"], 9, 9));
const MOUTH_SMILE = toPixels(["o.oo.o", ".o..o."], 7, 11);
const MOUTH_OPEN = toPixels(["o.oo.o", ".otto.", "..tt.."], 7, 11);
const TAG = toPixels(["gg", "gg"], 9, 14);

function Pixels({ pixels }: { pixels: Pixel[] }) {
  return <>{pixels.map(p => (
    <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1.02} height={1.02} fill={PALETTE[p.c]} />
  ))}</>;
}

const BODY_PIXELS = toPixels(BODY);

/*
 * Side view for walking, facing right (CSS mirrors it to face left).
 * Drawn 4 rows down so the paws land on the bottom row, like the sitting pose.
 */
const SIDE_Y = 4;
const SIDE_BODY = toPixels([
  "..............oo...oo.....",
  ".............odfo.odfo....",
  "............odcfoodcfo....",
  "...........offffffffffo...",
  "...........offffffffffoo..",
  "...........offffffffweffo.",
  "...........offffffffeefcco",
  "...........offfffffpfcccee",
  "...........offffffcccccco.",
  "...ooooooooooffcccoooooo..",
  "..offffffffffrrrrro.......",
  "..offffffffffccgcco.......",
  "..offffffffffcccccco......",
  "..offffffffcccccccco......",
  "...offffffcccccccco.......",
  "....oooooooooooooo........",
], 0, SIDE_Y);
const SIDE_LEGS_STRIDE = toPixels([
  "....offo......offo........",
  "...offo........offo.......",
  "..offo..........offo......",
  ".occo............occo.....",
  ".oooo............oooo.....",
], 0, SIDE_Y + 15);
const SIDE_LEGS_PASS = toPixels([
  "....offo......offo........",
  "....offo......offo........",
  "....offo......offo........",
  "....occo......occo........",
  "....oooo......oooo........",
], 0, SIDE_Y + 15);
const SIDE_TAIL_UP = toPixels([
  "..oo......",
  ".ocfo.....",
  ".offo.....",
  "..offo....",
  "...offo...",
  "....offo..",
  "....offo..",
], 0, SIDE_Y + 3);
const SIDE_TAIL_BACK = toPixels([
  "..........",
  "oo........",
  "ocfo......",
  "offfo.....",
  ".offfo....",
  "..offfo...",
  "....offo..",
], 0, SIDE_Y + 3);

function WalkingDog() {
  return <>
    <g className="pixel-dog-tail pixel-dog-tail--a"><Pixels pixels={SIDE_TAIL_UP} /></g>
    <g className="pixel-dog-tail pixel-dog-tail--b"><Pixels pixels={SIDE_TAIL_BACK} /></g>
    <g className="pixel-dog-step"><Pixels pixels={SIDE_BODY} /></g>
    <g className="pixel-dog-legs pixel-dog-legs--a"><Pixels pixels={SIDE_LEGS_STRIDE} /></g>
    <g className="pixel-dog-legs pixel-dog-legs--b"><Pixels pixels={SIDE_LEGS_PASS} /></g>
  </>;
}

export type DogMood = "idle" | "talking" | "sleeping" | "walking";

export const PixelDog = memo(function PixelDog({ mood, size = 4 }: { mood: DogMood; size?: number }) {
  if (mood === "walking") {
    return (
      <svg
        className="pixel-dog pixel-dog--walking"
        viewBox="0 0 26 24"
        width={26 * size}
        height={24 * size}
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
      >
        <WalkingDog />
      </svg>
    );
  }
  return (
    <svg
      className={`pixel-dog pixel-dog--${mood}`}
      viewBox="0 0 26 24"
      width={26 * size}
      height={24 * size}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className="pixel-dog-tail pixel-dog-tail--a"><Pixels pixels={TAIL_UP} /></g>
      <g className="pixel-dog-tail pixel-dog-tail--b"><Pixels pixels={TAIL_SIDE} /></g>
      <Pixels pixels={BODY_PIXELS} />
      <Pixels pixels={TAG} />
      <Pixels pixels={NOSE} />
      <g className="pixel-dog-eyes-open"><Pixels pixels={EYES_OPEN} /></g>
      <g className="pixel-dog-eyes-closed"><Pixels pixels={EYES_CLOSED} /></g>
      <g className="pixel-dog-mouth-smile"><Pixels pixels={MOUTH_SMILE} /></g>
      <g className="pixel-dog-mouth-open"><Pixels pixels={MOUTH_OPEN} /></g>
    </svg>
  );
});

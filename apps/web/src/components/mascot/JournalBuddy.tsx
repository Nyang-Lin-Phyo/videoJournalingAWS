import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PixelDog, type DogMood } from "./PixelDog";
import { MASCOT_TIPS, TIP_LABELS, type MascotTip } from "./mascotTips";
import { RECOMMENDATION_HEADINGS, useBuddyChannel } from "./buddyChannel";
import "./mascot.css";

const NAME = "Biscuit";
const NAP_KEY = "reverie.buddy.napping";
const GREETED_KEY = "reverie.buddy.greeted";
const FIRST_POP_MS = 5_000;
const IDLE_POP_MS = 4 * 60_000;
const AUTO_HIDE_MS = 16_000;
/** Strolls happen 3–4 times per 30 minutes of visible time: one every 6–10 minutes. */
const WALK_MIN_MS = 6 * 60_000;
const WALK_MAX_MS = 10 * 60_000;
const WALK_RETRY_MS = 30_000;
const WALK_SPEED_PX_PER_S = 85;
const EDGE_GAP = 20;
const MOBILE_LEFT_GAP = 72; // clear the floating Settings button on phones

type Spot = "left" | "right" | number;
const randomWalkDelay = () => WALK_MIN_MS + Math.random() * (WALK_MAX_MS - WALK_MIN_MS);

function readStorage(storage: () => Storage, key: string) {
  try { return storage().getItem(key); } catch { return null; }
}
function writeStorage(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch { /* storage may be blocked; the buddy still works for this visit */ }
}
const local = () => window.localStorage;
const session = () => window.sessionStorage;

function prefersReducedMotion() {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Shuffled deck so tips don't repeat until every one has been seen. */
function useTipDeck(context?: "upload" | "history") {
  const deck = useRef<MascotTip[]>([]);
  const last = useRef<MascotTip | null>(null);
  return useCallback(() => {
    if (deck.current.length === 0) {
      deck.current = [...MASCOT_TIPS].sort(() => Math.random() - 0.5);
    }
    // Prefer something that fits the current page, but never block on it.
    const index = deck.current.findIndex(tip =>
      tip !== last.current && (!tip.context || tip.context === context));
    const [tip] = deck.current.splice(index === -1 ? 0 : index, 1);
    last.current = tip!;
    return tip!;
  }, [context]);
}

function useTypewriter(text: string, enabled: boolean) {
  const [progress, setProgress] = useState({ text: "", count: 0 });
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      setProgress(prev => {
        const count = prev.text === text ? prev.count + 1 : 1;
        if (count >= text.length) window.clearInterval(timer);
        return { text, count: Math.min(count, text.length) };
      });
    }, 22);
    return () => window.clearInterval(timer);
  }, [text, enabled]);
  const count = !enabled ? text.length : progress.text === text ? progress.count : 0;
  return { shown: text.slice(0, count), done: count >= text.length };
}

type JournalBuddyProps = { context?: "upload" | "history" };

export function JournalBuddy({ context }: JournalBuddyProps) {
  const nextTip = useTipDeck(context);
  const [tip, setTip] = useState<MascotTip | null>(null);
  const [napping, setNapping] = useState(() => readStorage(local, NAP_KEY) === "1");
  const [reducedMotion] = useState(prefersReducedMotion);
  const hovering = useRef(false);
  const { shown, done } = useTypewriter(tip?.text ?? "", Boolean(tip) && !reducedMotion);

  // ----- strolling along the footer line -----
  const perchRef = useRef<HTMLDivElement>(null);
  const buddyRef = useRef<HTMLDivElement>(null);
  const [track, setTrack] = useState({ width: 0, dog: 104, minX: EDGE_GAP });
  const [spot, setSpot] = useState<Spot>("right");
  const [walkMs, setWalkMs] = useState<number | null>(null);
  const [facing, setFacing] = useState<"left" | "right">("left");
  const walkTimer = useRef<number | undefined>(undefined);

  const maxX = Math.max(track.minX, track.width - track.dog - EDGE_GAP);
  const x = spot === "left" ? track.minX : spot === "right" ? maxX
    : Math.min(maxX, Math.max(track.minX, spot));
  const walking = walkMs !== null;
  const onLeftHalf = x + track.dog / 2 < track.width / 2;

  useLayoutEffect(() => {
    const perch = perchRef.current;
    if (!perch) return;
    const measure = () => {
      const dog = perch.querySelector<HTMLElement>(".buddy-dog")?.offsetWidth || 104;
      const narrow = typeof window.matchMedia === "function"
        && window.matchMedia("(max-width: 680px)").matches;
      setTrack({ width: perch.clientWidth, dog, minX: narrow ? MOBILE_LEFT_GAP : EDGE_GAP });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(perch);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(walkTimer.current), []);

  /** Freeze mid-stride wherever Biscuit currently is on screen. */
  const stopWalking = useCallback(() => {
    if (walkMs === null) return;
    window.clearTimeout(walkTimer.current);
    const el = buddyRef.current;
    let current = x;
    if (el && typeof DOMMatrixReadOnly !== "undefined") {
      const transform = getComputedStyle(el).transform;
      if (transform && transform !== "none") current = new DOMMatrixReadOnly(transform).m41;
    }
    setSpot(current);
    setWalkMs(null);
  }, [walkMs, x]);

  const stroll = useCallback(() => {
    if (walkMs !== null || napping || tip || reducedMotion || track.width === 0) return false;
    const target: Spot = onLeftHalf ? "right" : "left";
    const targetX = target === "left" ? track.minX : maxX;
    const distance = Math.abs(targetX - x);
    if (distance < 1) return false;
    const ms = Math.round((distance / WALK_SPEED_PX_PER_S) * 1000);
    setFacing(targetX < x ? "left" : "right");
    setWalkMs(ms);
    setSpot(target);
    walkTimer.current = window.setTimeout(() => setWalkMs(null), ms);
    return true;
  }, [walkMs, napping, tip, reducedMotion, track, onLeftHalf, maxX, x]);

  // The scheduler lives in an effect with a stable interval, so read the latest stroll via a ref.
  const strollRef = useRef(stroll);
  useEffect(() => { strollRef.current = stroll; }, [stroll]);

  // Count only time the page is actually visible, then wander to the other end.
  useEffect(() => {
    if (napping || reducedMotion) return;
    let visibleMs = 0;
    let due = randomWalkDelay();
    const ticker = window.setInterval(() => {
      if (document.hidden) return;
      visibleMs += 1000;
      if (visibleMs < due) return;
      if (strollRef.current()) {
        visibleMs = 0;
        due = randomWalkDelay();
      } else {
        visibleMs = due - WALK_RETRY_MS; // busy (talking, etc.) — try again shortly
      }
    }, 1000);
    return () => window.clearInterval(ticker);
  }, [napping, reducedMotion]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { biscuitWalk?: () => boolean };
    w.biscuitWalk = () => strollRef.current();
    return () => { delete w.biscuitWalk; };
  }, []);

  const walkingRef = useRef(walking);
  useEffect(() => { walkingRef.current = walking; }, [walking]);

  const speak = useCallback(() => setTip(nextTip()), [nextTip]);
  const hush = useCallback(() => setTip(null), []);
  const tipOpenRef = useRef(false);
  useEffect(() => { tipOpenRef.current = tip !== null; }, [tip]);

  // Gemini's recommendation (verified by the backend) arrives via the reflection.
  // It's the most important thing Biscuit says: it interrupts a walk, reaches
  // you even during a nap, and stays until you close it.
  const channel = useBuddyChannel();
  const stopWalkingRef = useRef(stopWalking);
  useEffect(() => { stopWalkingRef.current = stopWalking; }, [stopWalking]);
  useEffect(() => channel?.subscribe(recommendation => {
    stopWalkingRef.current();
    setTip({
      kind: "recommendation",
      text: recommendation.text,
      label: RECOMMENDATION_HEADINGS[recommendation.reason],
    });
  }), [channel]);

  // Greet once per browser session, then pop up occasionally while awake.
  useEffect(() => {
    if (napping) return;
    const greeted = readStorage(session, GREETED_KEY) === "1";
    const first = greeted ? null : window.setTimeout(() => {
      if (walkingRef.current || tipOpenRef.current) return;
      writeStorage(session, GREETED_KEY, "1");
      speak();
    }, FIRST_POP_MS);
    const idle = window.setInterval(() => {
      if (!document.hidden && !walkingRef.current && !tipOpenRef.current) speak();
    }, IDLE_POP_MS);
    return () => {
      if (first !== null) window.clearTimeout(first);
      window.clearInterval(idle);
    };
  }, [napping, speak]);

  // Let the bubble drift away on its own unless the person is reading it.
  useEffect(() => {
    if (!tip || !done || tip.kind === "recommendation") return;
    const timer = window.setTimeout(() => {
      if (!hovering.current) hush();
    }, AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [tip, done, hush]);

  useEffect(() => {
    if (!tip) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hush(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tip, hush]);

  function toggleNap() {
    const next = !napping;
    setNapping(next);
    writeStorage(local, NAP_KEY, next ? "1" : null);
    if (next) { hush(); stopWalking(); }
  }

  function onDogClick() {
    stopWalking();
    if (napping) {
      setNapping(false);
      writeStorage(local, NAP_KEY, null);
    }
    speak();
  }

  const mood: DogMood = walking ? "walking"
    : tip ? (done ? "idle" : "talking")
    : napping ? "sleeping" : "idle";
  const isRecommendation = tip?.kind === "recommendation";

  return (
    <div className="buddy-perch" ref={perchRef}>
    <div
      ref={buddyRef}
      className={[
        "journal-buddy",
        tip ? "is-speaking" : "",
        onLeftHalf ? "is-left" : "is-right",
        walking && facing === "left" ? "faces-left" : "",
      ].join(" ")}
      style={{
        transform: `translateX(${x}px)`,
        transition: walking ? `transform ${walkMs}ms linear` : "none",
      }}
      onMouseEnter={() => { hovering.current = true; }}
      onMouseLeave={() => { hovering.current = false; }}
    >
      {tip && (
        <section className={`buddy-bubble buddy-bubble--${tip.kind}`} aria-label={`${NAME} says`}>
          <div className="buddy-bubble-head">
            <span className="buddy-chip">{tip.label ?? TIP_LABELS[tip.kind]}</span>
            <button type="button" className="buddy-icon-button" aria-label={isRecommendation ? "Close recommendation" : "Close tip"} onClick={hush}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <p className="buddy-text" role="status">
            <span className="buddy-sr">{tip.text}{tip.by ? ` — ${tip.by}` : ""}</span>
            <span aria-hidden="true">
              {tip.kind === "quote" ? "“" : ""}{shown}{tip.kind === "quote" && done ? "”" : ""}
              {!done && <span className="buddy-caret" />}
            </span>
          </p>
          {tip.by && done && <p className="buddy-by">— {tip.by}</p>}
          {isRecommendation ? (
            <div className="buddy-actions">
              <span className="buddy-fine">Picked from your favourites</span>
              <button type="button" className="buddy-link" onClick={hush}>Thanks, {NAME}</button>
            </div>
          ) : (
            <div className="buddy-actions">
              <button type="button" className="buddy-link" onClick={speak}>Another one</button>
              <button type="button" className="buddy-link buddy-link--quiet" onClick={toggleNap}>Let {NAME} nap</button>
            </div>
          )}
        </section>
      )}
      <button
        type="button"
        className="buddy-dog"
        aria-label={napping ? `${NAME} is napping. Wake ${NAME} for a tip` : `${NAME}, your journaling buddy. Get a tip`}
        title={napping ? `Wake ${NAME}` : `${NAME} has an idea`}
        onClick={onDogClick}
      >
        {napping && !tip && <span className="buddy-zzz" aria-hidden="true">z<span>z</span><span>Z</span></span>}
        <PixelDog mood={mood} />
      </button>
    </div>
    </div>
  );
}

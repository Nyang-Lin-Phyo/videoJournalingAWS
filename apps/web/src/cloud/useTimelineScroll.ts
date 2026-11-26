import { useEffect, useRef } from "react";

/**
 * Drives the journal-history timeline animations:
 *  - Marks each `[data-reveal]` child with `data-visible="true"` the first time
 *    it scrolls into view (entries that appear together are staggered).
 *  - Writes `--tl-progress` (0..1) on the container so the spine can "fill"
 *    as the reader scrolls down through their history.
 *
 * The attribute is set directly on the DOM (React never renders it), so
 * re-renders don't reset an entry back to hidden.
 */
export function useTimelineScroll<T extends HTMLElement>(itemCount: number) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const pending = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"))
      .filter(element => element.dataset.visible !== "true");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (typeof IntersectionObserver === "undefined" || reducedMotion) {
      pending.forEach(element => { element.dataset.visible = "true"; });
      return;
    }

    const observer = new IntersectionObserver(entries => {
      let stagger = 0;
      entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        .forEach(entry => {
          const element = entry.target as HTMLElement;
          element.style.setProperty("--tl-delay", `${Math.min(stagger, 6) * 90}ms`);
          element.dataset.visible = "true";
          observer.unobserve(element);
          stagger += 1;
        });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.15 });

    pending.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [itemCount]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Measure the actual spine rather than the outer timeline, whose top
      // and bottom padding differ. This makes the fill end at the reading head.
      const rect = (root.querySelector<HTMLElement>(".tl-spine") ?? root).getBoundingClientRect();
      // The "reading head" sits 60% of the way down the viewport.
      const head = window.innerHeight * 0.6;
      const atPageEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      // Short histories can't scroll far enough to reach the head, so finish
      // the line once the reader hits the bottom of the page.
      const progress = atPageEnd ? 1 : rect.height > 0 ? (head - rect.top) / rect.height : 0;
      root.style.setProperty("--tl-progress", Math.min(1, Math.max(0, progress)).toFixed(4));
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [itemCount]);

  return ref;
}

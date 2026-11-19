import { createContext, useContext } from "react";
import type { Analysis } from "../../cloud/analysisApi";

export type RecommendationReason = NonNullable<Analysis["suggestion_reason"]>;

export type BuddyRecommendation = {
  text: string;
  reason: RecommendationReason;
};

export const RECOMMENDATION_HEADINGS: Record<RecommendationReason, string> = {
  comfort: "A gentle thought",
  context_match: "A little idea for today",
  been_a_while: "Something you might be missing",
};

type Listener = (recommendation: BuddyRecommendation) => void;

/**
 * A tiny hand-off between the reflection (which receives Gemini's verified
 * recommendation from the backend) and Biscuit (who delivers it). If Biscuit
 * isn't on screen yet, the latest recommendation waits for him.
 */
export function createBuddyChannel() {
  const listeners = new Set<Listener>();
  let pending: BuddyRecommendation | null = null;
  return {
    recommend(recommendation: BuddyRecommendation) {
      if (listeners.size === 0) { pending = recommendation; return; }
      pending = null;
      listeners.forEach(listener => listener(recommendation));
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      if (pending) {
        const waiting = pending;
        pending = null;
        listener(waiting);
      }
      return () => { listeners.delete(listener); };
    },
  };
}

export type BuddyChannel = ReturnType<typeof createBuddyChannel>;

export const BuddyContext = createContext<BuddyChannel | null>(null);

/** Null outside the app shell, so callers can fall back to showing it inline. */
export const useBuddyChannel = () => useContext(BuddyContext);

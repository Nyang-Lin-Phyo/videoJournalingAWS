import type { JournalSummary } from "./analysisApi";

export const MOOD_GRADIENTS: Record<string, [string, string]> = {
  positive: ["#f7c46b", "#ef7d44"],
  neutral: ["#d9b48c", "#a9785d"],
  negative: ["#8e7aa8", "#56658f"],
  pending: ["#e2c7a6", "#c9a582"],
};

export function statusLabel(status: JournalSummary["status"]) {
  if (status === "completed") return "Reflection ready";
  if (status === "deleting") return "Cleanup needs attention";
  if (status === "failed") return "Reflection unavailable";
  return "Preparing your reflection";
}

/** One gradient that blends every mood recorded that day. */
export function blendedCover(journals: JournalSummary[]) {
  const stops = journals.flatMap(journal => MOOD_GRADIENTS[journal.sentiment ?? "pending"]);
  return `linear-gradient(135deg, ${stops.join(", ")})`;
}

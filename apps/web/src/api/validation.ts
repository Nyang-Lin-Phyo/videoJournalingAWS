export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
const VIDEO_MIMES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm" };

export function videoMime(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const expected = VIDEO_MIMES[ext];
  if (!expected || (file.type && file.type.toLowerCase() !== expected)) return null;
  return expected;
}

export function validateVideo(file: File): string | null {
  if (!videoMime(file)) return "Choose an MP4 or WebM video (.mp4 or .webm). Other formats are not supported.";
  if (!file.size) return "This file is empty. Choose a video with content.";
  if (file.size > MAX_VIDEO_BYTES) return "This video exceeds 30 MiB. Choose a smaller video.";
  return null;
}

export function fileSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

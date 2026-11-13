export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
export function validateVideo(file: File): string | null {
  if (!/\.mp4$/i.test(file.name) || (file.type && file.type !== "video/mp4"))
    return "Choose an MP4 video (.mp4). Other formats are not supported.";
  if (!file.size) return "This file is empty. Choose a video with content.";
  if (file.size > MAX_VIDEO_BYTES)
    return "This video exceeds 30 MiB. Choose a smaller MP4 video.";
  return null;
}
export function fileSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

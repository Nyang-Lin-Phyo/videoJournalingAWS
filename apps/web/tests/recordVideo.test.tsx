import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordVideoDialog, preferredRecordingMime } from "../src/cloud/RecordVideoDialog";
import { validateVideo, videoMime } from "../src/api/validation";

class FakeMediaRecorder {
  static isTypeSupported = (type: string) => type === "video/webm;codecs=vp8,opus";
  mimeType = "video/webm;codecs=vp8,opus";
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: MediaStream, _options: MediaRecorderOptions) {}
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["test webm"], { type: "video/webm" }) } as BlobEvent);
    this.onstop?.();
  }
}

describe("browser recording", () => {
  afterEach(() => {
    delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
  });

  it("accepts WebM and MP4 but rejects mismatched MIME types", () => {
    expect(videoMime(new File(["data"], "video.webm", { type: "video/webm" }))).toBe("video/webm");
    expect(validateVideo(new File(["data"], "video.webm", { type: "video/webm" }))).toBeNull();
    expect(validateVideo(new File(["data"], "video.mp4", { type: "video/webm" }))).toContain("MP4 or WebM");
  });

  it("records, previews, selects a WebM and releases the camera", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    class TestURL extends URL {
      static createObjectURL = vi.fn(() => "blob:recording");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    const onUseRecording = vi.fn();
    const onClose = vi.fn();
    expect(preferredRecordingMime()).toBe("video/webm;codecs=vp8,opus");
    const view = render(<RecordVideoDialog onClose={onClose} onUseRecording={onUseRecording} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await screen.findByRole("button", { name: "Use recording" });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Use recording" }));
    expect(onUseRecording).toHaveBeenCalledOnce();
    expect((onUseRecording.mock.calls[0]![0] as File).type).toBe("video/webm");
    view.unmount();
  });

  it("does not upload or select anything when cancelled", async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onClose = vi.fn();
    const onUseRecording = vi.fn();
    const view = render(<RecordVideoDialog onClose={onClose} onUseRecording={onUseRecording} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onUseRecording).not.toHaveBeenCalled();
  });
});

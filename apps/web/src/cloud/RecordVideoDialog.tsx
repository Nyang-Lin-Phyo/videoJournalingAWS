import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_VIDEO_BYTES, fileSize, validateVideo } from "../api/validation";
import { Icon } from "../components/Icon";
import "./record-video.css";

export const MAX_RECORD_SECONDS = 60;
const MIME_CANDIDATES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];

export function preferredRecordingMime(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  return MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}

function permissionMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
    return "Camera or microphone permission was denied. Allow access in your browser settings and try again.";
  }
  if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) {
    return "No camera or microphone was found. Connect both devices and try again.";
  }
  return "Unable to start the camera. Check camera and microphone permissions and try again.";
}

type Phase = "loading" | "ready" | "recording" | "finishing" | "review";

export function RecordVideoDialog({ onClose, onUseRecording }: {
  onClose: () => void;
  onUseRecording: (file: File) => void;
}) {
  const headingId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const liveVideo = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const failedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const disposedRef = useRef(false);
  const cameraRequestRef = useRef(0);
  const previewUrlRef = useRef<string | null>(null);
  const [host] = useState(() => document.createElement("div"));
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [recorded, setRecorded] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [mime, setMime] = useState<string | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (liveVideo.current) liveVideo.current.srcObject = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setRecorded(null);
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      setPhase("finishing");
      clearTimer();
      recorderRef.current.stop();
    }
  }, [clearTimer]);

  const openCamera = useCallback(async () => {
    const requestId = ++cameraRequestRef.current;
    clearPreview();
    setMessage(null);
    setElapsed(0);
    setPhase("loading");
    const format = preferredRecordingMime();
    if (!navigator.mediaDevices?.getUserMedia || !format) {
      setMessage("This browser cannot record supported MP4 or WebM video. Try an updated Chrome, Edge, Firefox, or Safari browser.");
      setPhase("ready");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" }, audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (disposedRef.current || requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      setMime(format);
      setPhase("ready");
    } catch (error) {
      if (!disposedRef.current && requestId === cameraRequestRef.current) {
        setMessage(permissionMessage(error));
        setPhase("ready");
      }
    }
  }, [clearPreview]);

  useEffect(() => {
    // React StrictMode replays effects in development. Invalidate any camera
    // request from the previous effect before starting the next one.
    disposedRef.current = false;
    const opener = document.activeElement as HTMLElement | null;
    const backgrounds = Array.from(document.body.children).map(element => ({
      element: element as HTMLElement, inert: (element as HTMLElement).inert,
    }));
    document.body.appendChild(host);
    backgrounds.forEach(({ element }) => { element.inert = true; });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    void openCamera();
    return () => {
      disposedRef.current = true;
      ++cameraRequestRef.current;
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") recorder.stop();
      recorderRef.current = null;
      stopTracks();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      backgrounds.forEach(({ element, inert }) => { element.inert = inert; });
      document.body.style.overflow = previousOverflow;
      host.remove();
      opener?.focus();
    };
  }, [host, openCamera, stopTracks, clearTimer]);

  useEffect(() => {
    if (liveVideo.current && streamRef.current && (phase === "ready" || phase === "recording")) {
      liveVideo.current.srcObject = streamRef.current;
    }
  }, [phase]);

  function startRecording() {
    if (!streamRef.current || !mime) return;
    setMessage(null);
    clearPreview();
    chunksRef.current = [];
    bytesRef.current = 0;
    failedRef.current = false;
    try {
      const recorder = new MediaRecorder(streamRef.current, {
        mimeType: mime,
        videoBitsPerSecond: 1_600_000,
        audioBitsPerSecond: 96_000,
      });
      recorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (disposedRef.current || !event.data?.size) return;
        bytesRef.current += event.data.size;
        chunksRef.current.push(event.data);
        if (bytesRef.current > MAX_VIDEO_BYTES && recorder.state === "recording") {
          setMessage("Recording exceeded 30 MiB. Please record a shorter video.");
          stopRecording();
        }
      };
      recorder.onerror = () => {
        failedRef.current = true;
        if (!disposedRef.current) setMessage("Recording failed. Please retake your video.");
        if (recorder.state === "recording") recorder.stop();
      };
      recorder.onstop = () => {
        clearTimer();
        stopTracks();
        recorderRef.current = null;
        if (disposedRef.current) return;
        const format = recorder.mimeType.toLowerCase().startsWith("video/mp4") ? "video/mp4" : "video/webm";
        const extension = format === "video/mp4" ? "mp4" : "webm";
        const video = new File(chunksRef.current, `reverie-recording-${Date.now()}.${extension}`, { type: format });
        chunksRef.current = [];
        const problem = validateVideo(video);
        if (failedRef.current || problem || bytesRef.current > MAX_VIDEO_BYTES) {
          setMessage(failedRef.current ? "Recording failed. Please retake your video." :
            problem || "Recording exceeded 30 MiB. Please retake your video.");
          setPhase("ready");
          return;
        }
        const url = URL.createObjectURL(video);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setRecorded(video);
        setPhase("review");
      };
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setPhase("recording");
      timerRef.current = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setElapsed(Math.min(seconds, MAX_RECORD_SECONDS));
        if (seconds >= MAX_RECORD_SECONDS && recorder.state === "recording") stopRecording();
      }, 250);
    } catch {
      stopTracks();
      setPhase("ready");
      setMessage("Recording could not start. Check that your browser supports this camera format.");
    }
  }

  return createPortal(
    <div className="transcript-backdrop record-backdrop" data-testid="record-backdrop"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="transcript-reader record-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key === "Tab") {
            const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]),video[controls]"));
            const first = stops[0]; const last = stops[stops.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header className="transcript-reader-header">
          <div>
            <p className="section-label"><Icon name="video" size={16} /> A MOMENT, JUST FOR YOU</p>
            <h2 id={headingId}>Record a video</h2>
            <p className="record-description">Record up to one minute. Your recording stays on your device until you save the journal.</p>
          </div>
          <button type="button" ref={closeButton} className="transcript-close" aria-label="Close recorder" onClick={onClose}>
            <Icon name="close" size={22}/>
          </button>
        </header>
        <div className="transcript-reader-body record-body">
          <div className="record-video-frame">
            {phase === "review" && previewUrl
              ? <video controls playsInline src={previewUrl} aria-label="Recorded video preview" />
              : streamRef.current && (phase === "ready" || phase === "recording")
                ? <video ref={liveVideo} autoPlay muted playsInline aria-label="Live camera preview" />
                : <div className="record-empty"><Icon name="video" size={32}/><span>{phase === "loading" ? "Requesting camera and microphone…" : "Camera is off"}</span></div>}
          </div>
          <div className="record-status" role="status">
            {phase === "recording" && <span className="record-dot" aria-hidden="true" />}
            <span>{phase === "review" && recorded ? `Recorded video · ${fileSize(recorded.size)}` :
              phase === "finishing" ? "Finishing recording…" :
              phase === "recording" ? "Recording" :
              phase === "loading" ? "Connecting…" : "Ready when you are"}</span>
            <strong>{String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")} / 01:00</strong>
          </div>
          {message && <p role="alert" className="record-error">{message}</p>}
          <div className="record-actions">
            {phase === "ready" && <button type="button" className="button button-primary"
              disabled={!streamRef.current} onClick={startRecording}>Start recording</button>}
            {phase === "recording" && <button type="button" className="button button-primary" onClick={stopRecording}>Stop recording</button>}
            {phase === "review" && <>
              <button type="button" className="button button-secondary" onClick={() => void openCamera()}><Icon name="refresh" size={16}/> Retake</button>
              <button type="button" className="button button-primary" disabled={!recorded}
                onClick={() => { if (recorded) onUseRecording(recorded); }}>Use recording</button>
            </>}
            {phase === "ready" && !streamRef.current && <button type="button" className="button button-secondary" onClick={() => void openCamera()}>Try camera again</button>}
            <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
          </div>
          <p className="record-privacy"><Icon name="shield" size={15}/> Camera and microphone turn off as soon as recording stops or you close this window.</p>
        </div>
      </section>
    </div>, host,
  );
}

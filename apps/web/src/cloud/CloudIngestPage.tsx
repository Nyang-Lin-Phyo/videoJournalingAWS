import { useEffect, useRef, useState } from "react";
import { ErrorNotice } from "../components/Feedback";
import { Icon } from "../components/Icon";
import { VideoPreview } from "../components/VideoPreview";
import { fileSize, validateVideo } from "../api/validation";
import { uploadMp4 } from "./uploadToS3";
import { fetchAnalysis, type AnalysisResult } from "./analysisApi";
import { AnalysisPanel } from "../components/AnalysisPanel";

type Result = { upload_id: string; object_key: string };

export function CloudIngestPage() {
  const [file, setFile] = useState<File | null>(null);
  const [activeUploadId, setActiveUploadId] = useState<string | null>(() => {
    try { return window.localStorage.getItem("reverie_last_demo_upload_id"); }
    catch { return null; }
  });
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<"signing" | "uploading" | null>(null);
  const [progress, setProgress] = useState(0);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);

  useEffect(() => () => {
    controller.current?.abort();
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  useEffect(() => {
    if (!activeUploadId) return;
    const controller = new AbortController();
    let finished = false;
    async function check() {
      try {
        const updated = await fetchAnalysis(activeUploadId!, controller.signal);
        if (controller.signal.aborted) return;
        setAnalysisResult(updated);
        setAnalysisError(null);
        if (updated.status === "completed" || updated.status === "failed") finished = true;
      } catch (error) {
        if (!controller.signal.aborted) {
          setAnalysisError(error instanceof Error ? error.message : "Results polling failed.");
        }
      }
    }
    void check();
    const timer = window.setInterval(() => { if (!finished) void check(); }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [activeUploadId]);

  function selectFile(selected: File | undefined) {
    if (!selected || busy.current) return;
    const issue = validateVideo(selected);
    setError(issue);
    if (issue) return;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(selected);
    previewRef.current = url;
    setPreview(url);
    setFile(selected);
    setResult(null);
    setProgress(0);
  }

  async function upload() {
    if (!file || busy.current) return;
    const issue = validateVideo(file);
    if (issue) { setError(issue); return; }
    busy.current = true;
    setError(null);
    setResult(null);
    setProgress(0);
    setActiveUploadId(null);
    setAnalysisResult(null);
    setAnalysisError(null);
    const current = new AbortController();
    controller.current = current;
    try {
      const uploaded = await uploadMp4(file, setStage, setProgress, current.signal);
      if (!current.signal.aborted) {
        setResult(uploaded);
        setActiveUploadId(uploaded.upload_id);
        try { window.localStorage.setItem("reverie_last_demo_upload_id", uploaded.upload_id); } catch { /* optional */ }
      }
    } catch (e) {
      if (!current.signal.aborted) setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      busy.current = false;
      setStage(null);
    }
  }

  const stageLabel = stage === "signing" ? "Preparing secure upload…" : "Uploading to S3…";
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">PART 2 · TRANSCRIPTION & INSIGHTS</div>
        <h1>A moment for you.</h1>
        <p>Upload a fictional spoken MP4. The recording is stored privately in S3, transcribed by ElevenLabs Scribe, then analyzed with Gemini.</p>
      </div>
      <div className="upload-layout">
        <section className="panel upload-panel" aria-labelledby="cloud-upload-heading">
          <div className="panel-heading"><span className="step-number">01</span><div><h2 id="cloud-upload-heading">Choose your video</h2><p>An MP4, up to 30 MiB.</p></div></div>
          <div className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragOver={e => { e.preventDefault(); if (!stage) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length > 1) setError("Choose one video at a time."); else selectFile(e.dataTransfer.files[0]); }}>
            <span className="upload-icon"><Icon name="upload" size={29} /></span>
            <h3>{file ? "A different moment in mind?" : "Drop your video here"}</h3>
            <p>or choose a file from your device</p>
            <button className="button button-secondary" disabled={!!stage} onClick={() => input.current?.click()}>{file ? "Change video" : "Choose MP4 video"}</button>
            <input ref={input} className="visually-hidden" type="file" accept=".mp4,video/mp4" aria-label="Choose MP4 video" disabled={!!stage}
              onChange={e => { selectFile(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          {file && <div className="selected-file"><span className="file-icon"><Icon name="video" /></span><div><strong>{file.name}</strong><span>{fileSize(file.size)} · Original video</span></div><Icon name="check" size={19} /></div>}
          {error && <ErrorNotice message={error} />}
          {result && <div className="cloud-upload-success" role="status"><strong>Upload complete — saved in your private S3 bucket.</strong><p>Object key: <code>{result.object_key}</code></p><p>Transcription and AI analysis will begin automatically. Watch the status below.</p></div>}
          <div className="upload-action">
            <button className="button button-primary" disabled={!file || !!stage} onClick={() => void upload()}>{stage ? <span className="spinner" /> : <Icon name="upload" size={18} />} {stage ? stageLabel : result ? "Upload another copy" : "Upload to S3"}</button>
            {stage && <div className="cloud-progress-wrap" role="status"><progress max={100} value={progress} aria-label="Upload progress" /><span>{stage === "signing" ? "Requesting temporary S3 upload form" : `${progress}% uploaded`}</span></div>}
            <p>Demo only: this site has no login. Use synthetic test videos, not personal recordings.</p>
          </div>
        </section>
        <aside className="upload-aside">
          <section className="panel preview-panel"><div className="section-label"><Icon name="video" size={17} /> YOUR PREVIEW</div><VideoPreview key={preview} src={preview} /><p className="fine-print">Preview is local to your browser. Uploading sends the MP4 directly to your private S3 bucket.</p></section>
          <div className="how-it-works"><h3>How this demo works</h3><ol><li><span>1</span><div><strong>Choose a test video</strong><p>Pick an MP4 under 30 MiB.</p></div></li><li><span>2</span><div><strong>Get signed upload fields</strong><p>API Gateway and Lambda provide a five-minute S3 upload form.</p></div></li><li><span>3</span><div><strong>Upload straight to S3</strong><p>The upload triggers ElevenLabs Scribe, then Gemini analysis.</p></div></li></ol></div>
        </aside>
      </div>
      {activeUploadId && <section className="cloud-results" aria-live="polite">
          <div className="panel">
            <div className="section-label"><Icon name="spark" /> TRANSCRIPTION & REFLECTION</div>
            <h2>AI processing</h2>
            <p className="muted">Upload ID: <code>{activeUploadId}</code></p>
            <p>Current status: <strong>{analysisResult?.status ?? "checking"}</strong></p>
            {analysisError && <ErrorNotice message={analysisError} />}
            {analysisResult?.status === "failed" && <ErrorNotice message={analysisResult.error ?? "Processing failed."} />}
            {analysisResult && !["failed", "completed"].includes(analysisResult.status) &&
              <p className="muted">This can take a few minutes. The page checks for results every five seconds.</p>}
            {analysisResult?.transcript && <details open className="cloud-transcript">
              <summary>Transcript</summary>
              <p>{analysisResult.transcript}</p>
            </details>}
          </div>
          {analysisResult?.analysis && <AnalysisPanel analysis={analysisResult.analysis} />}
      </section>}
    </>
  );
}

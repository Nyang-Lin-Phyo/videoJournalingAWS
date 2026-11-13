import { useEffect, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";
import { ErrorNotice } from "../components/Feedback";
import { Icon } from "../components/Icon";
import { VideoPreview } from "../components/VideoPreview";
import { fileSize, validateVideo } from "../api/validation";
import { uploadMp4 } from "./uploadToS3";
import { fetchAnalysis, fetchJournals, type AnalysisResult, type JournalSummary } from "./analysisApi";
import { AnalysisPanel } from "../components/AnalysisPanel";

type Result = { upload_id: string; object_key: string };

export function CloudIngestPage() {
  const auth = useAuth();
  const userSub = auth.user?.profile.sub ?? "";
  const accessToken = auth.user?.access_token ?? "";
  const storageKey = `reverie_last_upload_${userSub}`;
  const [file, setFile] = useState<File | null>(null);
  const [activeUploadId, setActiveUploadId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(storageKey); }
    catch { return null; }
  });
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [journals, setJournals] = useState<JournalSummary[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
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
        const updated = await fetchAnalysis(activeUploadId!, accessToken, controller.signal);
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
  }, [activeUploadId, accessToken]);

  // Keep history scoped to the authenticated Cognito user; the API enforces ownership.
  useEffect(() => {
    if (!accessToken) { setJournals([]); return; }
    const current = new AbortController();
    void fetchJournals(accessToken, current.signal).then(data => {
      if (!current.signal.aborted) { setJournals(data.journals); setHistoryError(null); }
    }).catch(error => {
      if (!current.signal.aborted) setHistoryError(error instanceof Error ? error.message : "Unable to load history.");
    });
    return () => current.abort();
  }, [accessToken, result?.upload_id, analysisResult?.status]);

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
      const uploaded = await uploadMp4(file, setStage, setProgress, accessToken, current.signal);
      if (!current.signal.aborted) {
        setResult(uploaded);
        setActiveUploadId(uploaded.upload_id);
        try { window.localStorage.setItem(storageKey, uploaded.upload_id); } catch { /* optional */ }
      }
    } catch (e) {
      if (!current.signal.aborted) setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      busy.current = false;
      setStage(null);
    }
  }

  useEffect(() => {
    setActiveUploadId(userSub ? window.localStorage.getItem(storageKey) : null);
    setAnalysisResult(null);
  }, [userSub, storageKey]);

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
            <p>Signed-in test mode. Use synthetic test videos until the authenticated backend cutover and privacy tests pass.</p>
          </div>
        </section>
        <aside className="upload-aside">
          <section className="panel preview-panel"><div className="section-label"><Icon name="video" size={17} /> YOUR PREVIEW</div><VideoPreview key={preview} src={preview} /><p className="fine-print">Preview is local to your browser. Uploading sends the MP4 directly to your private S3 bucket.</p></section>
          <div className="how-it-works"><h3>How this demo works</h3><ol><li><span>1</span><div><strong>Choose a test video</strong><p>Pick an MP4 under 30 MiB.</p></div></li><li><span>2</span><div><strong>Get signed upload fields</strong><p>API Gateway and Lambda provide a five-minute S3 upload form.</p></div></li><li><span>3</span><div><strong>Upload straight to S3</strong><p>The upload triggers ElevenLabs Scribe, then Gemini analysis.</p></div></li></ol></div>
        </aside>
      </div>
      <section className="panel" aria-label="My journal history" style={{ marginTop: 24, padding: 24 }}>
        <h2>Your journal history</h2>
        {historyError && <ErrorNotice message={historyError} />}
        {journals.length === 0 && !historyError && <p className="muted">No entries yet.</p>}
        {journals.map(journal => (
          <button key={journal.upload_id} type="button" className="button button-secondary"
            style={{ display: "block", marginTop: 10, width: "100%", textAlign: "left" }}
            onClick={() => { setAnalysisResult(null); setActiveUploadId(journal.upload_id); }}>
            {new Date(journal.created_at).toLocaleString()} · {journal.status} · {journal.sentiment ?? "no sentiment yet"}
          </button>
        ))}
      </section>
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

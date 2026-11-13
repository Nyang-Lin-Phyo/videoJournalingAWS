import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { journalApi, useMockApi } from "../api/client";
import type { CreateJournalResponse, JournalApi } from "../api/types";
import { submitJournal } from "../api/httpClient";
import { errorMessage, isAbort } from "../api/errors";
import { fileSize, validateVideo } from "../api/validation";
import { Icon } from "../components/Icon";
import { VideoPreview } from "../components/VideoPreview";
import { ErrorNotice } from "../components/Feedback";
export function UploadPage({ api = journalApi }: { api?: JournalApi }) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<
    "creating" | "uploading" | "queueing" | null
  >(null);
  const [created, setCreated] = useState<CreateJournalResponse | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );
  function selectFile(selected: File | undefined) {
    if (!selected || busy.current) return;
    const invalid = validateVideo(selected);
    setError(invalid);
    if (!invalid) {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      const url = URL.createObjectURL(selected);
      previewRef.current = url;
      setPreview(url);
      setFile(selected);
      setCreated(null);
    }
  }
  async function upload() {
    if (!file || busy.current) return;
    const invalid = validateVideo(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    busy.current = true;
    setError(null);
    setCreated(null);
    controller.current = new AbortController();
    try {
      const result = await submitJournal(
        api,
        file,
        setStage,
        setCreated,
        controller.current.signal,
      );
      if (!controller.current.signal.aborted)
        navigate(`/journals/${result.id}`);
    } catch (err) {
      if (!isAbort(err)) setError(errorMessage(err));
    } finally {
      busy.current = false;
      setStage(null);
    }
  }
  const stageText =
    stage === "creating"
      ? "Creating your entry…"
      : stage === "uploading"
        ? "Uploading your video…"
        : "Starting your reflection…";
  return (
    <>
      <Link className="back-link" to="/">
        <Icon name="back" size={17} /> Back to your journal
      </Link>
      <div className="page-heading">
        <div className="eyebrow">A LITTLE CHECK-IN WITH YOURSELF</div>
        <h1>A moment for you.</h1>
        <p>
          Bring a video. We’ll help you revisit the words and feelings within
          it.
        </p>
      </div>
      <div className="upload-layout">
        <section
          className="panel upload-panel"
          aria-labelledby="upload-heading"
        >
          <div className="panel-heading">
            <span className="step-number">01</span>
            <div>
              <h2 id="upload-heading">Choose your video</h2>
              <p>An MP4, up to 30 MiB.</p>
            </div>
          </div>
          <div
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!stage) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (event.dataTransfer.files.length > 1)
                setError("Choose one video at a time.");
              else selectFile(event.dataTransfer.files[0]);
            }}
          >
            <span className="upload-icon">
              <Icon name="upload" size={29} />
            </span>
            <h3>
              {file ? "A different moment in mind?" : "Drop your video here"}
            </h3>
            <p>or choose a file from your device</p>
            <button
              className="button button-secondary"
              disabled={!!stage}
              onClick={() => input.current?.click()}
            >
              {file ? "Change video" : "Choose MP4 video"}
            </button>
            <input
              ref={input}
              className="visually-hidden"
              type="file"
              accept=".mp4,video/mp4"
              aria-label="Choose MP4 video"
              disabled={!!stage}
              onChange={(event) => {
                selectFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
          {file && (
            <div className="selected-file">
              <span className="file-icon">
                <Icon name="video" />
              </span>
              <div>
                <strong>{file.name}</strong>
                <span>{fileSize(file.size)} · Original video</span>
              </div>
              <Icon name="check" size={19} />
            </div>
          )}
          {error && <ErrorNotice message={error} />}
          {error && created && (
            <p className="fine-print">
              An incomplete entry may have been created.{" "}
              <Link to={`/journals/${created.journal.id}`}>
                View its status
              </Link>{" "}
              before trying again. Retrying creates a new entry.
            </p>
          )}
          <div className="upload-action">
            <button
              className="button button-primary"
              disabled={!file || !!stage}
              onClick={() => {
                void upload();
              }}
            >
              {stage ? (
                <span className="spinner" />
              ) : (
                <Icon name="spark" size={18} />
              )}{" "}
              {stage ? stageText : "Upload & reflect"}
              {!stage && <Icon name="arrow" size={17} />}
            </button>
            <p role="status">
              {stage
                ? "Keep this page open while your video uploads."
                : useMockApi
                  ? "Demo/mock results. Your video stays in this browser session."
                  : "Your video is sent to your configured local API for processing."}
            </p>
          </div>
        </section>
        <aside className="upload-aside">
          <section className="panel preview-panel">
            <div className="section-label">
              <Icon name="video" size={17} /> YOUR PREVIEW
            </div>
            <VideoPreview key={preview} src={preview} />
            <p className="fine-print">
              Take a look before you upload. You’re always in control of what
              you share.
            </p>
          </section>
          <div className="how-it-works">
            <h3>A few words become a reflection.</h3>
            <ol>
              <li>
                <span>1</span>
                <div>
                  <strong>Save your moment</strong>
                  <p>Upload a video from your device.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Find the words</strong>
                  <p>Follow transcription and analysis as they happen.</p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Come back to yourself</strong>
                  <p>Revisit the video, transcript, and a short reflection.</p>
                </div>
              </li>
            </ol>
          </div>
        </aside>
      </div>
    </>
  );
}

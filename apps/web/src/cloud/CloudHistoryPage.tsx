import { useEffect, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";
import { ErrorNotice } from "../components/Feedback";
import { Icon } from "../components/Icon";
import { ReflectionPanel } from "./ReflectionPanel";
import {
  deleteJournal, fetchAnalysis, fetchJournals, fetchVideoUrl, renameJournal,
  type AnalysisResult, type JournalSummary,
} from "./analysisApi";

const MAX_CACHED_VIDEOS = 3;

export function CloudHistoryPage({ active, refreshKey, onDeleted }: {
  active: boolean; refreshKey: number; onDeleted?: () => void;
}) {
  const auth = useAuth();
  const token = auth.user?.access_token ?? "";
  const userSub = auth.user?.profile.sub ?? "";
  const [journals, setJournals] = useState<JournalSummary[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [version, setVersion] = useState(0);
  const details = useRef(new Map<string, AnalysisResult>());
  const videos = useRef(new Map<string, string>());
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    videos.current.forEach(url => URL.revokeObjectURL(url));
    videos.current.clear();
    details.current.clear();
  }, []);

  useEffect(() => {
    if (!active || !token) return;
    const controller = new AbortController();
    setLoadingList(true);
    void fetchJournals(token, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setJournals(data.journals);
        setNextToken(data.next_token);
        setListError(null);
      })
      .catch(error => {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "Unable to load journals.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingList(false); });
    return () => controller.abort();
  }, [active, token, refreshKey]);

  async function loadMore() {
    if (!nextToken || !token || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchJournals(token, undefined, nextToken);
      setJournals(old => {
        const known = new Set(old.map(journal => journal.upload_id));
        return [...old, ...data.journals.filter(journal => !known.has(journal.upload_id))];
      });
      setNextToken(data.next_token);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Unable to load more journals.");
    } finally {
      setLoadingMore(false);
    }
  }

  function expand(journal: JournalSummary) {
    const id = journal.upload_id;
    request.current?.abort();
    request.current = null;
    setDetailError(null);
    setEditingId(null);
    if (openId === id) {
      setOpenId(null);
      setLoadingDetail(false);
      return;
    }
    setOpenId(id);
    if (journal.status === "deleting") {
      setLoadingDetail(false);
      return;
    }
    const previousDetail = details.current.get(id);
    const hasFinishedDetail = previousDetail && ["completed", "failed"].includes(previousDetail.status);
    if (hasFinishedDetail && videos.current.has(id)) {
      setLoadingDetail(false); // Cached MP4 and reflection, no new network requests.
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setLoadingDetail(true);
    void (async () => {
      try {
        if (!hasFinishedDetail) {
          const info = await fetchAnalysis(id, token, controller.signal);
          if (controller.signal.aborted) return;
          details.current.set(id, info);
          setVersion(n => n + 1);
        }
        if (!videos.current.has(id) && journal.status !== "awaiting_upload") {
          const signed = await fetchVideoUrl(id, token, controller.signal);
          // The S3 URL itself is signed. No Cognito bearer token is sent to S3.
          const response = await fetch(signed.url, { signal: controller.signal, cache: "no-store" });
          if (!response.ok) throw new Error(`Video download failed (HTTP ${response.status}).`);
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          if (blob.size > 35 * 1024 * 1024) throw new Error("Unexpected video size.");
          const url = URL.createObjectURL(blob);
          videos.current.set(id, url);
          while (videos.current.size > MAX_CACHED_VIDEOS) {
            const oldest = videos.current.keys().next().value;
            if (!oldest) break;
            URL.revokeObjectURL(videos.current.get(oldest)!);
            videos.current.delete(oldest);
          }
          setVersion(n => n + 1);
        }
      } catch (error) {
        if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "Unable to open journal.");
      } finally {
        if (!controller.signal.aborted) setLoadingDetail(false);
      }
    })();
  }

  async function saveTitle(journal: JournalSummary) {
    if (!token || busyId) return;
    const title = editTitle.trim();
    if (!title || title.length > 100 || /[\x00-\x1f\x7f]/.test(title)) {
      setDetailError("Use a title between 1 and 100 characters.");
      return;
    }
    setBusyId(journal.upload_id);
    setDetailError(null);
    try {
      const updated = await renameJournal(journal.upload_id, title, token);
      setJournals(old => old.map(entry => entry.upload_id === journal.upload_id ? {...entry, title: updated.title} : entry));
      const cached = details.current.get(journal.upload_id);
      if (cached) details.current.set(journal.upload_id, {...cached, title: updated.title});
      setEditingId(null);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Unable to rename journal.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(journal: JournalSummary) {
    if (!token || busyId) return;
    if (!window.confirm(`Permanently delete “${journal.title || "Untitled"}” and its video and saved reflection? This cannot be undone.`)) return;
    setBusyId(journal.upload_id);
    setDetailError(null);
    try {
      request.current?.abort();
      await deleteJournal(journal.upload_id, token);
      const cached = videos.current.get(journal.upload_id);
      if (cached) URL.revokeObjectURL(cached);
      videos.current.delete(journal.upload_id);
      details.current.delete(journal.upload_id);
      setJournals(old => old.filter(entry => entry.upload_id !== journal.upload_id));
      setOpenId(null);
      setEditingId(null);
      try {
        const key = `reverie_last_upload_${userSub}`;
        if (window.localStorage.getItem(key) === journal.upload_id) window.localStorage.removeItem(key);
      } catch { /* storage may be unavailable */ }
      onDeleted?.();
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Unable to delete journal. Please retry.");
    } finally {
      setBusyId(null);
    }
  }

  void version; // Force updates after a background MP4 Blob has been cached.
  const opened = openId ? details.current.get(openId) : undefined;
  const videoUrl = openId ? videos.current.get(openId) : undefined;

  return (
    <>
      <div className="page-heading history-intro">
        <div className="eyebrow">YOUR PRIVATE NOTEBOOK</div>
        <h1>Journal history.</h1>
        <p>Revisit your moments. Click a title to open or close its video and reflection.</p>
      </div>
      {listError && <ErrorNotice message={listError} />}
      {loadingList && <p className="muted">Loading journals…</p>}
      {!loadingList && journals.length === 0 && !listError &&
        <section className="panel" style={{padding:24}}><p>No journals yet. Upload your first moment to get started.</p></section>}
      <div className="history-entries">
        {journals.map(journal => (
          <section className="panel history-entry" key={journal.upload_id}>
            <button className="history-toggle" type="button" aria-expanded={openId === journal.upload_id}
              aria-controls={`journal-content-${journal.upload_id}`} onClick={() => expand(journal)}>
              <span>
                <span className="history-title">{journal.title || "Untitled"}</span>
                <span className="history-status">{journal.status === "completed" ? "Reflection ready" : journal.status === "deleting" ? "Cleanup needs attention" : journal.status === "failed" ? "Reflection unavailable" : "Preparing your reflection"}</span>
              </span>
              <span className="history-title-right">
                <span className="history-date">{new Date(journal.created_at).toLocaleDateString()}</span>
                <Icon name={openId === journal.upload_id ? "back" : "arrow"} size={18}/>
              </span>
            </button>
            {openId === journal.upload_id && (
              <div className="history-detail" id={`journal-content-${journal.upload_id}`}>
                {loadingDetail && <p className="muted">Loading your saved moment…</p>}
                {detailError && <ErrorNotice message={detailError} />}
                {journal.status !== "deleting" && videoUrl &&
                  <video controls preload="metadata" src={videoUrl} aria-label={`Video for ${journal.title || "Untitled"}`}/>}
                {opened?.analysis && <ReflectionPanel reflection={opened.analysis}/>}
                {opened?.status === "failed" && <p className="muted">This reflection could not be completed.</p>}
                {opened && !opened.analysis && opened.status !== "failed" &&
                  <p className="muted">Your reflection is still being prepared.</p>}
                <div className="history-actions">
                  {editingId === journal.upload_id ? (
                    <form onSubmit={event => { event.preventDefault(); void saveTitle(journal); }} className="history-edit-form">
                      <label htmlFor={`rename-${journal.upload_id}`}>Edit title</label>
                      <input id={`rename-${journal.upload_id}`} value={editTitle} maxLength={100}
                        onChange={event => setEditTitle(event.target.value)} disabled={!!busyId}/>
                      <button className="button button-primary" type="submit" disabled={!!busyId || !editTitle.trim()}>Save title</button>
                      <button className="button button-secondary" type="button" disabled={!!busyId} onClick={() => setEditingId(null)}>Cancel</button>
                    </form>
                  ) : journal.status !== "deleting" ? (
                    <button type="button" className="button button-secondary" disabled={!!busyId}
                      onClick={() => { setEditTitle(journal.title || "Untitled"); setEditingId(journal.upload_id); setDetailError(null); }}>
                      Rename
                    </button>
                  ) : null}
                  <button type="button" className="button button-secondary history-delete" disabled={!!busyId}
                    onClick={() => void remove(journal)}>{busyId === journal.upload_id ? "Deleting…" : journal.status === "deleting" ? "Retry deletion" : "Delete journal"}</button>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>
      {nextToken && <button type="button" className="button button-secondary" disabled={loadingMore}
        onClick={() => void loadMore()} style={{marginTop:18}}>{loadingMore ? "Loading…" : "Load more journals"}</button>}
    </>
  );
}

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
  // Store short-lived S3 URLs, not downloaded MP4 blobs. The mounted <video>
  // elements retain the browser's buffered content across collapse/reopen.
  const videos = useRef(new Map<string, string>());
  const mediaElements = useRef(new Map<string, HTMLVideoElement>());
  const [videoErrorId, setVideoErrorId] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const lastLoadedListKey = useRef<string | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    mediaElements.current.forEach(element => element.pause());
    mediaElements.current.clear();
    videos.current.clear();
    details.current.clear();
  }, []);

  // Keep the player mounted (and its browser-managed buffer) when hidden,
  // but never let audio continue playing after collapse or tab navigation.
  useEffect(() => {
    mediaElements.current.forEach((element, id) => {
      if (!active || id !== openId) element.pause();
    });
  }, [active, openId]);

  useEffect(() => {
    if (!active || !token || !userSub) return;

    // Keep the list cached across tab switches. A new upload or deletion
    // changes refreshKey and explicitly invalidates this list cache.
    const listKey = `${userSub}:${refreshKey}`;
    if (lastLoadedListKey.current === listKey) return;

    const controller = new AbortController();
    // Rapid tab changes cancel this short delay before any request is made.
    const timer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setLoadingList(true);
      void fetchJournals(token, controller.signal)
        .then(data => {
          if (controller.signal.aborted) return;
          setJournals(data.journals);
          setNextToken(data.next_token);
          lastLoadedListKey.current = listKey;
          setListError(null);
        })
        .catch(error => {
          if (!controller.signal.aborted) {
            setListError(error instanceof Error ? error.message : "Unable to load journals.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingList(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, token, userSub, refreshKey]);

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
    setVideoErrorId(null);
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
      // Touch this entry so the three-player cache evicts least-recently used.
      const cachedUrl = videos.current.get(id)!;
      videos.current.delete(id);
      videos.current.set(id, cachedUrl);
      setLoadingDetail(false); // Cached player and reflection: no API call.
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
          if (controller.signal.aborted) return;
          // The browser loads only the data it needs through HTTP Range GETs.
          // Do not fetch the MP4 as a Blob, and never send Cognito tokens to S3.
          videos.current.set(id, signed.url);
          while (videos.current.size > MAX_CACHED_VIDEOS) {
            const oldest = videos.current.keys().next().value;
            if (!oldest) break;
            mediaElements.current.get(oldest)?.pause();
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

  async function retryVideo(id: string) {
    if (!token || !active || openId !== id || loadingDetail) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setDetailError(null);
    setVideoErrorId(null);
    setLoadingDetail(true);
    try {
      // A private S3 URL expires after 15 minutes. Renew only when needed.
      const signed = await fetchVideoUrl(id, token, controller.signal);
      if (controller.signal.aborted) return;
      videos.current.delete(id);
      videos.current.set(id, signed.url);
      setVersion(n => n + 1);
    } catch (error) {
      if (!controller.signal.aborted) {
        setVideoErrorId(id);
        setDetailError(error instanceof Error ? error.message : "Unable to reload video.");
      }
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
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
      mediaElements.current.get(journal.upload_id)?.pause();
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

  void version; // Trigger a render when a private video URL becomes available.

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
            {/* Leave previously opened players mounted but hidden. That lets the
                browser reuse buffered video data when a journal is reopened. */}
            {(openId === journal.upload_id || videos.current.has(journal.upload_id)) && (
              <div className="history-detail" id={`journal-content-${journal.upload_id}`}
                style={{ display: openId === journal.upload_id ? undefined : "none" }}
                aria-hidden={openId !== journal.upload_id}>
                {loadingDetail && <p className="muted">Loading your saved moment…</p>}
                {detailError && <ErrorNotice message={detailError} />}
                {journal.status !== "deleting" && videos.current.has(journal.upload_id) &&
                  <video
                    controls
                    preload="metadata"
                    playsInline
                    src={videos.current.get(journal.upload_id)}
                    aria-label={`Video for ${journal.title || "Untitled"}`}
                    ref={element => {
                      if (element) mediaElements.current.set(journal.upload_id, element);
                      else mediaElements.current.delete(journal.upload_id);
                    }}
                    onError={() => {
                      if (openId === journal.upload_id) setVideoErrorId(journal.upload_id);
                    }}
                  />}
                {videoErrorId === journal.upload_id && openId === journal.upload_id && (
                  <div>
                    <p className="muted">The video couldn't load. Its private link may have expired.</p>
                    <button className="button button-secondary" type="button"
                      disabled={loadingDetail}
                      onClick={() => void retryVideo(journal.upload_id)}>Reload video</button>
                  </div>
                )}
                {details.current.get(journal.upload_id)?.analysis &&
                  <ReflectionPanel reflection={details.current.get(journal.upload_id)!.analysis!}/>}
                {details.current.get(journal.upload_id)?.status === "failed" && <p className="muted">This reflection could not be completed.</p>}
                {details.current.has(journal.upload_id) &&
                  !details.current.get(journal.upload_id)?.analysis &&
                  details.current.get(journal.upload_id)?.status !== "failed" &&
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

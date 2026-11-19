import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ErrorNotice } from "../components/Feedback";
import { Icon } from "../components/Icon";
import { ReflectionPanel } from "./ReflectionPanel";
import { TranscriptPanel } from "../components/TranscriptPanel";
import type { AnalysisResult, JournalSummary } from "./analysisApi";
import { useCloudEnvironment } from "./CloudEnvironment";
import { useTimelineScroll } from "./useTimelineScroll";
import { DayStackDialog } from "./DayStackDialog";
import { blendedCover, statusLabel } from "./historyTimeline";

const MAX_CACHED_VIDEOS = 3;
// How far each card reaches away from the spine (0 = close, 1 = farthest).
// A fixed, irregular rhythm gives the hand-drawn "branching" feel without
// cards jumping around when the list re-renders.
const BRANCH_OFFSETS = [0.05, 0.24, 1, 0.12, 0.68, 0.06, 0.32, 0.55, 0.14];

/** Local calendar day, so a late-evening upload stays on the day it was made. */
function dayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function CloudHistoryPage({ active, refreshKey, onDeleted }: {
  active: boolean; refreshKey: number; onDeleted?: () => void;
}) {
  const { userSub, accessToken: token, services } = useCloudEnvironment();
  const { deleteJournal, fetchAnalysis, fetchJournals, fetchVideoUrl, renameJournal } = services;
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
  // The day whose stacked journals are shown in the day dialog.
  const [stackKey, setStackKey] = useState<string | null>(null);
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
  }, [active, token, userSub, refreshKey, fetchJournals]);

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
      // Close the day dialog once its last journal is gone.
      const removedDay = dayKey(journal.created_at);
      if (!journals.some(entry => entry.upload_id !== journal.upload_id && dayKey(entry.created_at) === removedDay)) {
        setStackKey(key => key === removedDay ? null : key);
      }
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

  // Newest day first. Several journals on one local day become a single
  // stacked card; a month marker appears whenever the month changes.
  const timeline = useMemo(() => {
    const sorted = [...journals].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const groups: { key: string; date: Date; journals: JournalSummary[] }[] = [];
    for (const journal of sorted) {
      const key = dayKey(journal.created_at);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.journals.push(journal);
      else groups.push({ key, date: new Date(journal.created_at), journals: [journal] });
    }
    const month = (date: Date) => date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    return groups.map((group, index) => ({
      ...group,
      index,
      monthLabel: index === 0 || month(groups[index - 1].date) !== month(group.date) ? month(group.date) : null,
    }));
  }, [journals]);
  const timelineRef = useTimelineScroll<HTMLDivElement>(timeline.length);
  const stackGroup = stackKey ? timeline.find(group => group.key === stackKey && group.journals.length > 0) : undefined;

  function leaveDetail() {
    request.current?.abort();
    request.current = null;
    setOpenId(null);
    setEditingId(null);
    setDetailError(null);
    setVideoErrorId(null);
    setLoadingDetail(false);
  }

  function closeStack() {
    leaveDetail();
    setStackKey(null);
  }

  function renderDetail(journal: JournalSummary) {
    const id = journal.upload_id;
    const isOpen = openId === id;
    const detail = details.current.get(id);
    return (
      <div className="history-detail" id={`journal-content-${id}`}
        style={{ display: isOpen ? undefined : "none" }}
        aria-hidden={!isOpen}>
        {loadingDetail && <p className="muted">Loading your saved moment…</p>}
        {detailError && <ErrorNotice message={detailError} />}
        {journal.status !== "deleting" && videos.current.has(id) &&
          <video
            controls
            preload="metadata"
            playsInline
            src={videos.current.get(id)}
            aria-label={`Video for ${journal.title || "Untitled"}`}
            ref={element => {
              if (element) mediaElements.current.set(id, element);
              else mediaElements.current.delete(id);
            }}
            onError={() => {
              if (openId === id) setVideoErrorId(id);
            }}
          />}
        {videoErrorId === id && isOpen && (
          <div>
            <p className="muted">The video couldn't load. Its private link may have expired.</p>
            <button className="button button-secondary" type="button"
              disabled={loadingDetail}
              onClick={() => void retryVideo(id)}>Reload video</button>
          </div>
        )}
        {active && isOpen && detail && (
          <>
            <TranscriptPanel transcript={detail.transcript}
              title={journal.title || "Untitled"}
              pending={["awaiting_upload", "queued", "transcribing", "analyzing"].includes(detail.status)} />
            {detail.transcript_error && <ErrorNotice message={detail.transcript_error} />}
          </>
        )}
        {detail?.analysis && <ReflectionPanel reflection={detail.analysis}/>}
        {detail?.status === "failed" && <p className="muted">This reflection could not be completed.</p>}
        {detail && !detail.analysis && detail.status !== "failed" &&
          <p className="muted">Your reflection is still being prepared.</p>}
        <div className="history-actions">
          {editingId === id ? (
            <form onSubmit={event => { event.preventDefault(); void saveTitle(journal); }} className="history-edit-form">
              <label htmlFor={`rename-${id}`}>Edit title</label>
              <input id={`rename-${id}`} value={editTitle} maxLength={100}
                onChange={event => setEditTitle(event.target.value)} disabled={!!busyId}/>
              <button className="button button-primary" type="submit" disabled={!!busyId || !editTitle.trim()}>Save title</button>
              <button className="button button-secondary" type="button" disabled={!!busyId} onClick={() => setEditingId(null)}>Cancel</button>
            </form>
          ) : journal.status !== "deleting" ? (
            <button type="button" className="button button-secondary" disabled={!!busyId}
              onClick={() => { setEditTitle(journal.title || "Untitled"); setEditingId(id); setDetailError(null); }}>
              Rename
            </button>
          ) : null}
          <button type="button" className="button button-secondary history-delete" disabled={!!busyId}
            onClick={() => void remove(journal)}>{busyId === id ? "Deleting…" : journal.status === "deleting" ? "Retry deletion" : "Delete journal"}</button>
        </div>
      </div>
    );
  }

  void version; // Trigger a render when a private video URL becomes available.

  return (
    <>
      <div className="page-heading history-intro">
        <div className="eyebrow">YOUR PRIVATE NOTEBOOK</div>
        <h1>Journal history.</h1>
        <p>Revisit your moments. Click a title to open its video, transcript, and reflection. Days with several videos are stacked together.</p>
      </div>
      {listError && <ErrorNotice message={listError} />}
      {loadingList && <p className="muted">Loading journals…</p>}
      {!loadingList && journals.length === 0 && !listError &&
        <section className="panel" style={{padding:24}}><p>No journals yet. Upload your first moment to get started.</p></section>}
      <div className="history-entries timeline" ref={timelineRef}>
        {timeline.length > 0 && <span className="tl-spine" aria-hidden="true"><span className="tl-spine-fill"/></span>}
        {timeline.length > 0 && <div className="tl-cap tl-cap-top" data-reveal><span className="tl-cap-dot"/>Today</div>}
        {timeline.map(group => {
          const { date, index, monthLabel } = group;
          const journal = group.journals[0];
          const count = group.journals.length;
          const isStack = count > 1;
          const isOpen = isStack ? stackKey === group.key : openId === journal.upload_id;
          const day = date.toLocaleDateString(undefined, { day: "numeric" });
          return (
            <Fragment key={group.key}>
              {monthLabel && <div className="tl-month" data-reveal><span>{monthLabel}</span></div>}
              <section data-reveal
                className={`tl-item tl-mood-${isStack ? "mixed" : journal.sentiment ?? "pending"}${isOpen && !isStack ? " is-open" : ""}${isStack ? " is-stack" : ""}${index === 0 ? " is-latest" : ""}`}
                style={{
                  "--tl-offset": BRANCH_OFFSETS[index % BRANCH_OFFSETS.length],
                  ...(isStack ? { "--tl-cover": blendedCover(group.journals) } : {}),
                } as CSSProperties}>
                <span className="tl-date" aria-hidden="true">
                  <span className="tl-date-day">{day}</span>
                  <span className="tl-date-month">{date.toLocaleDateString(undefined, { month: "short" })}</span>
                </span>
                <span className="tl-node" aria-hidden="true"/>
                <span className="tl-branch" aria-hidden="true"/>
                <div className="tl-card-slot">
                  {isStack && <>
                    {count > 2 && <span className="tl-stack-layer tl-stack-layer-2" aria-hidden="true"/>}
                    <span className="tl-stack-layer tl-stack-layer-1" aria-hidden="true"/>
                    <span className="tl-stack-count" aria-hidden="true">{count}</span>
                  </>}
                  <div className="panel history-entry tl-card">
                    {isStack ? (
                      <button className="history-toggle" type="button" aria-haspopup="dialog"
                        aria-expanded={isOpen} onClick={() => { leaveDetail(); setStackKey(group.key); }}>
                        <span className="tl-cover" aria-hidden="true">
                          <span className="tl-cover-day">{day}</span>
                          <span className="tl-cover-week">{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
                        </span>
                        <span className="tl-text">
                          <span className="history-title">{count} moments</span>
                          <span className="history-status tl-stack-titles">
                            {group.journals.map(entry => entry.title || "Untitled").join(" · ")}
                          </span>
                        </span>
                        <span className="history-title-right">
                          <span className="history-date">{date.toLocaleDateString()}</span>
                          <Icon name="arrow" size={18}/>
                        </span>
                      </button>
                    ) : (
                      <>
                        <button className="history-toggle" type="button" aria-expanded={isOpen}
                          aria-controls={`journal-content-${journal.upload_id}`} onClick={() => expand(journal)}>
                          <span className="tl-cover" aria-hidden="true">
                            <span className="tl-cover-day">{day}</span>
                            <span className="tl-cover-week">{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
                          </span>
                          <span className="tl-text">
                            <span className="history-title">{journal.title || "Untitled"}</span>
                            <span className="history-status">{statusLabel(journal.status)}</span>
                          </span>
                          <span className="history-title-right">
                            <span className="history-date">{date.toLocaleDateString()}</span>
                            <Icon name={isOpen ? "back" : "arrow"} size={18}/>
                          </span>
                        </button>
                        {/* Leave previously opened players mounted but hidden. That lets the
                            browser reuse buffered video data when a journal is reopened. */}
                        {(isOpen || videos.current.has(journal.upload_id)) && renderDetail(journal)}
                      </>
                    )}
                  </div>
                </div>
              </section>
            </Fragment>
          );
        })}
        {timeline.length > 0 && (
          <div className="tl-cap tl-cap-end" data-reveal>
            <span className="tl-cap-dot"/>
            {nextToken
              ? <button type="button" className="button button-secondary" disabled={loadingMore}
                  onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more journals"}</button>
              : <span>Where it all began</span>}
          </div>
        )}
      </div>
      {active && stackGroup && (
        <DayStackDialog
          date={stackGroup.date}
          journals={stackGroup.journals}
          openId={openId}
          onSelect={journal => expand(journal)}
          onBack={leaveDetail}
          onClose={closeStack}
          renderDetail={journal => renderDetail(journal)}
        />
      )}
    </>
  );
}

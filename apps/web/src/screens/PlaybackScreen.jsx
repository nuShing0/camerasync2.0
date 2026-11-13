import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";
import {
  createSessionNote,
  deleteAngle,
  deleteSessionNote,
  getSessionNotes,
  deleteRecording,
  getSessionVideos,
  mediaCors,
  uploadSessionVideo,
} from "../api/recordings.js";
import { DownloadButton } from "../components/DownloadButton.jsx";
import { anglesPerPage, commonAspect, layoutAngles } from "../recording/angleLayout.js";
import { JUMP_BEYOND_MS, speedFor } from "../recording/angleSync.js";
import { angleTrims } from "../recording/angleTrims.js";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";

// The page at /watch/:sessionId, or (with `live`) the same view shown over
// a live session's page so watching doesn't leave the session: `live` is
// { sessionId, onClose }, and the chosen recording is kept here instead of
// in the URL, which belongs to the session page.
export function PlaybackScreen({ live = null } = {}) {
  const params = useParams();
  const sessionId = live?.sessionId ?? params.sessionId;
  const { user } = useAuth();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [recordings, setRecordings] = useState([]);
  // Whether this user can delete recordings (an admin of the group).
  const [canDelete, setCanDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState([]);
  const [notesError, setNotesError] = useState("");
  const videoTime = useRef(0);
  const seek = useRef(null);
  // The player's layout buttons sit in the title row, so the angles get
  // the height a row of their own would take.
  const [toolsSlot, setToolsSlot] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    getSessionVideos(sessionId)
      .then((data) => {
        if (cancelled) return;
        setSession(data.session);
        setRecordings(data.recordings);
        setCanDelete(Boolean(data.canDelete));
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Deletes a recording with every angle, after asking: the open one (then
  // back to the list), or one from the list (staying there).
  const removeRecording = async (target, index, fromList) => {
    const name = takeName(target, index);
    if (!window.confirm(`Delete ${name}? Every angle of it and its comments go too. This can't be undone.`)) return;
    setDeleting(true);
    try {
      await deleteRecording(sessionId, target.startedAt);
      const data = await getSessionVideos(sessionId);
      setRecordings(data.recordings);
      if (fromList) return;
      if (live) setLiveChoice(0);
      else navigate(`/watch/${sessionId}`, { replace: true });
    } catch (err) {
      window.alert(err.message);
    } finally {
      setDeleting(false);
    }
  };

  // A session opens on its list of recordings (takes); ?recording=N plays
  // one. A session with a single recording goes straight to it.
  const [searchParams] = useSearchParams();
  // Over a live session it can open on one recording (live.initial, its number).
  const [liveChoice, setLiveChoice] = useState(live?.initial ?? 0);
  const chosen = live ? liveChoice : Number(searchParams.get("recording"));
  const chosenIndex = chosen
    ? recordings.findIndex((recording, index) => (recording.number ?? index + 1) === chosen)
    : -1;
  const recordingIndex = chosenIndex >= 0 ? chosenIndex : recordings.length === 1 ? 0 : null;
  const recording = recordingIndex === null ? null : recordings[recordingIndex];
  const startedAt = recording?.startedAt;
  const showingList = recordings.length > 1 && recordingIndex === null;

  // A live session's takes show up as their uploads finish. While a take is
  // being watched, only when one of its angles is still on its way (missing,
  // or just the preview so far), so it fills in without a refresh.
  // Every 3 s while an angle is uploading, so its progress bar moves.
  const filling = Boolean(recording?.videos.some((video) =>
    stillUploading(video, recording.startedAt) || video.previewOnly));
  useAutoRefresh(() => {
    if (recording && !filling) return;
    getSessionVideos(sessionId)
      .then((data) => setRecordings(data.recordings))
      .catch(() => {});
  }, filling ? 3000 : 10000);

  useEffect(() => {
    if (!startedAt) return;
    let cancelled = false;
    setNotesError("");
    getSessionNotes(sessionId, startedAt)
      .then((loaded) => { if (!cancelled) setNotes(loaded); })
      .catch((err) => { if (!cancelled) setNotesError(err.message); });
    return () => { cancelled = true; };
  }, [sessionId, startedAt]);

  return (
    <div className="playback-page">
      <style>{css}</style>
      <div className="playback-title">
        {recordings.length > 1 && recording ? (
          live ? (
            <button type="button" className="playback-back" onClick={() => setLiveChoice(0)}
              aria-label={`Back to ${session?.name ?? "the session"}'s recordings`}>←</button>
          ) : (
            <Link to={`/watch/${sessionId}`} className="playback-back"
              aria-label={`Back to ${session?.name ?? "the session"}'s recordings`}>←</Link>
          )
        ) : live ? (
          <button type="button" className="playback-back" onClick={live.onClose}
            aria-label="Back to the live session">←</button>
        ) : (
          <Link to="/watch" className="playback-back" aria-label="Back to sessions">←</Link>
        )}
        {!loading && !error && (
          <>
            <h1>
              {session.name}
              {recording && recordings.length > 1 && (
                <span className="playback-take">{takeName(recording, recordingIndex)}</span>
              )}
            </h1>
            <div className="playback-title-tools" ref={setToolsSlot} />
            {canDelete && recording && (
              <button type="button" className="playback-delete" disabled={deleting}
                aria-label={`Delete ${takeName(recording, recordingIndex)}`}
                title={`Delete ${takeName(recording, recordingIndex)}`}
                onClick={() => removeRecording(recording, recordingIndex, false)}>
                <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">
                  <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
                    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            {recordings.some((recording) => recording.videos.some((video) => video.url)) && (
              // On a recording, just its video; on the list, the whole session.
              <DownloadButton sessionId={sessionId} startedAt={recording?.startedAt ?? null} />
            )}
          </>
        )}
      </div>
      {loading ? <p>Loading recordings...</p> : error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <div className="playback-layout">
            {recordings.length === 0 ? (
              <p>No videos have been uploaded for this session yet.</p>
            ) : showingList ? (
              <RecordingList sessionId={sessionId} recordings={recordings}
                onChoose={live ? setLiveChoice : null}
                onDelete={canDelete && !deleting
                  ? (target, index) => removeRecording(target, index, true) : null} />
            ) : (
              <>
                <SessionPlayer key={`${sessionId}-${recordingIndex}`} recordings={recordings}
                  sessionId={sessionId} userId={Number(user.id)} onUploaded={setRecordings}
                  videoTime={videoTime} seek={seek} notes={notes} setNotes={setNotes}
                  notesError={notesError} setNotesError={setNotesError}
                  recordingIndex={recordingIndex} toolsSlot={toolsSlot}
                  title={`${session.name} · ${takeName(recording, recordingIndex)}`} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Comments are blue dots on the seek bar where they were left; each one
// pops up over the video for a few seconds as playback passes it. There is
// no separate list: posting one stamps it at the moment on screen.
function takeName(recording, index) {
  return `Recording ${String(recording.number ?? index + 1).padStart(3, "0")}`;
}

// The session's recordings (takes) as cards: a still from the first angle,
// the take's name, when it started and how many angles it has. For admins
// (onDelete), each card has a delete button over its still.
function RecordingList({ sessionId, recordings, onChoose, onDelete }) {
  return (
    <ul className="recording-list">
      {recordings.map((recording, index) => {
        const angles = recording.videos.filter((video) => video.url);
        const number = recording.number ?? index + 1;
        const started = new Date(recording.startedAt);
        return (
          <li key={recording.startedAt}>
            {onDelete && (
              <button type="button" className="recording-delete"
                aria-label={`Delete ${takeName(recording, index)}`}
                title={`Delete ${takeName(recording, index)}`}
                onClick={() => onDelete(recording, index)}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                </svg>
              </button>
            )}
            <Link to={`/watch/${sessionId}?recording=${number}`}
              onClick={onChoose ? (event) => { event.preventDefault(); onChoose(number); } : undefined}>
              <span className="recording-still">
                {angles[0] ? (
                  <video src={`${angles[0].url}#t=1`} preload="metadata" muted playsInline
                    crossOrigin={mediaCors(angles[0].url)} aria-hidden="true" tabIndex={-1} />
                ) : <span>No video yet</span>}
              </span>
              <strong>{takeName(recording, index)}</strong>
              <span className="recording-meta">
                {started.toLocaleDateString([], { month: "short", day: "numeric" })}
                {" · "}
                {started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                {" · "}
                {angles.length} {angles.length === 1 ? "angle" : "angles"}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// A camera's take that hasn't arrived yet is shown as on its way for this
// long after the take; after that it's probably not coming.
const UPLOAD_WAIT_MS = 30 * 60 * 1000;

// Beside an angle's name: its upload's stage and how far along, "Waiting
// for connection" when it stopped, or "Preview" while one plays.
function uploadLabel(video) {
  const upload = video.upload;
  if (!upload) return video.previewOnly ? "Preview" : null;
  if (upload.stalled) return "Waiting for connection";
  const percent = Math.round(upload.fraction * 100);
  return upload.stage === "preview" ? `Preview ${percent}%` : `Full quality ${percent}%`;
}

function stillUploading(video, startedAt) {
  return !video.url && Date.now() - startedAt < UPLOAD_WAIT_MS;
}

function SessionPlayer({ recordings, sessionId, userId, onUploaded, videoTime, seek,
  notes, setNotes, notesError, setNotesError, recordingIndex, toolsSlot, title }) {
  const [uploading, setUploading] = useState(false);
  const [page, setPage] = useState(0);
  const [panelLayouts, setPanelLayouts] = useState({});
  const [audioSettings, setAudioSettings] = useState({});
  const [openVolume, setOpenVolume] = useState(null);
  const [choosingPanel, setChoosingPanel] = useState(null);
  const [focusedPanel, setFocusedPanel] = useState(null);
  // Each angle's shape (width / height), learned as its video loads, and the
  // space the angles are laid out in.
  const [aspects, setAspects] = useState({});
  const [gridElement, setGridElement] = useState(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [commentText, setCommentText] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(false);
  // The angles (by panel) holding up playback until they've loaded enough
  // to play together, each marked on its own tile.
  const [loadingPanels, setLoadingPanels] = useState(() => new Set());
  // Played and not yet through to the end: no angle changes video until it
  // is (see sourceFor).
  const [midTake, setMidTake] = useState(false);
  const heldSources = useRef(new Map());
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const videoRefs = useRef([]);
  const currentTime = useRef(0);
  const playRequest = useRef(0);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const videos = recordings[recordingIndex].videos;
  const [deletingAngle, setDeletingAngle] = useState(false);
  // Deletes one angle (whoever recorded it, or an admin), after asking; the
  // rest of the recording stays.
  const removeAngle = async (video) => {
    const take = takeName(recordings[recordingIndex], recordingIndex);
    const whose = video.userId === userId ? "your angle" : `${video.name}'s angle`;
    if (!window.confirm(`Delete ${whose} of ${take}? The other angles and the comments stay. This can't be undone.`)) return;
    setDeletingAngle(true);
    try {
      await deleteAngle(sessionId, recordings[recordingIndex].startedAt, video.userId);
      onUploaded((await getSessionVideos(sessionId)).recordings);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setDeletingAngle(false);
    }
  };
  // Each angle skips ahead so all of them show the same moment; times shown
  // and saved (seek bar, comments) are on that shared timeline.
  const trims = angleTrims(videos);
  const trimOf = (player) => Number(player?.dataset.trim || 0);
  const panels = panelLayouts[recordingIndex] || (videos.length ? videos.map((video) => video.userId) : [null]);
  const panelVideos = panels.map(
    (id) => videos.find((video) => video.userId === id) || null
  );
  // As many angles per page as fit while each stays big enough to watch
  // (at least 340px wide): 4 on a laptop, 9-16 on a big monitor. Clicking
  // an angle shows it on its own.
  const perPage = gridSize.width > 0
    ? anglesPerPage(gridSize.width, gridSize.height,
      commonAspect(Object.values(aspects)), { minTileWidth: 340 })
    : 4;
  const pages = Math.ceil(panels.length / perPage);

  // What an angle plays. Shown small (with others on screen, or behind the
  // enlarged one) it's the smaller copy, which loads far quicker; enlarged or
  // alone, the full video. An angle still uploading starts on the phone's
  // preview. Mid-take an angle keeps what it started on, so the full video
  // arriving doesn't make it load again while it's being watched: the switch
  // happens once the take has played through.
  const sourceFor = (video, small) => {
    const wanted = (small && video.previewUrl) || video.url;
    const key = `${video.userId}:${small ? "small" : "large"}`;
    const held = heldSources.current.get(key);
    // The same file under a fresh link (a CDN link is re-signed every few
    // hours) keeps its link, so the player doesn't load it again.
    if (!midTake && !(held && sameFile(held, wanted))) heldSources.current.set(key, wanted);
    else if (!held) heldSources.current.set(key, wanted);
    return heldSources.current.get(key);
  };
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(Math.max(0, pages - 1));
  }, [page, pages]);

  // The grid takes the rest of the window, leaving room below it for the
  // comment pop-up and the play bar. Nothing between them depends on how many
  // angles fit (the page arrows sit in the play bar), so this can't loop.
  const transportRef = useRef(null);
  const [gridHeight, setGridHeight] = useState(null);

  // Fullscreen: the whole player (angles, play bar, comments) fills the
  // screen with a slim bar on top, and the grid re-fits to it. F toggles it,
  // Esc leaves (the browser handles that), Space plays and pauses.
  const boxRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;
  useEffect(() => {
    const onChange = () => setFullscreen(
      Boolean(boxRef.current) && document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else boxRef.current?.requestFullscreen().catch(() => {});
  };
  useLayoutEffect(() => {
    if (!gridElement) return undefined;
    const fit = () => {
      const grid = gridElement.getBoundingClientRect();
      const transport = transportRef.current?.getBoundingClientRect();
      const below = transport ? transport.bottom - grid.bottom : 0;
      // In fullscreen the player is the whole screen; otherwise leave the
      // page's own bottom padding, so the player fits without scrolling.
      const top = fullscreen ? grid.top : grid.top + window.scrollY;
      const main = gridElement.closest("main");
      const padding = fullscreen ? 8
        : main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 16;
      setGridHeight(Math.max(320, Math.floor(window.innerHeight - top - below - padding - 4)));
    };
    fit();
    // Entering or leaving fullscreen settles a frame later.
    const frame = requestAnimationFrame(fit);
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, [gridElement, Boolean(error), toolsSlot, fullscreen]);

  useLayoutEffect(() => {
    if (!gridElement) return undefined;
    // Measured now, so the angles show on the first paint (a ResizeObserver
    // only reports on a frame, which a background tab may not draw).
    const { width, height } = gridElement.getBoundingClientRect();
    setGridSize({ width, height });
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setGridSize({ width, height });
    });
    observer.observe(gridElement);
    return () => observer.disconnect();
  }, [gridElement, gridHeight]);

  // The current page's tiles: the best-fit grid, in the angles' usual shape,
  // or just the enlarged one.
  const pageStart = page * perPage;
  const pageCount = Math.min(perPage, Math.max(0, panelVideos.length - pageStart));
  const pageAspect = commonAspect(
    Array.from({ length: pageCount }, (_, i) => aspects[pageStart + i])
  );
  // With more than one page, the angles leave a strip on each side for the
  // page arrows, so the arrows never cover a video.
  const ARROW = 48;
  const gutter = pages > 1 ? ARROW + 6 : 0;
  const pageRects = focusedPanel !== null
    ? null
    : layoutAngles({
      width: Math.max(0, gridSize.width - 2 * gutter),
      height: gridSize.height,
      count: pageCount,
      aspect: pageAspect,
    }).map((rect) => ({ ...rect, left: rect.left + gutter }));
  const focusRect = focusedPanel === null
    ? null
    : layoutAngles({
      width: gridSize.width,
      height: gridSize.height,
      count: 1,
      aspect: aspects[focusedPanel] ?? pageAspect,
    })[0];
  const tileStyle = (panelIndex) => {
    const rect = focusedPanel !== null
      ? (panelIndex === focusedPanel ? focusRect : null)
      : pageRects?.[panelIndex - pageStart];
    if (!rect) return { display: "none" };
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };

  // The page arrows sit just outside the angles, in the side strips.
  const tilesLeft = pageRects?.length ? Math.min(...pageRects.map((r) => r.left)) : 0;
  const tilesRight = pageRects?.length
    ? Math.max(...pageRects.map((r) => r.left + r.width)) : gridSize.width;
  const prevArrowLeft = Math.max(0, tilesLeft - ARROW - 4);
  const nextArrowLeft = Math.min(gridSize.width - ARROW, tilesRight + 4);

  // Only the angles on screen load and play: the current page, or just the
  // enlarged one. Each video is a full-quality stream to download and
  // decode, so the rest stay paused (or unmounted, on other pages) and jump
  // to the current moment when they come into view.
  const isOnScreen = (panelIndex) =>
    focusedPanel !== null ? panelIndex === focusedPanel : Math.floor(panelIndex / perPage) === page;
  const onScreenPlayers = () =>
    videoRefs.current.filter((video, panelIndex) => video && isOnScreen(panelIndex));
  const liveNote = notes.filter((note) => {
    const at = note.videoTimeMs / 1000;
    return at <= time && time < at + 3;
  }).at(-1);
  const orderedNotes = [...notes].sort((a, b) => a.videoTimeMs - b.videoTimeMs);

  const getPanelAudio = (panelIndex) => audioSettings[recordingIndex]?.[panelIndex] || {
    volume: 1,
    muted: panelIndex !== panelVideos.findIndex((video) => video?.url),
  };

  const setPanelAudio = (panelIndex, audio) => {
    setAudioSettings((current) => {
      const settings = [...(current[recordingIndex] || [])];
      settings[panelIndex] = audio;
      return { ...current, [recordingIndex]: settings };
    });
  };

  const startedAt = recordings[recordingIndex].startedAt;

  // Stamped with the moment on screen, so its dot lands where it was left.
  const postComment = async (event) => {
    event.preventDefault();
    const body = commentText.trim();
    if (!body) return;
    setPosting(true);
    setNotesError("");
    try {
      await createSessionNote(sessionId, startedAt, body, Math.round(videoTime.current * 1000));
      setNotes(await getSessionNotes(sessionId, startedAt));
      setCommentText("");
    } catch (err) {
      setNotesError(err.message);
    } finally {
      setPosting(false);
    }
  };

  const removeComment = async (noteId) => {
    if (!window.confirm("Delete this comment?")) return;
    setNotesError("");
    try {
      await deleteSessionNote(sessionId, noteId);
      setNotes((current) => current.filter((note) => note.id !== noteId));
    } catch (err) {
      setNotesError(err.message);
    }
  };

  // Stops every angle on the exact same moment (the first one's), so a
  // paused frame compares like with like.
  const pause = () => {
    playRequest.current += 1;
    videoRefs.current.forEach((video) => video?.pause());
    setPlaying(false);
    setLoadingPanels(new Set());
    const players = onScreenPlayers().filter((video) => Number.isFinite(video.duration));
    if (players.length < 2) return;
    const at = players[0].currentTime - trimOf(players[0]);
    for (const video of players) {
      video.playbackRate = 1;
      video.currentTime = Math.min(Math.max(0, at + trimOf(video)), video.duration);
    }
  };

  const play = async () => {
    const players = onScreenPlayers();
    if (players.length === 0) return;
    const request = ++playRequest.current;
    setError("");
    if (players.every((video) => video.ended)) {
      players.forEach((video) => { video.currentTime = trimOf(video); });
    }
    // Start every angle at once, only when all of them can: otherwise the
    // one still loading starts late and stays behind.
    const starting = players.filter((video) => !video.ended);
    const panelOf = (video) => videoRefs.current.indexOf(video);
    setLoadingPanels(new Set(
      starting.filter((video) => video.readyState < HAVE_FUTURE_DATA).map(panelOf)));
    const ready = await untilReady(starting, 15000, (video) => {
      if (request !== playRequest.current) return;
      setLoadingPanels((current) => {
        const next = new Set(current);
        next.delete(panelOf(video));
        return next;
      });
    });
    if (request !== playRequest.current) return;
    if (!ready) {
      const names = starting
        .filter((video) => video.readyState < HAVE_FUTURE_DATA)
        .map((video) => video.getAttribute("aria-label"));
      pause();
      setError(names.length === 1
        ? `${names[0]}'s angle is still loading. Try again in a moment.`
        : `Still loading: ${names.join(", ")}. Try again in a moment.`);
      return;
    }
    setLoadingPanels(new Set());
    try {
      await Promise.all(players.filter((video) => !video.ended).map((video) => video.play()));
      if (request === playRequest.current) {
        setPlaying(true);
        setMidTake(true);
      }
    } catch {
      if (request !== playRequest.current) return;
      pause();
      setError("A video could not play. Try again once it has loaded.");
    }
  };

  // Keeps every angle on the first one's moment while playing (see
  // angleSync.js): four times a second, an angle a little off plays slightly
  // faster or slower until it's back within half a frame; one far off (it
  // stalled to load) jumps back.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      const players = onScreenPlayers().filter(
        (video) => Number.isFinite(video.duration) && !video.ended
      );
      if (players.length < 2) return;
      const [leader, ...others] = players;
      leader.playbackRate = 1;
      const at = leader.currentTime - trimOf(leader);
      for (const video of others) {
        const target = at + trimOf(video);
        if (target < 0 || target >= video.duration || video.seeking) continue;
        const driftMs = (video.currentTime - target) * 1000;
        if (Math.abs(driftMs) > JUMP_BEYOND_MS) {
          video.playbackRate = 1;
          video.currentTime = target;
        } else {
          const speed = speedFor(driftMs);
          if (Math.abs(video.playbackRate - speed) > 0.002) video.playbackRate = speed;
        }
      }
    }, 250);
    return () => clearInterval(timer);
  }, [playing, page, perPage, focusedPanel]);

  // Coming into view (a new page, or leaving the enlarged view): catch up to
  // the moment on screen and play along. Going out of view: pause.
  useEffect(() => {
    const at = currentTime.current;
    videoRefs.current.forEach((video, panelIndex) => {
      if (!video) return;
      if (!isOnScreen(panelIndex)) {
        video.pause();
      } else if (playingRef.current && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(at + trimOf(video), video.duration);
        video.play().catch(() => {});
      }
    });
  }, [page, perPage, focusedPanel]); // eslint-disable-line react-hooks/exhaustive-deps

  const seekTo = async (nextTime) => {
    const players = onScreenPlayers().filter((video) => Number.isFinite(video.duration));
    if (players.length === 0) return;
    currentTime.current = nextTime;
    videoTime.current = nextTime;
    setTime(nextTime);
    players.forEach((video) => {
      video.playbackRate = 1;
      video.currentTime = Math.min(nextTime + trimOf(video), video.duration);
    });

    // A shorter video may have ended already; resume it when seeking back.
    if (playing) {
      const request = ++playRequest.current;
      try {
        await Promise.all(players
          .filter((video) => nextTime + trimOf(video) < video.duration)
          .map((video) => video.play()));
      } catch {
        if (request !== playRequest.current) return;
        pause();
        setError("A video could not resume. Try pressing play again.");
      }
    }
  };

  // the notes panel jumps the player through this
  seek.current = seekTo;

  // Dragging the seek bar: the handle follows the finger at once, and each
  // angle shows its still for that moment (see ScrubStill), so every angle
  // shows the same instant as it moves; jumping the real videos around
  // can't keep up. Letting go lands the videos exactly there, keeps the
  // stills up until every angle can play from it, then plays them together
  // if they were playing. Angles without stills yet (just uploaded) follow
  // the old way: the videos themselves move where they're loaded already.
  const [scrubTo, setScrubTo] = useState(null);
  // The moment the stills show, from the drag until the videos have landed.
  const [stillsAt, setStillsAt] = useState(null);
  // Redraws once a still sheet has downloaded (see loadSheet).
  const [, setSheetsLoaded] = useState(0);
  const onSheetLoaded = () => setSheetsLoaded((count) => count + 1);
  const scrubbing = useRef({ active: false, wasPlaying: false, lastAt: 0 });
  // Counts drags, so a release still waiting on the videos after a new drag
  // has begun leaves that one alone.
  const scrubCount = useRef(0);
  // The latest endScrub (it reads this render's state), for the window's
  // pointerup: letting go anywhere ends the drag, not only over the bar.
  const endScrubRef = useRef(null);
  const onScreenVideos = panelVideos.filter((video, panelIndex) => video?.url && isOnScreen(panelIndex));
  const haveStills = onScreenVideos.length > 0 && onScreenVideos.every((video) => video.scrub);
  // Every angle on screen switches to its still at once, when all of their
  // sheets for this moment are here: one angle moving while another sits
  // on the old moment would look out of sync.
  const stillsReady = stillsAt != null && haveStills && onScreenVideos.every((video) =>
    loadSheet(sheetAt(video.scrub, stillsAt + (trims.get(video.userId) ?? 0)), onSheetLoaded));
  const startScrub = () => {
    if (scrubbing.current.active) return;
    scrubbing.current = { active: true, wasPlaying: playingRef.current, lastAt: 0 };
    scrubCount.current += 1;
    const release = () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      endScrubRef.current?.();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    if (playingRef.current) {
      playRequest.current += 1;
      onScreenPlayers().forEach((video) => video.pause());
      setPlaying(false);
    }
  };
  const moveScrub = (value) => {
    if (!scrubbing.current.active) {
      // The keyboard (arrow keys): no drag, just go there.
      seekTo(value);
      return;
    }
    setScrubTo(value);
    if (haveStills) {
      setStillsAt(value);
      // The sheet for here, and the next one, ahead of the finger.
      onScreenVideos.forEach((video) => {
        const at = value + (trims.get(video.userId) ?? 0);
        loadSheet(sheetAt(video.scrub, at), onSheetLoaded);
        loadSheet(sheetAt(video.scrub, at + SHEET_AHEAD_S), onSheetLoaded);
      });
      return;
    }
    const now = performance.now();
    if (now - scrubbing.current.lastAt < 150) return;
    const players = onScreenPlayers().filter((video) => Number.isFinite(video.duration));
    const loadedThere = (video) => {
      const target = value + trimOf(video);
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (video.buffered.start(i) <= target && target <= video.buffered.end(i)) return true;
      }
      return false;
    };
    if (!players.every(loadedThere)) return;
    scrubbing.current.lastAt = now;
    players.forEach((video) => {
      const target = Math.min(value + trimOf(video), video.duration);
      if (video.fastSeek) video.fastSeek(target);
      else video.currentTime = target;
    });
  };
  const endScrub = async () => {
    if (!scrubbing.current.active) return;
    const { wasPlaying } = scrubbing.current;
    scrubbing.current = { active: false, wasPlaying: false, lastAt: 0 };
    const drag = scrubCount.current;
    const to = scrubTo;
    setScrubTo(null);
    if (to != null) {
      await seekTo(to);
      if (haveStills) {
        await untilReady(onScreenPlayers().filter((video) => !video.ended));
      }
    }
    if (drag !== scrubCount.current) return;
    setStillsAt(null);
    if (wasPlaying) play();
  };
  endScrubRef.current = endScrub;
  const shownTime = scrubTo ?? time;

  // How far ahead every angle on screen has loaded, on the shared timeline:
  // the seek bar's light grey part, like YouTube's. The slowest angle sets
  // it, since playback waits for that one.
  const [loadedTo, setLoadedTo] = useState(0);
  const updateLoaded = () => {
    const players = onScreenPlayers().filter((video) => Number.isFinite(video.duration));
    if (players.length === 0) return;
    const ahead = players.map((video) => {
      let end = video.currentTime;
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (video.buffered.start(i) <= video.currentTime + 0.5) {
          end = Math.max(end, video.buffered.end(i));
        }
      }
      return end - trimOf(video);
    });
    setLoadedTo(Math.max(0, Math.min(...ahead)));
  };

  // Enlarging keeps the other panels mounted but paused; they catch up
  // when the grid comes back.
  const toggleFocus = (panelIndex) =>
    setFocusedPanel((current) => (current === panelIndex ? null : panelIndex));

  useEffect(() => {
    if (focusedPanel === null) return;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setFocusedPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusedPanel]);

  const skip = (seconds) => {
    const players = onScreenPlayers().filter((video) => Number.isFinite(video.duration));
    if (players.length === 0) return;
    const longest = Math.max(...players.map((video) => video.duration - trimOf(video)));
    const from = Math.max(...players.map((video) => video.currentTime - trimOf(video)));
    seekTo(Math.max(0, Math.min(longest, from + seconds)));
  };

  const uploadMissingVideo = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = "";
    pause();
    setUploading(true);
    setError("");
    try {
      await uploadSessionVideo(sessionId, recordings[recordingIndex].startedAt, file, file.name);
      const data = await getSessionVideos(sessionId);
      onUploaded(data.recordings);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const updatePanels = (nextPanels) => {
    const players = onScreenPlayers();
    if (players.length) {
      currentTime.current = Math.max(...players.map((video) => video.currentTime - trimOf(video)));
    }
    pause();
    videoRefs.current = [];
    setDuration(0);
    setError("");
    setChoosingPanel(null);
    setOpenVolume(null);
    setFocusedPanel(null);
    setPanelLayouts((current) => ({ ...current, [recordingIndex]: nextPanels }));
  };

  const chooseVideo = (panelIndex, value) => {
    const nextPanels = [...panels];
    nextPanels[panelIndex] = value === "" ? null : Number(value);
    updatePanels(nextPanels);
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (target.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if ((event.key === "f" || event.key === "F") && canFullscreen) {
        event.preventDefault();
        toggleFullscreen();
      } else if (event.key === " " && !target.closest?.("button")) {
        event.preventDefault();
        (playingRef.current ? pause : play)();
      } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft")
          && pages > 1 && focusedPanel === null && !target.closest?.("input")) {
        const next = page + (event.key === "ArrowRight" ? 1 : -1);
        if (next >= 0 && next < pages) {
          event.preventDefault();
          changePage(next);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const changePage = (nextPage) => {
    setPage(nextPage);
    setChoosingPanel(null);
    setOpenVolume(null);
    setFocusedPanel(null);
  };

  // Swiping sideways over the angles turns the page when they don't all
  // fit: two fingers on a trackpad, or one on a touchscreen. One page per
  // swipe; the browser's swipe-to-go-back is held off over the grid.
  const swipe = useRef({ dx: 0, at: 0, touchX: null });
  const turnPage = useRef(null);
  turnPage.current = (direction) => {
    const next = page + direction;
    if (focusedPanel !== null || next < 0 || next >= pages) return;
    changePage(next);
  };
  useEffect(() => {
    if (!gridElement) return undefined;
    const onWheel = (event) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = Date.now();
      // A swipe's momentum keeps sending events; wait for it to settle.
      if (now - swipe.current.at < 700) return;
      swipe.current.dx += event.deltaX;
      if (Math.abs(swipe.current.dx) > 60) {
        turnPage.current(swipe.current.dx > 0 ? 1 : -1);
        swipe.current = { ...swipe.current, dx: 0, at: now };
      }
    };
    const onTouchStart = (event) => { swipe.current.touchX = event.touches[0]?.clientX ?? null; };
    const onTouchEnd = (event) => {
      const start = swipe.current.touchX;
      const end = event.changedTouches[0]?.clientX;
      swipe.current.touchX = null;
      if (start == null || end == null || Math.abs(end - start) < 60) return;
      turnPage.current(end < start ? 1 : -1);
    };
    gridElement.addEventListener("wheel", onWheel, { passive: false });
    gridElement.addEventListener("touchstart", onTouchStart, { passive: true });
    gridElement.addEventListener("touchend", onTouchEnd);
    return () => {
      gridElement.removeEventListener("wheel", onWheel);
      gridElement.removeEventListener("touchstart", onTouchStart);
      gridElement.removeEventListener("touchend", onTouchEnd);
    };
  }, [gridElement]);


  const tools = (
    <>
      {canFullscreen && (
        <button type="button" className="playback-fullscreen" onClick={toggleFullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen (F or Esc)" : "Full screen (F)"}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {fullscreen
              ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
              : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
          </svg>
        </button>
      )}
    </>
  );

  return (
    <section className="playback-box" ref={boxRef}>
      {fullscreen ? (
        <div className="playback-fs-bar">
          <strong>{title}</strong>
          <div className="playback-fs-tools">{tools}</div>
        </div>
      ) : toolsSlot ? createPortal(tools, toolsSlot) : <div className="playback-top">{tools}</div>}
      {panelVideos.length === 0 ? (
        <p className="playback-empty">No videos have been uploaded for this recording yet.</p>
      ) : [page].map((pageIndex) => {
        const pageVideos = panelVideos.slice(pageIndex * perPage, pageIndex * perPage + perPage);
        const sharingPage = pageVideos.filter((video) => video?.url).length > 1;
        return (
        <div aria-busy={loadingPanels.size > 0} className="playback-grid" ref={setGridElement}
          style={gridHeight ? { height: gridHeight } : undefined}
          key={`${recordingIndex}-${pageIndex}-${panels.join(",")}`}>
          {pageVideos.map((video, index) => {
            const panelIndex = pageIndex * perPage + index;
            const audio = getPanelAudio(panelIndex);
            const focused = focusedPanel === panelIndex;
            const small = focusedPanel === null ? sharingPage : !focused;
            return (
            <figure key={pageIndex * perPage + index} style={tileStyle(panelIndex)}
              className={focused ? "playback-focused" : undefined}>
              {video?.canDelete && (
                <button type="button" className="playback-panel-delete" disabled={deletingAngle}
                  aria-label={`Delete ${video.name}'s angle`}
                  title={video.userId === userId ? "Delete your angle" : `Delete ${video.name}'s angle`}
                  onClick={() => removeAngle(video)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                  </svg>
                </button>
              )}
              {video?.url && (
                <button type="button" className="playback-panel-change" disabled={uploading}
                  aria-label={`Change video for panel ${panelIndex + 1}`}
                  aria-expanded={choosingPanel === panelIndex}
                  title="Show a different camera here"
                  onClick={() => {
                    setChoosingPanel(choosingPanel === panelIndex ? null : panelIndex);
                  }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 8h13l-3-3M20 16H7l3 3" />
                  </svg>
                </button>
              )}
              {video?.url && (
                <div className="playback-audio">
                  <button type="button" aria-label={`Audio for panel ${panelIndex + 1}`}
                    aria-expanded={openVolume === panelIndex}
                    title={openVolume === panelIndex ? "Close volume slider" : "Open volume slider. Double-click to mute."}
                    onClick={(event) => {
                      if (event.detail > 1) return;
                      const opening = openVolume !== panelIndex;
                      setOpenVolume(opening ? panelIndex : null);
                      if (opening) setPanelAudio(panelIndex, { ...audio, muted: false });
                    }}
                    onDoubleClick={() => {
                      setOpenVolume(null);
                      setPanelAudio(panelIndex, { ...audio, muted: true });
                    }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M4 9h4l5-4v14l-5-4H4z" />
                      {audio.muted ? <path d="m17 9 5 6m0-6-5 6" /> : <path d="M17 8a6 6 0 0 1 0 8" />}
                    </svg>
                  </button>
                  {openVolume === panelIndex && (
                    <input type="range" min="0" max="100" step="1"
                      aria-label={`Volume for panel ${panelIndex + 1}`}
                      value={audio.muted ? 0 : Math.round(audio.volume * 100)}
                      onChange={(event) => {
                        const volume = Number(event.target.value) / 100;
                        setPanelAudio(panelIndex, {
                          volume: volume || audio.volume,
                          muted: volume === 0,
                        });
                      }} />
                  )}
                </div>
              )}
              {video?.url ? <video
                ref={(element) => {
                  videoRefs.current[panelIndex] = element;
                  if (element) element.volume = audio.volume;
                }}
                src={sourceFor(video, small)}
                data-trim={trims.get(video.userId) ?? 0}
                crossOrigin={mediaCors(sourceFor(video, small))}
                preload="auto"
                playsInline
                muted={audio.muted}
                aria-label={video.name}
                onLoadedMetadata={(event) => {
                  const player = event.currentTarget;
                  if (player.videoWidth && player.videoHeight) {
                    const aspect = player.videoWidth / player.videoHeight;
                    setAspects((current) => (current[panelIndex] === aspect
                      ? current : { ...current, [panelIndex]: aspect }));
                  }
                  player.currentTime = Math.min(currentTime.current + trimOf(player), player.duration || 0);
                  setDuration((current) => Math.max(current, (player.duration || 0) - trimOf(player)));
                  // Mounted mid-playback (a new page): join in.
                  if (playingRef.current && isOnScreen(panelIndex)) player.play().catch(() => {});
                }}
                onTimeUpdate={(event) => {
                  const player = event.currentTarget;
                  const at = Math.max(0, player.currentTime - trimOf(player));
                  videoTime.current = at;
                  currentTime.current = at;
                  setTime(at);
                  updateLoaded();
                }}
                onProgress={updateLoaded}
                onEnded={() => {
                  if (onScreenPlayers().every((player) => player.ended)) {
                    setPlaying(false);
                    setMidTake(false);
                  }
                }}
                onWaiting={() => {
                  // One angle ran out of data: hold them all until it
                  // catches up, rather than letting it fall behind.
                  if (!playing || !isOnScreen(panelIndex)) return;
                  onScreenPlayers().forEach((player) => player.pause());
                  play();
                }}
                onError={() => {
                  pause();
                  setError("A video could not load. Try refreshing the page.");
                }}
              /> : <div className="playback-missing">
                {/* The upload's stage and percent once the device reports it.
                    No spinner: the only spinner is on an angle holding up
                    playback, so it's clear which one that is. */}
                {video && choosingPanel !== panelIndex && (video.upload
                  ? <span className={video.upload.stalled ? "playback-upload-status playback-upload-status-stalled" : "playback-upload-status"}>
                      {uploadLabel(video)}
                    </span>
                  : stillUploading(video, recordings[recordingIndex].startedAt)
                    ? "Uploading…"
                    : "Not uploaded")}
              </div>}
              {/* While the seek bar is dragged (and until the videos land),
                  this angle's still for the moment under the finger. */}
              {stillsReady && video?.scrub && isOnScreen(panelIndex) && (
                <ScrubStill scrub={video.scrub} at={stillsAt + (trims.get(video.userId) ?? 0)}
                  onLoaded={onSheetLoaded} />
              )}
              {/* This angle is what playback is waiting on (shown only past a
                  moment's wait, so a quick load doesn't flash). */}
              {loadingPanels.has(panelIndex) && (
                <div className="playback-tile-loading" role="status">
                  <span className="playback-spinner" aria-hidden="true" />Loading
                </div>
              )}
              {/* Clicking an angle plays it on its own (click again for the
                  grid). An empty panel opens the camera list instead. */}
              <button type="button" className="playback-add-video" disabled={uploading}
                aria-label={!video?.url
                  ? `Choose video for panel ${panelIndex + 1}`
                  : focused ? "Return to grid" : `Show ${video.name} on its own`}
                aria-expanded={video?.url ? undefined : choosingPanel === panelIndex}
                onClick={() => {
                  if (!video?.url) {
                    setChoosingPanel(choosingPanel === panelIndex ? null : panelIndex);
                    return;
                  }
                  setChoosingPanel(null);
                  if (panels.length > 1) toggleFocus(panelIndex);
                }}>
                {!video && choosingPanel !== panelIndex && "+"}
              </button>
              {choosingPanel === pageIndex * perPage + index && (
                <div className="playback-panel-picker" role="group"
                  aria-label={`Video for panel ${pageIndex * perPage + index + 1}`}
                  onKeyDown={(event) => { if (event.key === "Escape") setChoosingPanel(null); }}>
                  {/* Every camera, scrolling when there are more than fit. */}
                  {videos.map((option, optionIndex) => (
                    <button type="button" key={option.userId} autoFocus={optionIndex === 0}
                      disabled={uploading} aria-pressed={panels[pageIndex * perPage + index] === option.userId}
                      onClick={() => chooseVideo(pageIndex * perPage + index, option.userId)}>
                      {option.name}{option.url ? "" : stillUploading(option, recordings[recordingIndex].startedAt) ? " (uploading)" : " (not uploaded)"}
                    </button>
                  ))}
                  <button type="button" disabled={uploading}
                    onClick={() => chooseVideo(pageIndex * perPage + index, "")}>Empty panel</button>
                  {video && !video.url && video.userId === userId && (
                    <label>
                      {uploading ? "Uploading..." : "Upload your saved video"}
                      <input type="file" accept="video/*" disabled={uploading}
                        onChange={uploadMissingVideo} />
                    </label>
                  )}
                </div>
              )}
              {video && <figcaption><span>{video.name}</span>
                {/* With a preview playing, its upload's stage goes here; with
                    nothing playing yet, it's in the middle of the tile. */}
                {video.url && uploadLabel(video) && (
                  <span className="playback-preview-note" title="Full quality is still uploading">
                    {uploadLabel(video)}
                  </span>
                )}
              </figcaption>}
              {/* How far along the upload is, along the bottom edge. */}
              {video?.upload && (
                <span className={video.upload.stalled ? "playback-upload playback-upload-stalled" : "playback-upload"}
                  role="progressbar" aria-label={`${video.name}: ${uploadLabel(video)}`}
                  aria-valuemin={0} aria-valuemax={100}
                  aria-valuenow={Math.round(video.upload.fraction * 100)}>
                  <span style={{ width: `${video.upload.fraction * 100}%` }} />
                </span>
              )}
            </figure>
            );
          })}
          {/* More angles than fit: arrows on the grid's sides (or swipe, or
              the arrow keys). */}
          {pages > 1 && focusedPanel === null && page > 0 && (
            <button type="button" className="playback-page-arrow"
              style={{ left: prevArrowLeft }}
              aria-label="Previous angles" disabled={uploading}
              onClick={() => changePage(page - 1)}>
              <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true">
                <path d="M15 4l-8 8 8 8" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {pages > 1 && focusedPanel === null && page + 1 < pages && (
            <button type="button" className="playback-page-arrow"
              style={{ left: nextArrowLeft }}
              aria-label="More angles" disabled={uploading}
              onClick={() => changePage(page + 1)}>
              <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true">
                <path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        );
      })}
      {error && <p className="playback-error" role="alert">{error}</p>}
      <p className="playback-live-note" aria-live="polite">
        {liveNote && (
          <>
            <strong>{liveNote.author}:</strong> "{liveNote.body}"
            {liveNote.canDelete && (
              <button type="button" className="playback-note-delete"
                aria-label={`Delete comment by ${liveNote.author}`}
                onClick={() => removeComment(liveNote.id)}>×</button>
            )}
          </>
        )}
      </p>
      <div className="playback-transport" ref={transportRef}>
      <div className="playback-controls">
        <button type="button" className="playback-skip" aria-label="Back 5 seconds" onClick={() => skip(-5)}
          disabled={uploading || !panelVideos.some((video) => video?.url)}>
          <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
            <path d="M7 9a11 11 0 1 1-2 13M7 3v6h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <text x="16" y="20" textAnchor="middle" fill="currentColor" fontSize="10">−5</text>
          </svg>
        </button>
        <button type="button" className="playback-toggle"
          aria-label={playing ? "Pause" : "Play"}
          onClick={playing ? pause : play}
          disabled={uploading || !panelVideos.some((video) => video?.url)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            {playing ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M7 4v16l13-8z" />}
          </svg>
        </button>
        <button type="button" className="playback-skip" aria-label="Forward 5 seconds" onClick={() => skip(5)}
          disabled={uploading || !panelVideos.some((video) => video?.url)}>
          <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
            <path d="M25 9a11 11 0 1 0 2 13M25 3v6h-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <text x="16" y="20" textAnchor="middle" fill="currentColor" fontSize="10">+5</text>
          </svg>
        </button>
      </div>
      <div className="playback-seek">
        <span>{formatTime(shownTime * 1000)}</span>
        <div className="playback-track"
          style={{
            "--played": `${duration ? (Math.min(shownTime, duration) / duration) * 100 : 0}%`,
            "--loaded": `${duration ? (Math.min(Math.max(loadedTo, shownTime), duration) / duration) * 100 : 0}%`,
          }}>
          <input type="range" min="0" max={duration || 0} step="0.05"
            aria-label="Seek" disabled={uploading || !duration}
            value={Math.min(shownTime, duration || 0)}
            onPointerDown={startScrub}
            onChange={(event) => moveScrub(Number(event.target.value))} />
          {duration > 0 && notes.map((note) => (
            <button type="button" key={note.id} className="playback-dot"
              style={{ left: `${Math.min(100, (note.videoTimeMs / 1000 / duration) * 100)}%` }}
              title={`${formatTime(note.videoTimeMs)}  ${note.author}: ${note.body}`}
              aria-label={`Comment by ${note.author} at ${formatTime(note.videoTimeMs)}`}
              onClick={() => seekTo(note.videoTimeMs / 1000)} />
          ))}
        </div>
        <span>{formatTime(duration * 1000)}</span>
      </div>
      {pages > 1 && focusedPanel === null && (
        <span className="playback-pages" aria-live="polite">Page {page + 1} of {pages}</span>
      )}
      <div className="playback-comment-tools">
        <form className="playback-comment" onSubmit={postComment}>
          <input value={commentText} maxLength={500}
            placeholder={`Comment at ${formatTime(time * 1000)}`}
            aria-label="New comment"
            onChange={(event) => setCommentText(event.target.value)} />
          <button type="submit" disabled={posting || !commentText.trim()}>
            {posting ? "Posting..." : "Post"}
          </button>
        </form>
        <div className="playback-comments-anchor">
          <button type="button" className="playback-comments-toggle"
            aria-expanded={commentsOpen}
            aria-controls="playback-comments-panel"
            onClick={() => setCommentsOpen((open) => !open)}>
            Comments ({notes.length})
          </button>
          <section id="playback-comments-panel"
            className={`playback-comments-panel${commentsOpen ? " is-open" : ""}`}
            aria-label="Comments in this recording"
            aria-hidden={!commentsOpen}>
            <div className="playback-comments-heading">
              <strong>Comments</strong>
              <button type="button" className="playback-comments-close"
                aria-label="Close comments"
                onClick={() => setCommentsOpen(false)}>×</button>
            </div>
            {orderedNotes.length === 0 ? (
              <p className="playback-comments-empty">No comments on this recording yet.</p>
            ) : (
              <ol className="playback-comments-list">
                {orderedNotes.map((note) => (
                  <li key={note.id}>
                    <button type="button" className="playback-comments-item"
                      onClick={() => {
                        seekTo(note.videoTimeMs / 1000);
                        setCommentsOpen(false);
                      }}>
                      <span className="playback-comments-meta">
                        <strong>{note.author}</strong>
                        <time>{formatTime(note.videoTimeMs)}</time>
                      </span>
                      <span className="playback-comments-body">{note.body}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
      </div>
      {notesError && <p className="playback-comment-error" role="alert">{notesError}</p>}
    </section>
  );
}

const HAVE_FUTURE_DATA = 3;

// One angle's still for a moment of its own video (seconds), out of the
// sheets the server made (see the server's recordings/scrubFrames.js).
// Nothing until its sheet has downloaded: the paused video shows meanwhile.
function ScrubStill({ scrub, at, onLoaded }) {
  const frame = frameAt(scrub, at);
  const perSheet = scrub.cols * scrub.rows;
  const sheet = scrub.sheets[Math.floor(frame / perSheet)];
  if (!loadSheet(sheet, onLoaded)) return null;
  const index = frame % perSheet;
  const col = index % scrub.cols;
  const row = Math.floor(index / scrub.cols);
  return (
    <div className="playback-still" aria-hidden="true" style={{
      backgroundImage: `url("${sheet}")`,
      backgroundSize: `${scrub.cols * 100}% ${scrub.rows * 100}%`,
      backgroundPosition: `${scrub.cols > 1 ? (col / (scrub.cols - 1)) * 100 : 0}% ${scrub.rows > 1 ? (row / (scrub.rows - 1)) * 100 : 0}%`,
    }} />
  );
}

function frameAt(scrub, at) {
  return Math.max(0, Math.min(scrub.frames - 1, Math.floor(at * scrub.fps)));
}

function sheetAt(scrub, at) {
  return scrub.sheets[Math.floor(frameAt(scrub, at) / (scrub.cols * scrub.rows))];
}

const SHEET_RETRY_MS = 10_000;

// Whether two links are to the same stored file (they can differ only in
// their signature).
function sameFile(a, b) {
  return a.split("?")[0] === b.split("?")[0];
}

// How far ahead of the finger the next sheet starts downloading.
const SHEET_AHEAD_S = 5;

// Still sheets download only as a drag reaches them (each is 20 s of one
// angle), and stay for the page's life. Returns whether [sheet] is ready,
// starting it if not; [onLoaded] hears when it is.
const sheetStates = new Map();
function loadSheet(sheet, onLoaded) {
  const state = sheetStates.get(sheet);
  if (state === "loaded") return true;
  // Failed recently (an expired link, offline): not asked for again on
  // every move of the drag, only after a pause.
  if (typeof state === "number") {
    if (Date.now() - state < SHEET_RETRY_MS) return false;
  } else if (state) {
    state.add(onLoaded);
    return false;
  }
  const waiting = new Set([onLoaded]);
  sheetStates.set(sheet, waiting);
  // Fetched the way the tile's CSS background will be (no CORS, with the
  // login cookie), so that reuses this download.
  const image = new Image();
  image.onload = () => {
    sheetStates.set(sheet, "loaded");
    waiting.forEach((callback) => callback());
  };
  image.onerror = () => sheetStates.set(sheet, Date.now());
  image.src = sheet;
  return false;
}

/// Resolves true once every video can play from where it is without
/// stopping right away, or false if one still can't after `timeoutMs`.
/// `onReady` hears about each one as it gets there.
function untilReady(videos, timeoutMs = 15000, onReady = () => {}) {
  const waiting = videos.filter((video) => video.readyState < HAVE_FUTURE_DATA);
  if (waiting.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = waiting.length;
    const onCanPlay = (event) => {
      event.currentTarget.removeEventListener("canplay", onCanPlay);
      onReady(event.currentTarget);
      left -= 1;
      if (left === 0) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      waiting.forEach((video) => video.removeEventListener("canplay", onCanPlay));
      resolve(false);
    }, timeoutMs);
    waiting.forEach((video) => video.addEventListener("canplay", onCanPlay));
  });
}

// turns 83000 into "1:23"
function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const css = `
  .playback-page { max-width: 1600px; }
  .playback-page .playback-back { flex: 0 0 auto; color: var(--accent); font-size: 1.5rem; line-height: 1; text-decoration: none; }
  .playback-page button.playback-back { background: none; border: 0; padding: 0; cursor: pointer; font-family: inherit; }
  .playback-page h1 { flex: 1; min-width: 0; font-size: 1.4rem; margin: 0; overflow-wrap: anywhere; }
  .playback-title { display: flex; align-items: center; gap: 12px; margin-bottom: 0.75rem; }
  .playback-page .playback-delete {
    flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
    width: 38px; height: 38px; border-radius: 8px; border: none; background: none;
    color: #e5484d; cursor: pointer; padding: 0;
  }
  .playback-page .playback-delete:hover { background: rgba(229,72,77,0.12); }
  .playback-page .playback-delete:disabled { opacity: 0.5; cursor: default; }
  .playback-box { position: relative; }
  .playback-box:fullscreen { background: #050505; padding: 10px 20px 8px; box-sizing: border-box; overflow: hidden; }
  .playback-box::backdrop { background: #050505; }
  .playback-fs-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .playback-fs-bar strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.05rem; }
  .playback-fs-tools { display: flex; align-items: center; gap: 10px; }
  /* Styled like the download icon beside it: just the icon, team color. */
  .playback-title-tools .playback-fullscreen, .playback-box .playback-fullscreen {
    display: inline-flex; align-items: center; justify-content: center;
    width: 38px; height: 38px; padding: 0; border: none; border-radius: 8px;
    background: transparent; color: var(--accent);
  }
  .playback-title-tools .playback-fullscreen:hover, .playback-box .playback-fullscreen:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .playback-top, .playback-controls, .playback-pages { display: flex; justify-content: center; align-items: center; gap: 12px; }
  .playback-top { margin-bottom: 0.6rem; }
  .playback-title-tools { display: flex; align-items: center; gap: 10px; }
  .playback-page h1 .playback-take { margin-left: 0.6rem; color: #999; font-size: 1rem; font-weight: 500; }
  .recording-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; flex: 1; }
  .recording-list a { display: flex; flex-direction: column; gap: 4px; color: inherit; text-decoration: none; border-radius: 10px; padding: 8px; }
  .recording-list a:hover, .recording-list a:focus-visible { background: rgba(255,255,255,0.06); }
  .recording-list strong { font-size: 1rem; }
  .recording-list li { position: relative; }
  /* Over the card's still, top right; shows while the mouse is over the card. */
  .recording-delete { position: absolute; top: 16px; right: 16px; z-index: 1; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: none; border-radius: 50%; background: rgba(0,0,0,0.65); color: #ff8a8d; cursor: pointer; }
  .recording-delete:hover { background: rgba(0,0,0,0.85); }
  @media (hover: hover) {
    .recording-list li .recording-delete { opacity: 0; transition: opacity 0.15s; }
    .recording-list li:hover .recording-delete, .recording-list li:focus-within .recording-delete { opacity: 1; }
  }
  .recording-still { position: relative; aspect-ratio: 16 / 9; margin-bottom: 6px; border-radius: 8px; overflow: hidden; background: #1c1c1c; display: flex; align-items: center; justify-content: center; color: #777; font-size: 0.85rem; }
  .recording-still video { width: 100%; height: 100%; object-fit: cover; }
  .recording-meta { color: #999; font-size: 0.85rem; }
  .playback-title-tools select, .playback-title-tools button { font: inherit; color: #f0f0f0; background: #292929; border: 1px solid #555; border-radius: 6px; padding: 0.4rem 0.8rem; cursor: pointer; }
  .playback-title-tools button:disabled, .playback-title-tools select:disabled { opacity: 0.4; cursor: default; }
  @media (max-width: 900px) {
    .playback-transport { flex-wrap: wrap; }
    .playback-comment { flex-basis: 100%; }
    .playback-title { flex-wrap: wrap; }
    .playback-title-tools { order: 3; flex-basis: 100%; }
  }
  .playback-box select, .playback-box button { font: inherit; color: #f0f0f0; background: #292929; border: 1px solid #555; border-radius: 6px; padding: 0.4rem 0.8rem; }
  .playback-box button { cursor: pointer; }
  .playback-box button:disabled { opacity: 0.4; cursor: default; }
  /* Tiles are placed by layoutAngles (recording/angleLayout.js): each takes
     its video's shape, so there are no black bars inside it. */
  .playback-grid { position: relative; height: 70vh; min-height: 320px; overscroll-behavior-x: contain; touch-action: pan-y; }
  .playback-grid figure { position: absolute; margin: 0; display: flex; flex-direction: column; background: #000; border-radius: 6px; overflow: hidden; transition: left 0.2s, top 0.2s, width 0.2s, height 0.2s; }
  .playback-box .playback-panel-change { position: absolute; top: 6px; right: 6px; z-index: 3; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 50%; }
  .playback-box .playback-panel-delete { position: absolute; top: 6px; right: 40px; z-index: 3; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 50%; color: #ff8a8d; }
  /* A tile's buttons show while the mouse is over it (or a key reaches
     them), so they don't sit on top of the video the rest of the time. */
  @media (hover: hover) {
    .playback-grid figure .playback-panel-change,
    .playback-grid figure .playback-panel-delete,
    .playback-grid figure .playback-audio { opacity: 0; transition: opacity 0.15s; }
    .playback-grid figure:hover .playback-panel-change,
    .playback-grid figure:hover .playback-panel-delete,
    .playback-grid figure:hover .playback-audio,
    .playback-grid figure:focus-within .playback-panel-change,
    .playback-grid figure:focus-within .playback-panel-delete,
    .playback-grid figure:focus-within .playback-audio { opacity: 1; }
  }
  /* Hidden, not unmounted: the other angles keep playing in sync offscreen. */
  .playback-audio { position: absolute; top: 6px; left: 6px; z-index: 3; display: flex; align-items: center; gap: 6px; max-width: calc(100% - 48px); }
  .playback-box .playback-audio button { display: flex; align-items: center; justify-content: center; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border-radius: 50%; }
  .playback-audio input { width: 100px; min-width: 0; margin: 0; accent-color: var(--accent); }
  .playback-grid video { display: block; width: 100%; flex: 1; min-height: 0; object-fit: contain; }
  .playback-missing { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #999; font-size: 0.8rem; }
  .playback-spinner { width: 28px; height: 28px; border: 3px solid #444; border-top-color: var(--accent); border-radius: 50%; animation: playback-spin 0.9s linear infinite; }
  @keyframes playback-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .playback-spinner { animation-duration: 3s; } }
  .playback-grid figcaption .playback-preview-note { flex-shrink: 0; color: #fc6; }
  .playback-upload {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; height: 3px;
    background: rgba(255,255,255,0.12); pointer-events: none;
  }
  .playback-upload span { display: block; height: 100%; background: var(--accent); transition: width 0.4s; }
  .playback-upload-stalled span { background: #8a8a8a; }
  .playback-upload-status { color: #e8e8e8; font-size: 1rem; font-weight: 700; }
  .playback-upload-status-stalled { color: #8a8a8a; font-weight: 600; }
  .playback-grid figcaption { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 8px; background: rgba(0,0,0,0.55); color: #ddd; font-size: 0.7rem; pointer-events: none; }
  .playback-grid figcaption span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .playback-panel-picker { z-index: 2; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 220px; max-width: calc(100% - 24px); max-height: calc(100% - 16px); overflow: auto; padding: 4px; border: 1px solid #555; border-radius: 6px; background: #222; box-sizing: border-box; }
  .playback-panel-picker button { display: block; width: 100%; padding: 4px 8px; font-size: 0.65rem; text-align: left; border: none; }
  .playback-panel-picker button:hover, .playback-panel-picker button[aria-pressed="true"] { background: #444; }
  .playback-box .playback-add-video { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; padding: 0; border: none; border-radius: 0; background: transparent; font-size: 2rem; }
  .playback-box .playback-add-video:hover { background: rgba(255,255,255,0.04); }
  .playback-panel-picker label { display: block; margin-top: 8px; padding: 8px; background: #292929; font-size: 0.7rem; }
  .playback-panel-picker input { display: block; max-width: 100%; margin-top: 6px; font: inherit; }
  .playback-pages { flex: 0 0 auto; color: #999; font-size: 0.85rem; }
  .playback-box .playback-page-arrow {
    position: absolute; top: 50%; z-index: 4; transform: translateY(-50%);
    display: flex; align-items: center; justify-content: center;
    width: 48px; height: 96px; padding: 0; border: none; border-radius: 0;
    background: none; color: #fff; cursor: pointer;
    filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.9));
    opacity: 0.75; transition: opacity 0.15s, transform 0.15s;
  }
  .playback-box .playback-page-arrow:hover, .playback-box .playback-page-arrow:focus-visible { opacity: 1; background: none; }
  .playback-live-note { min-height: 1.3rem; margin: 0.4rem 0 0; text-align: center; color: #f0f0f0; font-size: 0.85rem; overflow-wrap: anywhere; }
  .playback-live-note strong { color: var(--accent); }
  /* The timeline gets a full-width row; play, pages and the comment box sit
     under it, so none of them squeeze it. */
  .playback-transport { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 0.3rem; }
  .playback-transport .playback-seek { order: -1; flex: 1 1 100%; }
  .playback-transport .playback-controls { flex: 0 0 auto; gap: 6px; }
  .playback-seek { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
  .playback-seek span { color: #999; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .playback-still { position: absolute; inset: 0; z-index: 1; background-color: #000; background-repeat: no-repeat; pointer-events: none; }
  .playback-tile-loading { position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: rgba(0,0,0,0.45); color: #ddd; font-size: 0.8rem; font-weight: 600; pointer-events: none; opacity: 0; animation: playback-appear 0.15s 0.4s forwards; }
  @keyframes playback-appear { to { opacity: 1; } }
  .playback-track { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
  /* The seek bar: a rounded track filled up to the playhead, with a round
     handle that grows while held. */
  .playback-seek input { flex: 1; min-width: 0; margin: 0; height: 22px; cursor: pointer; background: transparent; -webkit-appearance: none; appearance: none; }
  .playback-seek input::-webkit-slider-runnable-track { height: 5px; border-radius: 3px; background: linear-gradient(to right, var(--accent) var(--played), #8a8a8a var(--played), #8a8a8a var(--loaded), #3a3a3a var(--loaded)); }
  .playback-seek input::-moz-range-track { height: 5px; border-radius: 3px; background: linear-gradient(to right, #8a8a8a var(--loaded), #3a3a3a var(--loaded)); }
  .playback-seek input::-moz-range-progress { height: 5px; border-radius: 3px; background: var(--accent); }
  .playback-seek input::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -4.5px; border-radius: 50%; background: #fff; border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.5); transition: transform 0.1s; }
  .playback-seek input::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.5); }
  .playback-seek input:active::-webkit-slider-thumb { transform: scale(1.3); }
  /* A blue dot on the bar for each comment; click it to jump there. */
  .playback-box .playback-dot {
    position: absolute; top: 50%; width: 11px; height: 11px; padding: 0;
    border: 2px solid #0b0b0b; border-radius: 50%; background: #3b82f6;
    transform: translate(-50%, -50%); cursor: pointer;
  }
  .playback-box .playback-dot:hover { background: #60a5fa; transform: translate(-50%, -50%) scale(1.3); }
  .playback-box .playback-note-delete {
    margin-left: 8px; padding: 0 6px; border: none; background: transparent;
    color: #ff6b6b; font-size: 1rem; line-height: 1;
  }
  .playback-comment-tools { position: relative; display: flex; align-items: center; gap: 6px; flex: 0 1 480px; min-width: 0; margin: 0 0 0 auto; }
  .playback-comment { display: flex; gap: 6px; flex: 1 1 auto; min-width: 200px; margin: 0; }
  .playback-comment input {
    flex: 1; min-width: 0; padding: 0.45rem 0.6rem; border: 1px solid #555; border-radius: 6px;
    background: #292929; color: #f0f0f0; font: inherit; font-size: 0.9rem;
  }
  .playback-box .playback-comments-toggle { flex: 0 0 auto; padding: 0.45rem 0.6rem; white-space: nowrap; font-size: 0.85rem; }
  .playback-comments-anchor { position: relative; }
  .playback-comments-panel {
    position: absolute; z-index: 6; right: 0; bottom: calc(100% + 8px);
    width: min(380px, calc(100vw - 32px)); max-height: min(55vh, 420px);
    overflow-y: auto; padding: 12px; border: 1px solid #444; border-radius: 10px;
    background: #171717; box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55);
    opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(8px);
    transition: opacity 0.16s ease, transform 0.16s ease, visibility 0s linear 0.16s;
  }
  .playback-comments-panel.is-open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); transition-delay: 0s; }
  .playback-comments-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #f0f0f0; }
  .playback-box .playback-comments-close { width: 30px; height: 30px; padding: 0; border: none; background: transparent; color: #aaa; font-size: 1.35rem; line-height: 1; }
  .playback-comments-list { display: grid; gap: 4px; margin: 8px 0 0; padding: 0; list-style: none; }
  .playback-box .playback-comments-item { display: flex; flex-direction: column; align-items: stretch; gap: 4px; width: 100%; padding: 8px; border: none; border-radius: 6px; background: transparent; text-align: left; white-space: normal; }
  .playback-box .playback-comments-item:hover { background: #292929; }
  .playback-comments-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--accent); font-size: 0.8rem; }
  .playback-comments-meta time { flex: 0 0 auto; color: #aaa; font-variant-numeric: tabular-nums; }
  .playback-comments-body { color: #eee; font-size: 0.9rem; overflow-wrap: anywhere; }
  .playback-comments-empty { margin: 10px 0 2px; color: #aaa; font-size: 0.88rem; }
  .playback-comment-error { margin: 0.5rem 0 0; text-align: center; color: #ff8a80; font-size: 0.85rem; }
  .playback-seek input:disabled { opacity: 0.4; cursor: default; }
  .playback-controls .playback-toggle, .playback-controls .playback-skip { display: flex; align-items: center; justify-content: center; width: 42px; height: 42px; padding: 0; border-radius: 50%; }
  .playback-empty { text-align: center; padding: 3rem 1rem; color: #999; }
  .playback-error { color: #ff8a80; text-align: center; }
  .playback-layout { position: relative; display: flex; align-items: flex-start; gap: 1rem; }
  .playback-layout > .playback-box { flex: 1; min-width: 0; }
  .playback-layout > p { flex: 1; }
  @media (max-width: 900px) {
    .playback-layout { flex-direction: column; justify-content: flex-start; }
  }
`;

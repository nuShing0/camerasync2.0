import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";
import { getGroups } from "../api/groups.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { useNewSession } from "../components/NewSession.jsx";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { NotificationList } from "../components/NotificationList.jsx";
import { getNotifications, markNotificationsSeen } from "../api/notifications.js";
import { endSession, getSessions, joinSession } from "../api/recordings.js";

const NOTIFICATIONS_ON_HOME = 4;

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

/// Home dashboard: greeting + quick actions, stats, the live-session card,
/// recent recordings, and the newest notifications.
export function HomeScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const openNewSession = useNewSession();
  const [groups, setGroups] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState(null);
  const [endingId, setEndingId] = useState(null);
  const [confirmingEndId, setConfirmingEndId] = useState(null);
  const [error, setError] = useState("");
  const [liveIndex, setLiveIndex] = useState(0);
  const [notifications, setNotifications] = useState(null);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const firstName = (user?.name || user?.email || "").split(/[\s@]/)[0];

  useEffect(() => {
    Promise.all([getGroups(), getSessions()])
      .then(([loadedGroups, loadedSessions]) => {
        setGroups(loadedGroups);
        setSessions(
          loadedSessions.filter((session) => session.status !== "cancelled")
        );
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Keeps the live card and recent sessions current: a practice that starts
  // shows up within a few seconds, without a reload.
  useAutoRefresh(() => {
    getSessions()
      .then((loaded) => setSessions(loaded.filter((session) => session.status !== "cancelled")))
      .catch(() => {});
  }, 8000);

  // Notifications load on their own (a failure just leaves the panel empty)
  // and refresh every 30 seconds. Showing them here counts as seeing them;
  // they stay highlighted until the next load.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getNotifications(NOTIFICATIONS_ON_HOME)
        .then((data) => {
          if (cancelled) return;
          setNotifications(data.notifications);
          if (data.unreadCount > 0) markNotificationsSeen().catch(() => {});
        })
        .catch(() => {
          if (!cancelled) setNotifications((current) => current ?? []);
        });
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const liveSessions = sessions.filter(
    (session) => session.status === "active"
  );
  // Completed sessions are the recordings; per the design, Home is the
  // primary way into them ("View all" opens the full list).
  // Takes across the user's sessions.
  const recordingCount = sessions.reduce((total, session) => total + (session.recordingCount ?? 0), 0);
  const recentRecordings = sessions
    .filter((session) => session.status === "complete" && session.recordingCount !== 0)
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt))
    .slice(0, 5);
  const live = liveSessions[Math.min(liveIndex, liveSessions.length - 1)];
  const groupName = (groupId) =>
    groupId == null
      ? "No group"
      : groups.find((group) => group.id === groupId)?.name || groupId;

  // joins a live session from the home page
  const joinLiveSession = async (id) => {
    setError("");
    setJoiningId(id);

    try {
      const joinedSession = await joinSession(id);
      setSessions((current) =>
        current.map((session) => (session.id === id ? joinedSession : session))
      );
      navigate(`/record/${joinedSession.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setJoiningId(null);
    }
  };

  // lets the creator end a live session
  const endLiveSession = async (id) => {
    setError("");
    setEndingId(id);

    try {
      await endSession(id);
      setSessions((current) =>
        current.filter((session) => session.id !== id)
      );
      setConfirmingEndId(null);
      setLiveIndex(0);
    } catch (err) {
      setError(err.message);
    } finally {
      setEndingId(null);
    }
  };

  return (
    <div className="home">
      <style>{css}</style>

      {/* One grid, so each row lines up across both columns as in the
          Desktop-home design: the greeting across the top, the stats beside
          the live card (same height), then recent recordings beside
          notifications. */}
      <div className="home-grid">
          <header className="home-header">
            <div>
              <div className="home-date">{today}</div>
              <h1 className="home-title">
                {greeting()}, {firstName}
              </h1>
            </div>
          </header>

          {error && <p className="home-error">{error}</p>}

          <div className="home-stats">
            {/* Groups and Sessions open their pages; recordings are inside
                sessions, so that count has nowhere of its own to go. */}
            <Link className="home-stat home-stat-link" to="/groups">
              <span>Groups</span>
              <strong>{loading ? "…" : groups.length}</strong>
            </Link>
            <Link className="home-stat home-stat-link" to="/watch">
              <span>Sessions</span>
              <strong>{loading ? "…" : sessions.length}</strong>
            </Link>
            <div className="home-stat">
              <span>Recordings</span>
              <strong>{loading ? "…" : recordingCount}</strong>
            </div>
          </div>

        <div className="home-live">
          {live ? (
            <div className="home-live-card">
              <div className="home-live-info">
                <div className="home-live-tag">
                  <span className="home-live-dot" /> Live Now
                  {liveSessions.length > 1 && (
                    <span className="home-dots">
                      {liveSessions.map((session, i) => (
                        <button
                          key={session.id}
                          type="button"
                          className={i === liveIndex ? "dot dot-active" : "dot"}
                          aria-label={`Show live session ${i + 1} of ${liveSessions.length}`}
                          onClick={() => setLiveIndex(i)}
                        />
                      ))}
                    </span>
                  )}
                </div>
                <h3>{live.name}</h3>
                <p>
                  {live.activeMemberCount}{" "}
                  {live.activeMemberCount === 1 ? "device" : "devices"} connected
                  {" · "}
                  {groupName(live.groupId)}
                </p>
              </div>

              <div className="home-live-actions">
                {live.isJoined ? (
                  <button type="button" className="home-join" onClick={() => navigate(`/record/${live.id}`)}>
                    Enter Session
                  </button>
                ) : (
                  <button
                    type="button"
                    className="home-join"
                    disabled={joiningId === live.id}
                    onClick={() => joinLiveSession(live.id)}
                  >
                    {joiningId === live.id ? "Joining…" : "Join"}
                  </button>
                )}

                {(live.createdBy === user?.id ||
                  groups.some((group) => group.id === live.groupId && group.role === "admin")) &&
                  (confirmingEndId === live.id ? (
                    <div className="home-end-row">
                      <button type="button" onClick={() => setConfirmingEndId(null)}>
                        Keep live
                      </button>
                      <button
                        type="button"
                        className="home-end-confirm"
                        disabled={endingId === live.id}
                        onClick={() => endLiveSession(live.id)}
                      >
                        {endingId === live.id ? "Ending…" : "Confirm end"}
                      </button>
                    </div>
                  ) : (
                    <div className="home-end-row">
                      <button type="button" onClick={() => setConfirmingEndId(live.id)}>
                        End session
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            // Nothing live: the card is where a session starts.
            <div className="home-panel home-live-empty">
              {loading ? (
                <p className="home-empty">Checking for live sessions…</p>
              ) : (
                <>
                  <strong>Nothing live right now</strong>
                  {groups.length > 0 ? (
                    <div className="home-create">
                      <button type="button" className="home-create-start"
                        onClick={() => openNewSession("create")}>Start a session</button>
                      <button type="button" onClick={() => openNewSession("schedule")}>
                        Schedule
                      </button>
                    </div>
                  ) : (
                    <span className="home-live-hint">Join a group to start sessions.</span>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <section className="home-column">
          {/* Same as mobile: "View all" sits at the right of the section title. */}
          <div className="home-section-row">
            <h2 className="home-section">Recent Sessions</h2>
            {recentRecordings.length > 0 && (
              <button type="button" className="home-view-all" onClick={() => navigate("/watch")}>
                View all
              </button>
            )}
          </div>
          <div className="home-panel home-panel-fill">
            {recentRecordings.length === 0 ? (
              <EmptyState
                title="No recordings yet"
                action={groups.length > 0 ? "New session" : undefined}
                onAction={() => openNewSession()}
              >
                {groups.length > 0
                  ? "Run a synced session and its recordings will show up here."
                  : "Join a group first. Recordings from its sessions will show up here."}
              </EmptyState>
            ) : (
                <ul className="home-recordings">
                  {recentRecordings.map((session) => (
                    <li key={session.id}>
                      <button type="button" onClick={() => navigate(`/watch/${session.id}`)}>
                        <span className="home-thumb" aria-hidden="true">
                          <span className="home-thumb-play" />
                        </span>
                        <span className="home-rec-text">
                          <strong>{session.name}</strong>
                          <span>
                            {new Date(session.scheduledAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                            {" · "}
                            {groupName(session.groupId)}
                            {session.memberCount != null &&
                              ` · ${session.memberCount} ${session.memberCount === 1 ? "device" : "devices"}`}
                          </span>
                        </span>
                        {session.recordingCount != null && (
                          <span className="home-rec-count">
                            {session.recordingCount} {session.recordingCount === 1 ? "recording" : "recordings"}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
            )}
          </div>
        </section>

        <section className="home-column">
          <div className="home-section-row">
            <h2 className="home-section">Notifications</h2>
            {notifications?.length > 0 && (
              <button type="button" className="home-view-all" onClick={() => navigate("/notifications")}>
                View all
              </button>
            )}
          </div>
          <div className="home-panel home-panel-fill">
            {notifications === null ? (
              <p className="home-empty">Loading…</p>
            ) : notifications.length === 0 ? (
              <p className="home-empty">
                Nothing new yet. Comments, people joining and practices starting
                in your groups show up here.
              </p>
            ) : (
              <NotificationList notifications={notifications} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const css = `
  .home-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 32px;
    max-width: 1200px;
  }
  .home-header, .home-error { grid-column: 1 / -1; }
  .home-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
  }
  .home-date { color: var(--text-soft); font-size: 1rem; margin-bottom: 4px; }
  .home-title { margin: 0; font-size: 2.1rem; font-weight: 800; letter-spacing: -0.5px; }

  .home-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .home-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 24px 12px;
    background: var(--card);
    border-radius: 16px;
  }
  .home-stat-link { color: inherit; text-decoration: none; border: 1px solid transparent; transition: border-color 0.12s, background 0.12s; }
  .home-stat-link:hover, .home-stat-link:focus-visible { border-color: var(--accent); background: var(--card-hover); }
  .home-stat span { color: var(--text-muted); font-size: 1rem; }
  .home-stat strong { font-size: 2.4rem; font-weight: 800; line-height: 1; }

  /* The live card shares the stats' row, so it's the same height as them:
     the session on the left, Join on the right. */
  .home-live { display: flex; flex-direction: column; min-width: 0; contain: size; }
  .home-live > * { flex: 1; }
  .home-dots { display: inline-flex; gap: 6px; margin-left: auto; }
  .dot { width: 9px; height: 9px; padding: 0; border: none; border-radius: 50%; background: rgba(0,0,0,0.25); cursor: pointer; }
  .dot-active { background: var(--accent-ink); }
  .home-live-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 18px 20px;
    background: var(--accent);
    border-radius: 16px;
    color: var(--accent-ink);
  }
  .home-live-info { flex: 1; min-width: 0; }
  .home-live-actions { flex: 0 0 auto; text-align: center; }
  .home-live-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; }
  .home-live-hint { color: var(--text-muted); font-size: 0.9rem; }
  .home-create { display: flex; gap: 10px; }
  .home-create button {
    font: inherit; font-weight: 700; padding: 0.6rem 1.1rem; border-radius: 10px;
    border: 1px solid var(--line-strong); background: transparent; color: var(--text-strong); cursor: pointer;
  }
  .home-create button:hover { border-color: var(--accent); }
  .home-create .home-create-start { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
  .home-create .home-create-start:hover { background: var(--accent-hover); }
  .home-live-tag { display: flex; align-items: center; gap: 7px; font-size: 0.9rem; font-weight: 600; }
  .home-live-dot { width: 9px; height: 9px; border-radius: 50%; background: #f0432e; }
  .home-live-card h3 { margin: 6px 0 2px; font-size: 1.3rem; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-live-card p { margin: 0; color: rgba(0,0,0,0.6); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-join {
    font: inherit;
    font-weight: 700;
    font-size: 0.95rem;
    padding: 0.55rem 1rem;
    white-space: nowrap;
    border: none;
    border-radius: 10px;
    background: #000;
    color: #fff;
    cursor: pointer;
  }
  .home-join:disabled { cursor: default; opacity: 0.6; }
  .home-end-row { display: flex; justify-content: center; gap: 6px; margin-top: 2px; white-space: nowrap; }
  .home-end-row button {
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 4px 6px;
    border: none;
    background: none;
    color: rgba(0,0,0,0.55);
    cursor: pointer;
    text-decoration: underline;
  }
  .home-end-row .home-end-confirm { color: #a01c0e; }
  .home-end-row button:disabled { cursor: default; opacity: 0.6; }

  /* Recent recordings and notifications share a row and a height. */
  .home-column { display: flex; flex-direction: column; min-width: 0; }
  .home-section-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .home-section { margin: 0; color: var(--accent); font-size: 1.15rem; font-weight: 700; }
  .home-view-all {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .home-view-all:hover { text-decoration: underline; }
  .home-panel { padding: 16px 18px; background: var(--card); border-radius: 16px; }
  .home-panel-fill { flex: 1; display: flex; flex-direction: column; min-height: 260px; }
  /* The panel is already the box; a dashed border inside it reads as two. */
  .home-panel .empty-state { margin: auto 0; border: none; }
  .home-recordings { margin: 0; padding: 0; list-style: none; }
  .home-recordings li + li { border-top: 1px solid var(--line); }
  .home-recordings button {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr) auto;
    align-items: center;
    gap: 16px;
    width: 100%;
    padding: 10px 6px;
    border: none;
    border-radius: 10px;
    background: none;
    color: var(--text-strong);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .home-recordings button:hover { background: var(--card-hover); }
  .home-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 44px;
    border-radius: 8px;
    background: #0a0b0d;
  }
  .home-thumb-play { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); }
  .home-rec-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .home-rec-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-rec-text span { color: var(--text-dim); font-size: 0.8rem; }
  .home-rec-count { color: var(--text-dim); font-size: 0.85rem; white-space: nowrap; }
  .home-empty { margin: auto 0; padding: 28px 8px; color: var(--text-dim); line-height: 1.6; text-align: center; }
  .home-error {
    margin: 0;
    padding: 10px 14px;
    border: 1px solid var(--error-line);
    border-radius: 8px;
    background: var(--error-bg);
    color: var(--error-ink);
  }

  @media (max-width: 1080px) {
    .home-grid { grid-template-columns: 1fr; }
    .home-live { contain: none; }
  }
`;

import { useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.jsx";
import { LiveCard, NowRow } from "../components/LiveCard.jsx";
import { useNewSession } from "../components/NewSession.jsx";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";

import { getGroups } from "../api/groups.js";
import { deleteSession, endSession, getSessions, joinSession } from "../api/recordings.js";

// The filter for sessions started without a group.
const NO_GROUP = "__none";
// A scheduled session can be joined from its start time until this long
// after (the server's rule).
const JOIN_WINDOW_MS = 15 * 60 * 1000;

/// Every session: what's live (cards, as on Home), then the past ones as
/// video cards by month. Group buttons and a search narrow both. What's
/// coming up is the Calendar's; starting one is the sidebar's New session.
export function WatchScreen() {
  const { user } = useAuth();
  const [groups, setGroups] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const openNewSession = useNewSession();
  const [params] = useSearchParams();
  // "" is every group.
  const [groupId, setGroupId] = useState(params.get("group") ?? "");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState("");
  // The card whose ··· menu is open.
  const [menuId, setMenuId] = useState(null);

  const load = () => getSessions()
    .then((loaded) => setSessions(loaded.filter((session) => session.status !== "cancelled")));

  // A session that starts, ends or gets a new upload appears without a reload.
  useAutoRefresh(() => { load().catch(() => {}); }, 10000);

  useEffect(() => {
    Promise.all([getGroups(), load()])
      .then(([loadedGroups]) => setGroups(loadedGroups))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A click anywhere else, or Esc, closes an open menu.
  useEffect(() => {
    if (menuId === null) return undefined;
    const close = () => setMenuId(null);
    const onKey = (event) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  const now = new Date();
  const groupOf = (session) => groups.find((group) => group.id === session.groupId);
  const groupName = (session) => session.groupId == null ? "No group" : groupOf(session)?.name || session.groupId;
  const isAdmin = (session) => groupOf(session)?.role === "admin";
  // Hosts and the group's admins run a session: end it, cancel it.
  const canManage = (session) => Number(session.createdBy) === Number(user.id) || isAdmin(session);
  // Sessions without a group: their creator can delete them.
  const canDelete = (session) =>
    session.groupId == null ? Number(session.createdBy) === Number(user.id) : isAdmin(session);

  const query = search.trim().toLowerCase();
  const shown = sessions.filter((session) =>
    (groupId === "" || (groupId === NO_GROUP ? session.groupId == null : session.groupId === groupId))
    && (!query || session.name.toLowerCase().includes(query) || groupName(session).toLowerCase().includes(query)));

  const joinable = (session) => session.status === "scheduled"
    && new Date(session.scheduledAt) <= now
    && now - new Date(session.scheduledAt) <= JOIN_WINDOW_MS;
  const nowSessions = shown
    .filter((session) => session.status === "active" || joinable(session))
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  // Finished, with something to watch, newest first, by month.
  const past = shown
    .filter((session) => session.status === "complete" && session.recordingCount !== 0)
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
  const months = [];
  for (const session of past) {
    const date = new Date(session.scheduledAt);
    const label = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
      ? "This month"
      : date.toLocaleDateString(undefined, {
        month: "long", ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
      });
    if (months.at(-1)?.label !== label) months.push({ label, sessions: [] });
    months.at(-1).sessions.push(session);
  }

  const recordingTotal = sessions.reduce((total, session) => total + (session.recordingCount ?? 0), 0);
  const noGroupCount = sessions.filter((session) => session.groupId == null).length;

  // Runs one of the actions below, one at a time, showing what went wrong.
  const act = async (session, action) => {
    setActionError("");
    setBusyId(session.id);
    try {
      await action();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  };
  const join = (session) => act(session, async () => {
    const joined = await joinSession(session.id);
    navigate(`/record/${joined.id}`);
  });
  const end = (session) => {
    if (!window.confirm(`End ${session.name} for everyone? Every camera stops.`)) return;
    act(session, async () => { await endSession(session.id); await load(); });
  };
  const remove = (session) => {
    if (!window.confirm(`Delete ${session.name} and all its videos? This can't be undone.`)) return;
    act(session, async () => {
      await deleteSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
    });
  };

  const chip = (id, label) => (
    <button type="button" key={id || "all"} aria-pressed={groupId === id}
      onClick={() => setGroupId(id)}>{label}</button>
  );

  return (
    <div className="watch-page">
      <style>{css}</style>
      <header className="watch-header">
        <span>
          <h1>Sessions</h1>
          {!loading && (
            <span className="watch-counts">
              {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
              {" · "}
              {recordingTotal} {recordingTotal === 1 ? "recording" : "recordings"}
            </span>
          )}
        </span>
        <span className="watch-tools">
          <label className="watch-search">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
            </svg>
            <input type="search" placeholder="Search sessions" aria-label="Search sessions"
              value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
        </span>
      </header>

      {(groups.length > 1 || noGroupCount > 0) && (
        <div className="watch-chips" role="group" aria-label="Group">
          {chip("", "All")}
          {groups.map((group) => chip(group.id, group.name))}
          {noGroupCount > 0 && chip(NO_GROUP, "No group")}
        </div>
      )}

      {actionError && <p role="alert" className="watch-error">{actionError}</p>}

      {loading ? (
        <p className="watch-quiet">Loading sessions...</p>
      ) : error ? (
        <p role="alert" className="watch-error">{error}</p>
      ) : groups.length === 0 && sessions.length === 0 ? (
        <EmptyState title="No groups yet" action="Find your group" to="/groups">
          Recordings belong to a group's sessions. Join your team's group to
          see them.
        </EmptyState>
      ) : (
        <>
          {nowSessions.length > 0 && (
            <NowRow count={nowSessions.length}>
              {nowSessions.map((session) => (
                <LiveCard key={session.id} session={session} groupName={groupName(session)}
                  joining={busyId === session.id}
                  onEnter={() => navigate(`/record/${session.id}`)}
                  onJoin={() => join(session)}>
                  {session.status === "active" && session.recordingCount > 0 && (
                    <button type="button" onClick={() => navigate(`/watch/${session.id}`)}>
                      Watch so far
                    </button>
                  )}
                  {session.status === "active" && canManage(session) && (
                    <button type="button" disabled={busyId === session.id} onClick={() => end(session)}>
                      End session
                    </button>
                  )}
                </LiveCard>
              ))}
            </NowRow>
          )}

          <section className="watch-past">
            <h2>Past</h2>
            {past.length === 0 ? (
              <EmptyState
                title={query ? "No sessions match" : "No recordings yet"}
                action="New session"
                onAction={() => openNewSession()}
              >
                {query ? "Try another name or group." : "Every finished session shows up here with its recordings."}
              </EmptyState>
            ) : months.map((month) => (
              <div key={month.label} className="watch-month">
                <h3>{month.label}</h3>
                <ul className="watch-cards">
                  {month.sessions.map((session) => (
                    <li key={session.id}>
                      <button type="button" className="watch-card" onClick={() => navigate(`/watch/${session.id}`)}>
                        <span className="watch-thumb" aria-hidden="true">
                          {session.thumbnailUrl && <img src={session.thumbnailUrl} alt="" loading="lazy" />}
                          {session.recordingCount != null && (
                            <span className="watch-takes">
                              {session.recordingCount} {session.recordingCount === 1 ? "recording" : "recordings"}
                            </span>
                          )}
                        </span>
                        <strong>{session.name}</strong>
                        <span className="watch-meta">
                          {new Date(session.scheduledAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          {" · "}{groupName(session)}
                          {session.memberCount != null &&
                            ` · ${session.memberCount} ${session.memberCount === 1 ? "camera" : "cameras"}`}
                        </span>
                      </button>
                      {/* Admins (and the creator, without a group) can delete,
                          from a menu so it isn't one stray click away. */}
                      {canDelete(session) && (
                        <span className="watch-menu">
                          <button type="button" className="watch-menu-button" aria-label={`More for ${session.name}`}
                            aria-expanded={menuId === session.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuId((current) => current === session.id ? null : session.id);
                            }}>···</button>
                          {menuId === session.id && (
                            <span className="watch-menu-list" role="menu">
                              <button type="button" role="menuitem" disabled={busyId !== null}
                                onClick={() => remove(session)}>Delete session</button>
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

const css = `
  .watch-page { max-width: 1480px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
  .watch-header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px 20px; }
  .watch-header h1 { margin: 0; font-size: 2.2rem; font-weight: 800; letter-spacing: -0.5px; }
  .watch-counts { display: block; margin-top: 4px; color: #8a8a8a; font-size: 0.95rem; }
  .watch-tools { display: flex; flex-wrap: wrap; gap: 10px; }
  .watch-search {
    display: flex; align-items: center; gap: 8px; width: 280px; max-width: 100%; height: 42px;
    padding: 0 14px; box-sizing: border-box; border-radius: 21px; background: #1b1b1e; color: #8a8a90;
  }
  .watch-search input { flex: 1; min-width: 0; border: none; outline: none; background: none; color: #f0f0f0; font: inherit; font-size: 0.9rem; }
  .watch-search:focus-within { box-shadow: 0 0 0 2px var(--accent); }
  .watch-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .watch-chips button {
    height: 36px; padding: 0 16px; border: none; border-radius: 18px;
    background: #1b1b1e; color: #f0f0f0; font: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  }
  .watch-chips button:hover { background: #26262a; }
  .watch-chips button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
  .watch-page .watch-error { margin: 0; color: #ff8a80; }
  .watch-quiet { margin: 0; color: #8a8a8a; font-size: 0.95rem; }
  .watch-page h2 { margin: 0; font-size: 1.15rem; font-weight: 700; }

  .watch-past { display: flex; flex-direction: column; gap: 14px; }
  .watch-month { display: flex; flex-direction: column; gap: 12px; }
  .watch-month h3 { margin: 4px 0 0; color: #8a8a8a; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; }
  .watch-cards {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 22px 16px;
    margin: 0; padding: 0; list-style: none;
  }
  .watch-cards li { position: relative; min-width: 0; }
  .watch-card {
    display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 0;
    border: none; background: none; color: #f0f0f0; font: inherit; text-align: left; cursor: pointer;
  }
  .watch-thumb {
    position: relative; display: block; aspect-ratio: 16 / 9; margin-bottom: 6px;
    border-radius: 12px; background: #161616; overflow: hidden;
  }
  .watch-thumb img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.2s; }
  .watch-card:hover .watch-thumb img { transform: scale(1.04); }
  .watch-card:hover strong { color: var(--accent); }
  .watch-takes {
    position: absolute; right: 8px; bottom: 8px; padding: 2px 8px; border-radius: 6px;
    background: rgba(0,0,0,0.75); color: #fff; font-size: 0.78rem; font-weight: 600;
  }
  .watch-card strong {
    line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .watch-meta { color: #8a8a8a; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The ··· sits on the picture's corner. */
  .watch-menu { position: absolute; top: 8px; right: 8px; }
  .watch-menu-button {
    width: 32px; height: 26px; padding: 0; border: none; border-radius: 8px;
    background: rgba(0,0,0,0.7); color: #fff; font: inherit; font-weight: 800; letter-spacing: 1px; cursor: pointer;
  }
  .watch-menu-button:hover, .watch-menu-button[aria-expanded="true"] { background: #000; }
  .watch-menu-list {
    position: absolute; right: 0; top: 30px; z-index: 5; min-width: 160px; padding: 6px;
    border-radius: 12px; background: #1b1b1e; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .watch-menu-list button {
    display: block; width: 100%; padding: 8px 10px; border: none; border-radius: 8px;
    background: none; color: #ff8a8d; font: inherit; font-size: 0.9rem; font-weight: 600; text-align: left; cursor: pointer;
  }
  .watch-menu-list button:hover { background: #3a1416; }
  .watch-menu-list button:disabled { opacity: 0.5; cursor: default; }

  @media (max-width: 560px) {
    .watch-search { width: 100%; }
    .watch-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
`;

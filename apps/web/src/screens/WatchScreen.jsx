import { useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.jsx";
import { useNewSession } from "../components/NewSession.jsx";
import { SessionScheduler } from "../components/SessionScheduler.jsx";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";

import { getGroups, getPrimaryGroupId } from "../api/groups.js";
import { deleteSession, getSessions } from "../api/recordings.js";

function sessionLabel(session) {
  const date = new Date(session.scheduledAt);
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(),
    date.getHours(), date.getMinutes(), date.getSeconds()];
  return `Session-${parts.map((part) => String(part).padStart(2, "0")).join("-")}-${session.groupId ?? session.name}`;
}

// The picker's value for sessions started without a group.
const NO_GROUP = "__none";

export function WatchScreen() {
  const { user } = useAuth();
  const [groupId, setGroupId] = useState("");
  const [groups, setGroups] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const openNewSession = useNewSession();
  const [params] = useSearchParams();
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState("");

  // Finished, with something to watch, newest first.
  const watchable = (loaded) => loaded
    .filter((session) => session.status === "complete" && session.recordingCount !== 0)
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));

  // A session that just ended (or a new upload) appears without a reload.
  useAutoRefresh(() => {
    getSessions().then((loaded) => setSessions(watchable(loaded))).catch(() => {});
  }, 15000);

  useEffect(() => {
    Promise.all([getGroups(), getSessions()])
      .then(([loadedGroups, loadedSessions]) => {
        setGroups(loadedGroups);
        // A group page links here with ?group= so its recordings open directly.
        const requested = params.get("group");
        setGroupId(
          requested && loadedGroups.some((group) => group.id === requested)
            ? requested
            : getPrimaryGroupId(user, loadedGroups)
        );
        setSessions(watchable(loadedSessions));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [user.id]);

  const group = groups.find((group) => group.id === groupId);
  const noGroupSessions = sessions.filter((session) => session.groupId == null);
  const groupSessions = groupId === NO_GROUP
    ? noGroupSessions
    : sessions.filter((session) => session.groupId === groupId);
  // Sessions without a group: their creator can delete them.
  const canDelete = (session) =>
    session.groupId == null ? session.createdBy === Number(user.id) : group?.role === "admin";

  const removeSession = async (session) => {
    if (!window.confirm(`Delete ${sessionLabel(session)} and all its videos? This cannot be undone.`)) return;
    setDeletingId(session.id);
    setDeleteError("");
    try {
      await deleteSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="watch-page">
      <style>{css}</style>
      <h1>Sessions</h1>
      <SessionScheduler showForms={false} />
      <h2 className="watch-past-title">Past</h2>

      {loading ? (
        <p>Loading sessions...</p>
      ) : error ? (
        <p role="alert" className="watch-error">{error}</p>
      ) : groups.length === 0 && noGroupSessions.length === 0 ? (
        <EmptyState title="No groups yet" action="Find your group" to="/groups">
          Recordings belong to a group's sessions. Join your team's group to
          see them.
        </EmptyState>
      ) : (
        <section className="watch-group">
          <div className="watch-group-header">
            <label htmlFor="watch-group">Group:</label>
            {groups.length > 1 || !group || noGroupSessions.length > 0 ? (
              <select id="watch-group" value={groupId} onChange={(event) => {
                setGroupId(event.target.value);
              }}>
                {!group && groupId !== NO_GROUP && <option value={groupId} disabled>Choose a group</option>}
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
                {noGroupSessions.length > 0 && <option value={NO_GROUP}>No group</option>}
              </select>
            ) : <strong>{group?.name}</strong>}
          </div>
          <div className="watch-group-content">
            {deleteError && <p role="alert" className="watch-error">{deleteError}</p>}
            {groupSessions.length === 0 ? (
              <EmptyState
                title={`No sessions in ${groupId === NO_GROUP ? "sessions without a group" : group?.name || "this group"} yet`}
                action="New session"
                onAction={() => openNewSession()}
              >
                Every completed session shows up here with its recordings.
              </EmptyState>
            ) : groupSessions.map((session) => (
              <div className="watch-session" key={session.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/watch/${session.id}`)}
                >
                  <strong>{sessionLabel(session)}</strong>
                  <span className="watch-metadata">
                    <span>Members in Session: {session.memberCount ?? "—"}</span>
                    <span>Recordings: {session.recordingCount ?? "—"}</span>
                  </span>
                </button>
                {/* Admins and the owner (who keeps an admin role) can delete. */}
                {canDelete(session) && (
                  <button type="button" className="watch-delete"
                    aria-label={`Delete ${sessionLabel(session)}`}
                    title="Delete session and videos"
                    disabled={deletingId !== null}
                    onClick={() => removeSession(session)}>×</button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const css = `
  .watch-past-title { margin: 2rem 0 0.75rem; font-size: 1.3rem; }
  .watch-page { max-width: 900px; }
  .watch-page h1 { margin: 0 0 1.5rem; font-size: 1.8rem; }
  .watch-page p { color: #999; line-height: 1.6; }
  .watch-page a { color: var(--accent); }
  .watch-page .watch-error { color: var(--error-ink); }
  .watch-group {
    border: 1px solid var(--raised);
    border-radius: 12px;
    background: var(--card-hover);
    overflow: hidden;
  }
  .watch-group-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 1rem;
    background: var(--raised);
  }
  .watch-group-header select {
    min-width: 0;
    flex: 1;
    padding: 0.4rem;
    border: 1px solid #555;
    border-radius: 6px;
    background: var(--card-hover);
    color: var(--text-strong);
    font: inherit;
  }
  .watch-group-content { padding: 1rem; }
  .watch-group-content > p { margin: 0; }
  .watch-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    width: 100%;
    color: #999;
    font-size: 0.85rem;
  }
  .watch-group h2 { margin: 0 0 0.75rem; font-size: 1.2rem; }
  .watch-session {
    display: flex;
    align-items: center;
    margin-bottom: 8px;
    border: 1px solid var(--raised);
    border-radius: 8px;
    background: var(--card-hover);
    overflow: hidden;
  }
  .watch-session button {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px 20px;
    flex: 1;
    min-width: 0;
    padding: 16px;
    border: none;
    background: transparent;
    color: var(--text-strong);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .watch-session .watch-delete {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    margin-right: 12px;
    padding: 0;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: #ff6b6b;
    font-size: 1.3rem;
  }
  .watch-session .watch-delete:hover { background: var(--error-bg); }
  .watch-session .watch-delete:disabled { opacity: 0.4; cursor: default; }
  .watch-session button:hover { background: var(--field); }
  .watch-session button[aria-expanded="true"] { background: var(--field); }
  .watch-session strong { overflow-wrap: anywhere; }
  .watch-session time { color: #999; font-size: 0.9rem; }
  .watch-session p { margin: 0; padding: 16px; }
`;

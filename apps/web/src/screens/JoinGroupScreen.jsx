import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { getGroupInvite, joinGroup } from "../api/groups.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { useGroupTheme } from "../theme/GroupThemeContext.jsx";
import { groupTile } from "../theme/groupTheme.js";

/// Where an invite link lands (/join/:id): shows the group and joins it,
/// asking for the password when the group is private.
export function JoinGroupScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refresh: refreshTheme } = useGroupTheme();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    getGroupInvite(id)
      .then(setGroup)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const join = async (event) => {
    event.preventDefault();
    setJoining(true);
    setJoinError("");
    try {
      await joinGroup(group.id, password);
      refreshTheme().catch(() => {});
      navigate(`/groups/${encodeURIComponent(group.id)}`, { replace: true });
    } catch (err) {
      setJoinError(err.message);
      setJoining(false);
    }
  };

  if (loading) return <p style={{ color: "#999" }}>Loading invite...</p>;
  if (error || !group) {
    return (
      <EmptyState title="Invite not found" action="Go to Groups" to="/groups">
        {error || "This invite link doesn't match a group."}
      </EmptyState>
    );
  }

  const tile = groupTile(group);

  return (
    <div className="jg-page">
      <style>{css}</style>
      <div className="jg-card">
        <div className="jg-banner" style={tile ? { background: tile.fill, color: tile.ink } : undefined}>
          <span>You're invited to join</span>
          <h1>{group.name}</h1>
        </div>
        {group.isMember ? (
          <div className="jg-body">
            <p>You're already in this group.</p>
            <Link className="jg-button" to={`/groups/${encodeURIComponent(group.id)}`}>
              Open {group.name}
            </Link>
          </div>
        ) : (
          <form className="jg-body" onSubmit={join}>
            {!group.isPublic && (
              <label>
                Group password
                <input type="password" value={password} required autoFocus
                  onChange={(event) => setPassword(event.target.value)} />
              </label>
            )}
            {joinError && <p role="alert" className="jg-error">{joinError}</p>}
            <button type="submit" className="jg-button" disabled={joining}>
              {joining ? "Joining..." : `Join ${group.name}`}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const css = `
  .jg-page { display: flex; justify-content: center; padding-top: 6vh; }
  .jg-card { width: min(420px, 100%); border-radius: 16px; overflow: hidden; background: var(--card); }
  .jg-banner { padding: 22px 22px 20px; background: var(--panel); color: var(--text-strong); }
  .jg-banner span { font-size: 0.85rem; opacity: 0.8; }
  .jg-banner h1 { margin: 4px 0 0; font-size: 1.7rem; overflow-wrap: anywhere; }
  .jg-body { display: flex; flex-direction: column; gap: 14px; padding: 20px 22px 22px; }
  .jg-body p { margin: 0; color: #aaa; }
  .jg-body label { display: flex; flex-direction: column; gap: 6px; color: #ddd; font-size: 0.85rem; font-weight: 600; }
  .jg-body input {
    box-sizing: border-box; padding: 10px 11px; border: 1px solid var(--line-strong); border-radius: 7px;
    background: var(--field); color: var(--text-strong); font: inherit;
  }
  .jg-button {
    display: block; padding: 12px 16px; border: none; border-radius: 10px; text-align: center;
    background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 700;
    text-decoration: none; cursor: pointer;
  }
  .jg-button:disabled { opacity: 0.6; cursor: default; }
  .jg-error { color: var(--error-ink) !important; }
`;

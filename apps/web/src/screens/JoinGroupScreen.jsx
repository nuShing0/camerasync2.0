import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { getInvite, joinWithInvite, requestToJoin } from "../api/groups.js";
import { useGroupTheme } from "../theme/GroupThemeContext.jsx";
import { groupTile } from "../theme/groupTheme.js";

// On a phone, the app can take the invite instead (its eightkount:// links).
const ON_PHONE = typeof navigator !== "undefined" && /android|iphone|ipad/i.test(navigator.userAgent);

/// Where an invite link lands (/join/:code): shows the group and joins it.
/// Links from before invite codes carry the group's ID instead; those can
/// still ask to join, for an admin to approve.
export function JoinGroupScreen() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { refresh: refreshTheme } = useGroupTheme();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [asked, setAsked] = useState(null);

  useEffect(() => {
    getInvite(code)
      .then(setGroup)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [code]);

  const join = async () => {
    setJoining(true);
    setJoinError("");
    try {
      const joined = await joinWithInvite(code);
      refreshTheme().catch(() => {});
      navigate(`/groups/${encodeURIComponent(joined.id)}`, { replace: true });
    } catch (err) {
      setJoinError(err.message);
      setJoining(false);
    }
  };

  const ask = async () => {
    setJoining(true);
    setJoinError("");
    try {
      setAsked(await requestToJoin(code));
    } catch (err) {
      setJoinError(err.message);
    } finally {
      setJoining(false);
    }
  };

  if (loading) return <p style={{ color: "#999" }}>Loading invite...</p>;

  if (error || !group) {
    return (
      <div className="jg-page">
        <style>{css}</style>
        <div className="jg-card">
          <div className="jg-banner">
            <span>Invite not found</span>
            <h1>This invite doesn't work</h1>
          </div>
          <div className="jg-body">
            <p>It may have been reset by the group's admin. Ask them for a new link or code.</p>
            {asked ? (
              <p className="jg-done">
                {asked.status === "member"
                  ? `You're already in ${asked.group.name}.`
                  : `Request sent to ${asked.group.name}. You'll be in once an admin approves it.`}
              </p>
            ) : /^[A-Za-z0-9]+$/.test(code) && (
              <>
                <p>If this is an older link with the group's ID, you can ask to join it instead.</p>
                {joinError && <p role="alert" className="jg-error">{joinError}</p>}
                <button type="button" className="jg-button" disabled={joining} onClick={ask}>
                  {joining ? "Sending..." : `Ask to join ${code}`}
                </button>
              </>
            )}
            <Link className="jg-link" to="/groups">Go to Groups</Link>
          </div>
        </div>
      </div>
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
          <small>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</small>
        </div>
        <div className="jg-body">
          {group.isMember ? (
            <>
              <p>You're already in this group.</p>
              <Link className="jg-button" to={`/groups/${encodeURIComponent(group.id)}`}>
                Open {group.name}
              </Link>
            </>
          ) : (
            <>
              {joinError && <p role="alert" className="jg-error">{joinError}</p>}
              <button type="button" className="jg-button" disabled={joining} onClick={join}>
                {joining ? "Joining..." : `Join ${group.name}`}
              </button>
            </>
          )}
          {ON_PHONE && (
            <a className="jg-link" href={`eightkount://join/${encodeURIComponent(code)}`}>
              Open in the 8kount app
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

const css = `
  .jg-page { display: flex; justify-content: center; padding-top: 6vh; }
  .jg-card { width: min(420px, 100%); border-radius: 24px; overflow: hidden; background: #111113; }
  .jg-banner { padding: 26px 24px 22px; background: #242424; color: #f0f0f0; }
  .jg-banner span { font-size: 0.85rem; opacity: 0.8; }
  .jg-banner h1 { margin: 4px 0 0; font-size: 1.7rem; overflow-wrap: anywhere; }
  .jg-body { display: flex; flex-direction: column; gap: 14px; padding: 20px 22px 22px; }
  .jg-body p { margin: 0; color: #aaa; }
  .jg-body label { display: flex; flex-direction: column; gap: 6px; color: #ddd; font-size: 0.85rem; font-weight: 600; }
  .jg-body input {
    box-sizing: border-box; padding: 10px 11px; border: 1px solid #3a3a3a; border-radius: 7px;
    background: #262626; color: #f0f0f0; font: inherit;
  }
  .jg-button {
    display: block; padding: 13px 16px; border: none; border-radius: 999px; text-align: center;
    background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 700;
    text-decoration: none; cursor: pointer;
  }
  .jg-button:disabled { opacity: 0.6; cursor: default; }
  .jg-error { color: #ff8a80 !important; }
  .jg-banner small { display: block; margin-top: 4px; opacity: 0.8; font-size: 0.85rem; }
  .jg-done { color: #e8e8e8 !important; line-height: 1.5; }
  .jg-link { align-self: center; color: var(--accent); font-size: 0.9rem; font-weight: 600; text-decoration: none; }
  .jg-link:hover { text-decoration: underline; }
`;

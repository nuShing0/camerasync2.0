import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";
import {
  changeGroupMemberRole,
  getGroupMembers,
  getGroups,
  removeGroupMember,
  deleteGroup,
  leaveGroup,
  transferGroup,
  updateGroupColor,
  updateGroupDetails,
} from "../api/groups.js";
import { createLiveSession, getSessions, joinSession } from "../api/recordings.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { TeamColorPicker } from "../components/TeamColorPicker.jsx";
import { useGroupTheme } from "../theme/GroupThemeContext.jsx";
import { groupTile } from "../theme/groupTheme.js";
import { teamColor } from "../theme/teamColors.js";

const ROSTER_PAGE_SIZE = 30;
const RECORDINGS_ON_PAGE = 4;
const ROLE_LABEL = { admin: "an admin", member: "a member", viewer: "a viewer" };

/// One group's page, opened by tapping it on the Groups screen: its live
/// session (to join) or starting one, its recordings, and below them its
/// settings: whether it is the user's primary group (whose color the app
/// takes), its team color (admins and the owner), invites and its roster.
export function GroupSettingsScreen() {
  const { id } = useParams();
  const { user, updateProfile } = useAuth();
  const { activeGroup, refresh: refreshTheme } = useGroupTheme();
  const navigate = useNavigate();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [primaryError, setPrimaryError] = useState("");
  const [savingPrimary, setSavingPrimary] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getGroups()
      .then((groups) => {
        if (!cancelled) {
          setGroup(groups.find((g) => g.id.toLowerCase() === id.toLowerCase()) ?? null);
        }
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return <p style={{ color: "#999" }}>Loading group...</p>;
  if (error) return <p role="alert" style={{ color: "var(--error-ink)" }}>{error}</p>;
  if (!group) {
    return (
      <EmptyState title="Group not found" action="Back to Groups" to="/groups">
        You may have left this group, or the link is wrong.
      </EmptyState>
    );
  }

  const tile = groupTile(group);
  const isOwner = Number(user.id) === group.owner;
  const canManage = isOwner || group.role === "admin";
  const isPrimary = activeGroup?.id === group.id;
  const yourRole = isOwner ? "the owner" : ROLE_LABEL[group.role] ?? "a member";

  const makePrimary = async () => {
    setSavingPrimary(true);
    setPrimaryError("");
    try {
      await updateProfile({ primaryGroupId: group.id });
    } catch (err) {
      setPrimaryError(err.message);
    } finally {
      setSavingPrimary(false);
    }
  };

  return (
    <div className="gs-page">
      <style>{css}</style>
      <Link to="/groups" className="gs-back">← Groups</Link>

      <header className="gs-banner" style={tile
        ? { background: tile.fill, color: tile.ink }
        : undefined}>
        <div>
          <h1>{group.name}</h1>
          <p>
            ID {group.id} · {group.isPublic ? "Public" : "Private"} · You're {yourRole}
          </p>
        </div>
      </header>

      <GroupSessions group={group} canManage={canManage} />

      <h2 className="gs-heading">Settings</h2>

      <section className="gs-card">
        <h2>Primary group</h2>
        {isPrimary ? (
          <p>This is your primary group, so the app uses its color.</p>
        ) : (
          <>
            <p>Your primary group sets the app's color.</p>
            <button type="button" className="gs-button gs-button-primary"
              disabled={savingPrimary} onClick={makePrimary}>
              {savingPrimary ? "Saving..." : `Make ${group.name} my primary group`}
            </button>
          </>
        )}
        {primaryError && <p role="alert" className="gs-error">{primaryError}</p>}
      </section>

      {canManage && (
        <TeamColorSection
          group={group}
          onSaved={(updated) => {
            setGroup((current) => ({ ...current, ...updated }));
            refreshTheme().catch(() => {});
          }}
        />
      )}

      <InviteSection group={group} />

      <MembersSection group={group} isOwner={isOwner}
        onTransferred={(updated) => setGroup((current) => ({ ...current, ...updated }))} />

      {isOwner ? (
        <OwnerSection
          group={group}
          onSaved={(updated) => setGroup((current) => ({ ...current, ...updated }))}
          onGone={() => {
            refreshTheme().catch(() => {});
            navigate("/groups");
          }}
        />
      ) : (
        <LeaveSection
          group={group}
          onLeft={() => {
            refreshTheme().catch(() => {});
            navigate("/groups");
          }}
        />
      )}
    </div>
  );
}

/// The group's live session to join, starting a new one (admins and the
/// owner, the same people the server lets create sessions), and its
/// finished sessions' recordings, newest first.
function GroupSessions({ group, canManage }) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSessions()
      .then((all) => {
        if (!cancelled) setSessions(all.filter((session) => session.groupId === group.id));
      })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [group.id]);

  const live = (sessions ?? []).filter((session) => session.status === "active");
  const recordings = (sessions ?? [])
    .filter((session) => session.status === "complete")
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));

  const start = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await createLiveSession({
        groupId: group.id,
        name: name.trim() || `${group.name} practice`,
      });
      navigate(`/record/${session.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const join = async (session) => {
    setBusy(true);
    setError("");
    try {
      if (!session.isJoined) await joinSession(session.id);
      navigate(`/record/${session.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <>
      <section className="gs-card">
        <h2>Practice</h2>
        {live.map((session) => (
          <div key={session.id} className="gs-live">
            <span className="gs-live-dot" aria-hidden="true" />
            <span className="gs-live-name">{session.name}</span>
            <span className="gs-live-meta">
              {session.activeMemberCount} {session.activeMemberCount === 1 ? "device" : "devices"}
            </span>
            <button type="button" className="gs-button gs-button-primary" disabled={busy}
              onClick={() => join(session)}>
              {session.isJoined ? "Enter" : "Join"}
            </button>
          </div>
        ))}
        {live.length === 0 && (canManage ? (
          <form className="gs-start" onSubmit={start}>
            <input value={name} maxLength={100} aria-label="Session name"
              placeholder={`${group.name} practice`}
              onChange={(event) => setName(event.target.value)} />
            <button type="submit" className="gs-button gs-button-primary" disabled={busy}>
              {busy ? "Starting..." : "Start a session"}
            </button>
          </form>
        ) : (
          <p>Nothing live right now. An admin starts sessions for this group.</p>
        ))}
        {error && <p role="alert" className="gs-error">{error}</p>}
      </section>

      <section className="gs-card">
        {/* The newest few here; View all opens the group's full list. */}
        <div className="gs-section-row">
          <h2>Sessions</h2>
          {recordings.length > 0 && (
            <Link className="gs-view-all" to={`/watch?group=${encodeURIComponent(group.id)}`}>
              View all
            </Link>
          )}
        </div>
        {sessions === null && !error ? (
          <p>Loading...</p>
        ) : recordings.length === 0 ? (
          <p>No recordings yet. Finished sessions show up here.</p>
        ) : (
          <ul className="gs-recordings">
            {recordings.slice(0, RECORDINGS_ON_PAGE).map((session) => (
              <li key={session.id}>
                <Link to={`/watch/${session.id}`}>
                  <span className="gs-thumb" aria-hidden="true"><span /></span>
                  <span className="gs-rec-text">
                    <strong>{session.name}</strong>
                    <span>
                      {new Date(session.scheduledAt).toLocaleDateString(undefined, {
                        month: "short", day: "numeric",
                      })}
                      {session.memberCount != null &&
                        ` · ${session.memberCount} ${session.memberCount === 1 ? "device" : "devices"}`}
                    </span>
                  </span>
                  {session.recordingCount != null && (
                    <span className="gs-rec-count">
                      {session.recordingCount} {session.recordingCount === 1 ? "recording" : "recordings"}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/// The owner's controls: the group's name and privacy, and deleting it.
/// Handing the group to someone else is in the Members list.
function OwnerSection({ group, onSaved, onGone }) {
  const [name, setName] = useState(group.name);
  const [isPublic, setIsPublic] = useState(group.isPublic);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dangerError, setDangerError] = useState("");

  const changed = name.trim() !== group.name || isPublic !== group.isPublic || password;

  const saveDetails = async (event) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      onSaved(await updateGroupDetails(group.id, { name: name.trim(), isPublic, password }));
      setPassword("");
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${group.name} with all of its sessions, recordings and comments? This can't be undone.`)) return;
    setBusy(true);
    setDangerError("");
    try {
      await deleteGroup(group.id);
      onGone();
    } catch (err) {
      setDangerError(err.message);
      setBusy(false);
    }
  };

  return (
    <>
      <section className="gs-card">
        <h2>Group details</h2>
        <form className="gs-form" onSubmit={saveDetails}>
          <label>
            Name
            <input value={name} maxLength={100} required
              onChange={(event) => { setName(event.target.value); setSaved(false); }} />
          </label>
          <label className="gs-check">
            <input type="checkbox" checked={!isPublic}
              onChange={(event) => { setIsPublic(!event.target.checked); setSaved(false); }} />
            Private: people need a password to join
          </label>
          {!isPublic && (
            <label>
              {group.isPublic ? "Password" : "New password (leave blank to keep the current one)"}
              <input type="password" value={password} required={group.isPublic}
                onChange={(event) => { setPassword(event.target.value); setSaved(false); }} />
            </label>
          )}
          {error && <p role="alert" className="gs-error">{error}</p>}
          <div className="gs-actions">
            {saved && !changed && <span className="gs-saved">Saved</span>}
            <button type="submit" className="gs-button gs-button-primary" disabled={saving || !changed}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </section>

      <section className="gs-card gs-danger-card">
        <h2>Delete group</h2>
        <p>Deleting the group removes every session, recording and comment in it.</p>
        <button type="button" className="gs-button gs-button-danger" disabled={busy} onClick={remove}>
          Delete group
        </button>
        {dangerError && <p role="alert" className="gs-error">{dangerError}</p>}
      </section>
    </>
  );
}

/// The group's invite link, to copy or (where the browser can) share.
function InviteSection({ group }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const message = `Join ${group.name} on 8kount`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(group.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this invite link:", group.inviteUrl);
    }
  };

  const share = () => {
    navigator.share({ title: message, text: message, url: group.inviteUrl }).catch(() => {});
  };

  return (
    <section className="gs-card">
      <h2>Invite people</h2>
      <p>
        Anyone with this link can join
        {group.isPublic ? "." : " once they enter the group password."}
      </p>
      <div className="gs-inline">
        <input className="gs-invite-link" value={group.inviteUrl} readOnly
          aria-label="Invite link" onFocus={(event) => event.target.select()} />
        <button type="button" className="gs-button gs-button-primary" onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
        {canShare && (
          <button type="button" className="gs-button" onClick={share}>Share</button>
        )}
      </div>
    </section>
  );
}

function LeaveSection({ group, onLeft }) {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");

  const leave = async () => {
    if (!window.confirm(`Leave ${group.name}? You'll need its ID${group.isPublic ? "" : " and password"} to join again.`)) return;
    setLeaving(true);
    setError("");
    try {
      await leaveGroup(group.id);
      onLeft();
    } catch (err) {
      setError(err.message);
      setLeaving(false);
    }
  };

  return (
    <section className="gs-card">
      <h2>Leave group</h2>
      <p>You'll stop seeing its sessions and recordings.</p>
      <button type="button" className="gs-button gs-button-danger" disabled={leaving} onClick={leave}>
        {leaving ? "Leaving..." : "Leave group"}
      </button>
      {error && <p role="alert" className="gs-error">{error}</p>}
    </section>
  );
}

function TeamColorSection({ group, onSaved }) {
  // A color picked before the palette existed starts unselected.
  const [color, setColor] = useState(teamColor(group.primaryColor));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const changed = color && color !== String(group.primaryColor).toLowerCase();

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      onSaved(await updateGroupColor(group.id, color));
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="gs-card">
      <h2>Team color</h2>
      <p>Shown on the group's tile, and across the app for anyone whose primary group this is.</p>
      <TeamColorPicker value={color} onChange={(hex) => { setColor(hex); setSaved(false); }} />
      {error && <p role="alert" className="gs-error">{error}</p>}
      <div className="gs-actions">
        {saved && !changed && <span className="gs-saved">Saved</span>}
        <button type="button" className="gs-button gs-button-primary"
          disabled={saving || !changed} onClick={save}>
          {saving ? "Saving..." : "Save color"}
        </button>
      </div>
    </section>
  );
}

function MembersSection({ group, isOwner, onTransferred }) {
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getGroupMembers(group.id)
      .then((loaded) => { if (!cancelled) setMembers(loaded); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [group.id]);

  const isAdmin = members.find((member) => member.id === Number(user.id))?.role === "admin";

  // A role change saves straight away (it's easy to undo). Removing someone,
  // or making them the owner (only they could hand it back), asks first.
  const updateMember = async (member, role) => {
    if (!role && !window.confirm(`Remove ${member.name} from this group?`)) return;
    if (role === "owner" && !window.confirm(
      `Make ${member.name} the owner of ${group.name}? You'll become an admin, and only they can hand it back.`
    )) return;
    setSaving(true);
    setActionError("");
    try {
      if (role === "owner") {
        const updated = await transferGroup(group.id, member.id);
        // The old owner stays on as an admin, and so does the new one.
        setMembers((current) => current.map((item) =>
          item.id === member.id || item.id === Number(user.id) ? { ...item, role: "admin" } : item
        ));
        onTransferred(updated);
      } else if (role) {
        await changeGroupMemberRole(group.id, member.id, role);
        setMembers((current) => current.map((item) =>
          item.id === member.id ? { ...item, role } : item
        ));
      } else {
        await removeGroupMember(group.id, member.id);
        const remaining = members.filter((item) => item.id !== member.id);
        setMembers(remaining);
        setPage(Math.min(page, Math.max(0, Math.ceil(remaining.length / ROSTER_PAGE_SIZE) - 1)));
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const pageCount = Math.ceil(members.length / ROSTER_PAGE_SIZE);

  return (
    <section className="gs-card">
      <h2>Members{loading ? "" : ` (${members.length})`}</h2>
      {loading ? <p>Loading members...</p> : error ? (
        <p role="alert" className="gs-error">{error}</p>
      ) : (
        <>
          {actionError && <p role="alert" className="gs-error">{actionError}</p>}
          <ul className="gs-members">
            {members.slice(page * ROSTER_PAGE_SIZE, (page + 1) * ROSTER_PAGE_SIZE).map((member) => {
              // The owner manages everyone else; admins manage members and
              // viewers (the server enforces the same rule).
              const canManage = member.id !== group.owner &&
                member.id !== Number(user.id) &&
                (isOwner || (isAdmin && ["member", "viewer"].includes(member.role)));
              return (
                <li key={member.id}>
                  <span className="gs-member-name">
                    {member.name}
                    {member.id === group.owner && <span className="gs-role">Owner</span>}
                  </span>
                  {canManage ? (
                    <span className="gs-member-actions">
                      <select value={member.role} disabled={saving}
                        aria-label={`Role for ${member.name}`}
                        onChange={(event) => updateMember(member, event.target.value)}>
                        {isOwner && <option value="owner">Owner</option>}
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button type="button" className="gs-remove" disabled={saving}
                        aria-label={`Remove ${member.name} from group`}
                        title="Remove from group"
                        onClick={() => updateMember(member, null)} />
                    </span>
                  ) : member.id !== group.owner && (
                    <span className="gs-role">
                      {member.role === "admin" ? "Admin" : member.role === "viewer" ? "Viewer" : "Member"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {pageCount > 1 && (
            <div className="gs-pages">
              <button type="button" className="gs-button" aria-label="Previous members page"
                disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
              <span>{page + 1} / {pageCount}</span>
              <button type="button" className="gs-button" aria-label="Next members page"
                disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>›</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const css = `
  .gs-page { max-width: 760px; display: flex; flex-direction: column; gap: 16px; }
  .gs-back { color: var(--accent); align-self: flex-start; }
  .gs-banner {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 22px 24px; border-radius: 12px; background: var(--panel); color: var(--text-strong);
  }
  .gs-banner h1 { margin: 0 0 6px; font-size: 1.8rem; overflow-wrap: anywhere; }
  .gs-banner p { margin: 0; opacity: 0.8; font-size: 0.9rem; }
  .gs-card { padding: 18px 20px; border-radius: 14px; background: var(--card); }
  .gs-card h2 { margin: 0 0 8px; font-size: 1.1rem; }
  .gs-card p { margin: 0 0 12px; color: #aaa; font-size: 0.9rem; line-height: 1.5; }
  .gs-button {
    padding: 8px 14px; border: 1px solid var(--line-strong); border-radius: 7px;
    background: var(--field); color: var(--text-strong); font: inherit; font-weight: 600; cursor: pointer;
  }
  .gs-button:hover { background: var(--raised); }
  .gs-button:disabled { opacity: 0.5; cursor: default; }
  .gs-button-primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
  .gs-button-primary:hover { background: var(--accent-hover); }
  .gs-on-banner { flex: 0 0 auto; border-color: rgba(0,0,0,0.25); background: rgba(0,0,0,0.18); color: inherit; }
  .gs-on-banner:hover { background: rgba(0,0,0,0.3); }
  .gs-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 14px; }
  .gs-saved { color: #8bd48b; font-size: 0.85rem; }
  .gs-error { color: var(--error-ink) !important; }
  .gs-form { display: flex; flex-direction: column; gap: 12px; }
  .gs-form label { display: flex; flex-direction: column; gap: 6px; color: #ddd; font-size: 0.85rem; font-weight: 600; }
  .gs-form input:not([type=checkbox]), .gs-inline select {
    box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 7px;
    background: var(--field); color: var(--text-strong); font: inherit;
  }
  .gs-form .gs-check { flex-direction: row; align-items: center; gap: 8px; font-weight: 500; }
  .gs-check input { accent-color: var(--accent); width: 16px; height: 16px; }
  .gs-inline { display: flex; flex-wrap: wrap; gap: 10px; }
  .gs-inline select { flex: 1; min-width: 180px; }
  .gs-invite-link {
    flex: 1; min-width: 200px; box-sizing: border-box; padding: 8px 10px;
    border: 1px solid var(--line-strong); border-radius: 7px; background: var(--field);
    color: var(--text-strong); font: inherit; font-size: 0.85rem;
  }
  .gs-spaced { margin-top: 18px !important; }
  .gs-button-danger { border-color: var(--error-line); background: var(--error-bg); color: var(--error-ink); }
  .gs-button-danger:hover { background: var(--error-bg); }
  .gs-members { list-style: none; margin: 0; padding: 0; }
  .gs-members li {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
    padding: 9px 0; border-top: 1px solid rgba(255,255,255,0.05); overflow-wrap: anywhere;
  }
  .gs-members li:first-child { border-top: none; }
  .gs-role { margin-left: 10px; color: #999; font-size: 0.8rem; }
  .gs-member-actions { display: flex; align-items: center; gap: 10px; }
  .gs-member-actions select {
    padding: 5px 8px; border: 1px solid var(--line-strong); border-radius: 7px;
    background: var(--field); color: var(--text-strong); font: inherit; font-size: 0.85rem;
  }
  /* A plain red line, drawn rather than typed so it sits dead center. */
  .gs-remove {
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0; border: none; border-radius: 7px;
    background: transparent; cursor: pointer;
  }
  .gs-remove::before {
    content: ""; width: 16px; height: 3px; border-radius: 2px; background: #e5484d;
  }
  .gs-remove:hover { background: rgba(229, 72, 77, 0.15); }
  .gs-remove:disabled { opacity: 0.5; cursor: default; }
  .gs-section-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .gs-card .gs-section-row h2 { margin: 0; }
  .gs-view-all { color: var(--accent); font-size: 0.9rem; font-weight: 600; text-decoration: none; }
  .gs-view-all:hover { text-decoration: underline; }
  .gs-heading { margin: 10px 0 -4px; color: #999; font-size: 0.85rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  .gs-live { display: flex; align-items: center; gap: 10px; padding: 6px 0 12px; }
  .gs-live-dot { width: 9px; height: 9px; border-radius: 50%; background: #f0432e; }
  .gs-live-name { flex: 1; min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
  .gs-live-meta { color: #999; font-size: 0.85rem; }
  .gs-start { display: flex; flex-wrap: wrap; gap: 10px; }
  .gs-start input {
    flex: 1; min-width: 180px; box-sizing: border-box; padding: 8px 10px;
    border: 1px solid var(--line-strong); border-radius: 7px; background: var(--field); color: var(--text-strong); font: inherit;
  }
  .gs-recordings { margin: 0; padding: 0; list-style: none; }
  .gs-recordings li + li { border-top: 1px solid rgba(255,255,255,0.05); }
  .gs-recordings a {
    display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; align-items: center; gap: 14px;
    padding: 9px 4px; border-radius: 9px; color: var(--text-strong); text-decoration: none;
  }
  .gs-recordings a:hover { background: var(--card-hover); }
  .gs-thumb { display: flex; align-items: center; justify-content: center; height: 38px; border-radius: 7px; background: #0a0b0d; }
  .gs-thumb span { width: 15px; height: 15px; border-radius: 50%; background: var(--accent); }
  .gs-rec-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .gs-rec-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gs-rec-text span { color: var(--text-dim); font-size: 0.8rem; }
  .gs-rec-count { color: var(--text-dim); font-size: 0.85rem; white-space: nowrap; }
  .gs-pages { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 10px; font-size: 0.85rem; }
  @media (max-width: 600px) {
    .gs-banner { flex-direction: column; align-items: flex-start; }
  }
`;

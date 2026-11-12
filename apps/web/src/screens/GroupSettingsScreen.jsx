import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";
import {
  approveJoinRequest,
  changeGroupMemberRole,
  declineJoinRequest,
  getJoinRequests,
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
import { InviteCard } from "../components/InviteCard.jsx";
import { LiveCard, NowRow } from "../components/LiveCard.jsx";
import { TeamColorPicker } from "../components/TeamColorPicker.jsx";
import { useGroupTheme } from "../theme/GroupThemeContext.jsx";
import { groupTile } from "../theme/groupTheme.js";
import { teamColor } from "../theme/teamColors.js";

const ROSTER_PAGE_SIZE = 30;
const RECORDINGS_ON_PAGE = 6;
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
  // ?invite=1, right after creating the group: ask to invite the team.
  const [params, setParams] = useSearchParams();
  const [group, setGroup] = useState(null);
  // Bumped when someone's let in, so the members list loads again.
  const [rosterVersion, setRosterVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
  if (error) return <p role="alert" style={{ color: "#ff8a80" }}>{error}</p>;
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

  // The group's page: its banner, then what it records (live, start one,
  // its sessions) beside who's in it and its settings.
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
            You're {yourRole}
          </p>
        </div>
        {/* Your primary group sets the app's color; it's picked in Settings. */}
        {isPrimary && (
          <span className="gs-badge" title="This group sets the app's color. Change it in Settings.">
            Your primary group
          </span>
        )}
      </header>

      <div className="gs-columns">
        <div className="gs-main">
          <GroupSessions group={group} canManage={canManage} />
        </div>

        <aside className="gs-side">
          {canManage && <RequestsSection group={group} onApproved={() => setRosterVersion((v) => v + 1)} />}

          <MembersSection key={rosterVersion} group={group} isOwner={isOwner}
            onTransferred={(updated) => setGroup((current) => ({ ...current, ...updated }))} />

          <section className="gs-card">
            <h2>Invite people</h2>
            <p>Anyone with the invite can join: share the link, read out the code, or show the QR.</p>
            <InviteCard group={group} canReset={canManage}
              onReset={(updated) => setGroup((current) => ({ ...current, ...updated }))} />
            {/* The ID is only for this now: someone without an invite asks
                to join with it, and an admin lets them in. */}
            <p className="gs-id-note">
              No invite? People can ask to join with the group ID <code>{group.id}</code>.
            </p>
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
        </aside>
      </div>

      {params.get("invite") && (
        <div className="gs-modal-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setParams({}, { replace: true }); }}>
          <div className="gs-modal" role="dialog" aria-modal="true" aria-label="Invite your team">
            <h2>Invite your team</h2>
            <p>{group.name} is ready. Send the link to your team's group chat, or have everyone scan the QR.</p>
            <InviteCard group={group} canReset={false} onReset={() => {}} />
            <button type="button" className="gs-start-button" onClick={() => setParams({}, { replace: true })}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/// The group's live session to join, starting a new one (admins and the
/// owner, the same people the server lets create sessions), and its
/// finished sessions' recordings, newest first.
function GroupSessions({ group, canManage }) {
  const navigate = useNavigate();
  const tile = groupTile(group);
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
    .filter((session) => session.status === "complete" && session.recordingCount !== 0)
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));

  const start = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await createLiveSession({
        groupId: group.id,
        name: name.trim() || `${group.name} session`,
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
      {live.length > 0 ? (
        // In this group's color, like its banner, whatever the app's is.
        <div style={tile ? { "--brand": tile.fill, "--brand-ink": tile.ink } : undefined}>
        <NowRow count={live.length}>
          {live.map((session) => (
            <LiveCard key={session.id} session={session} groupName={group.name}
              joining={busy}
              onEnter={() => navigate(`/record/${session.id}`)}
              onJoin={() => join(session)} />
          ))}
        </NowRow>
        </div>
      ) : canManage ? (
        <form className="gs-start" onSubmit={start}>
          <span>
            <strong>Start a session</strong>
            <span>Everyone in {group.name} can join with their phone.</span>
          </span>
          <input value={name} maxLength={100} aria-label="Session name"
            placeholder="Session name"
            onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="gs-start-button" disabled={busy}>
            {busy ? "Starting..." : "Start"}
          </button>
        </form>
      ) : (
        <p className="gs-quiet">Nothing live right now. An admin starts sessions for this group.</p>
      )}
      {error && <p role="alert" className="gs-error">{error}</p>}

      <section>
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
          <p className="gs-quiet">Loading...</p>
        ) : recordings.length === 0 ? (
          <p className="gs-quiet">No recordings yet. Finished sessions show up here.</p>
        ) : (
          <ul className="gs-recordings">
            {recordings.slice(0, RECORDINGS_ON_PAGE).map((session) => (
              <li key={session.id}>
                <Link to={`/watch/${session.id}`}>
                  <span className="gs-thumb" aria-hidden="true">
                    {session.thumbnailUrl && <img src={session.thumbnailUrl} alt="" loading="lazy" />}
                    {session.recordingCount != null && (
                      <span className="gs-rec-count">
                        {session.recordingCount} {session.recordingCount === 1 ? "recording" : "recordings"}
                      </span>
                    )}
                  </span>
                  <strong>{session.name}</strong>
                  <span className="gs-rec-meta">
                    {new Date(session.scheduledAt).toLocaleDateString(undefined, {
                      month: "short", day: "numeric",
                    })}
                    {session.memberCount != null &&
                      ` · ${session.memberCount} ${session.memberCount === 1 ? "camera" : "cameras"}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/// The owner's controls: the group's name, and deleting it.
/// Handing the group to someone else is in the Members list.
function OwnerSection({ group, onSaved, onGone }) {
  const [name, setName] = useState(group.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dangerError, setDangerError] = useState("");

  const changed = name.trim() !== group.name;

  const saveDetails = async (event) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      onSaved(await updateGroupDetails(group.id, { name: name.trim() }));
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

/// People asking to join by the group's ID, for its admins to let in or
/// turn away. Hidden when nobody's waiting.
function RequestsSection({ group, onApproved }) {
  const [requests, setRequests] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getJoinRequests(group.id)
      .then((loaded) => { if (!cancelled) setRequests(loaded); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [group.id]);

  const answer = async (request, approve) => {
    setBusyId(request.userId);
    setError("");
    try {
      await (approve ? approveJoinRequest : declineJoinRequest)(group.id, request.userId);
      setRequests((current) => current.filter((item) => item.userId !== request.userId));
      if (approve) onApproved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (requests.length === 0) return null;
  return (
    <section className="gs-card">
      <h2>Requests to join ({requests.length})</h2>
      {error && <p role="alert" className="gs-error">{error}</p>}
      <ul className="gs-requests">
        {requests.map((request) => (
          <li key={request.userId}>
            <span>
              <strong>{request.name}</strong>
              <small>{request.email} · {new Date(request.requestedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
            </span>
            <button type="button" className="gs-button" disabled={busyId !== null}
              onClick={() => answer(request, false)}>Decline</button>
            <button type="button" className="gs-button gs-button-primary" disabled={busyId !== null}
              onClick={() => answer(request, true)}>Let in</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LeaveSection({ group, onLeft }) {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");

  const leave = async () => {
    if (!window.confirm(`Leave ${group.name}? You'll need a new invite to join again.`)) return;
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
  .gs-page { max-width: 1480px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .gs-back {
    align-self: flex-start; padding: 8px 14px; border-radius: 999px; background: #1b1b1e;
    color: #f0f0f0; font-size: 0.85rem; font-weight: 600; text-decoration: none;
  }
  .gs-back:hover { background: #26262a; }
  .gs-banner {
    display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
    min-height: 150px; box-sizing: border-box; padding: 26px 28px; border-radius: 24px; background: #242424; color: #f0f0f0;
  }
  .gs-banner h1 { margin: 0 0 6px; font-size: 2.4rem; font-weight: 800; letter-spacing: -0.5px; overflow-wrap: anywhere; }
  .gs-banner p { margin: 0; opacity: 0.8; font-size: 0.92rem; font-weight: 500; }
  .gs-badge { flex: 0 0 auto; padding: 8px 14px; border-radius: 999px; background: rgba(0,0,0,0.18); font-size: 0.82rem; font-weight: 700; }
  /* What the group records beside who's in it and its settings. */
  .gs-columns { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 32px; align-items: start; }
  .gs-main, .gs-side { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  .gs-main h2 { margin: 0; font-size: 1.15rem; font-weight: 700; }
  .gs-quiet { margin: 0; color: #8a8a8a; font-size: 0.95rem; }
  .gs-card { padding: 18px 20px; border-radius: 18px; background: #111113; }
  .gs-card h2 { margin: 0 0 8px; font-size: 1.05rem; }
  .gs-card p { margin: 0 0 12px; color: #aaa; font-size: 0.9rem; line-height: 1.5; }
  .gs-button {
    padding: 8px 16px; border: 1px solid #3a3a3a; border-radius: 999px;
    background: #262626; color: #f0f0f0; font: inherit; font-weight: 600; cursor: pointer;
  }
  .gs-button:hover { background: #303030; }
  .gs-button:disabled { opacity: 0.5; cursor: default; }
  .gs-button-primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
  .gs-button-primary:hover { background: var(--accent-hover); }
  .gs-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 14px; }
  .gs-saved { color: #8bd48b; font-size: 0.85rem; }
  .gs-error { color: #ff8a80 !important; }
  .gs-form { display: flex; flex-direction: column; gap: 12px; }
  .gs-form label { display: flex; flex-direction: column; gap: 6px; color: #ddd; font-size: 0.85rem; font-weight: 600; }
  .gs-form input:not([type=checkbox]) {
    box-sizing: border-box; padding: 8px 10px; border: 1px solid #3a3a3a; border-radius: 7px;
    background: #262626; color: #f0f0f0; font: inherit;
  }
  .gs-button-danger { border-color: #5a2a2a; background: #2a1414; color: #ff8a80; }
  .gs-button-danger:hover { background: #3a1a1a; }
  .gs-members { list-style: none; margin: 0; padding: 0; }
  .gs-members li {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
    padding: 9px 0; border-top: 1px solid rgba(255,255,255,0.05); overflow-wrap: anywhere;
  }
  .gs-members li:first-child { border-top: none; }
  .gs-role { margin-left: 10px; color: #999; font-size: 0.8rem; }
  .gs-member-actions { display: flex; align-items: center; gap: 10px; }
  .gs-member-actions select {
    padding: 5px 8px; border: 1px solid #3a3a3a; border-radius: 7px;
    background: #262626; color: #f0f0f0; font: inherit; font-size: 0.85rem;
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
  .gs-section-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .gs-card .gs-section-row h2 { margin: 0; }
  .gs-view-all { color: var(--accent); font-size: 0.9rem; font-weight: 600; text-decoration: none; }
  .gs-view-all:hover { text-decoration: underline; }
  /* Starting a session: a card with the name and a big Start. */
  .gs-start {
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px;
    padding: 20px 22px; border-radius: 22px; background: #111113;
  }
  .gs-start > span { flex: 1 1 220px; display: flex; flex-direction: column; gap: 3px; }
  .gs-start > span strong { font-size: 1.15rem; }
  .gs-start > span span { color: #8a8a8a; font-size: 0.88rem; }
  .gs-start input {
    flex: 1 1 220px; min-width: 0; box-sizing: border-box; height: 46px; padding: 0 16px;
    border: 1px solid #2e2e32; border-radius: 23px; background: #1b1b1e; color: #f0f0f0; font: inherit;
  }
  .gs-start-button {
    height: 46px; padding: 0 28px; border: none; border-radius: 23px;
    background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 700; cursor: pointer;
  }
  .gs-start-button:disabled { opacity: 0.6; cursor: default; }
  /* The group's sessions as video cards. */
  .gs-recordings {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 22px 16px;
    margin: 0; padding: 0; list-style: none;
  }
  .gs-recordings a { display: flex; flex-direction: column; gap: 4px; color: #f0f0f0; text-decoration: none; }
  .gs-thumb {
    position: relative; display: block; aspect-ratio: 16 / 9; margin-bottom: 6px;
    border-radius: 12px; background: #161616; overflow: hidden;
  }
  .gs-thumb img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.2s; }
  .gs-recordings a:hover .gs-thumb img { transform: scale(1.04); }
  .gs-recordings a:hover strong { color: var(--accent); }
  .gs-recordings strong { line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .gs-rec-count {
    position: absolute; right: 8px; bottom: 8px; padding: 2px 8px; border-radius: 6px;
    background: rgba(0,0,0,0.75); color: #fff; font-size: 0.78rem; font-weight: 600;
  }
  .gs-rec-meta { color: #8a8a8a; font-size: 0.85rem; }
  .gs-card .gs-id-note { margin: 14px 0 0; font-size: 0.82rem; }
  .gs-id-note code { color: #e8e8e8; }
  .gs-requests { margin: 0; padding: 0; list-style: none; }
  .gs-requests li { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.05); }
  .gs-requests li:first-child { border-top: none; }
  .gs-requests span { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .gs-requests strong, .gs-requests small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gs-requests small { color: #8a8a8a; font-size: 0.78rem; }
  .gs-modal-backdrop {
    position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(0,0,0,0.7);
  }
  .gs-modal {
    width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 14px; padding: 24px; border-radius: 24px; background: #111113;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  .gs-modal h2 { margin: 0; font-size: 1.4rem; font-weight: 800; }
  .gs-modal p { margin: 0; color: #aaa; line-height: 1.5; }
  .gs-pages { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 10px; font-size: 0.85rem; }
  @media (max-width: 1080px) {
    .gs-columns { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 600px) {
    .gs-banner { flex-direction: column; align-items: flex-start; }
    .gs-banner h1 { font-size: 1.8rem; }
  }
`;

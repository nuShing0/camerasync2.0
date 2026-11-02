import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getSessions } from "../api/recordings.js";
import { createGroup, getGroups } from "../api/groups.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { JoinGroupForm } from "../components/JoinGroupForm.jsx";
import { TeamColorPicker } from "../components/TeamColorPicker.jsx";
import { useGroupTheme } from "../theme/GroupThemeContext.jsx";
import { groupTile } from "../theme/groupTheme.js";
import { DEFAULT_TEAM_COLOR } from "../theme/teamColors.js";

// Shells for the sections that don't have backing APIs yet. Each states what
// it will hold so the nav is honest about what's built vs. planned.

// One group on the Groups list: a card in its team color with its name,
// your role, and what's going on (live now, or its sessions and when the
// last one was). The whole card opens the group's page; drag to reorder.
function GroupTile({ group, isPrimary, dragging, dragHandlers, sessions }) {
  const navigate = useNavigate();
  const tile = groupTile(group);
  const { user } = useAuth();
  const role = Number(user?.id) === group.owner ? "Owner"
    : { admin: "Admin", member: "Member", viewer: "Viewer" }[group.role] ?? "Member";
  const live = sessions.find((session) => session.status === "active");
  const finished = sessions
    .filter((session) => session.status === "complete")
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));

  return (
    <button
      type="button"
      draggable
      {...dragHandlers}
      className={`group-card${dragging ? " group-card-dragging" : ""}`}
      style={tile ? { background: tile.fill, color: tile.ink } : undefined}
      onClick={() => navigate(`/groups/${encodeURIComponent(group.id)}`)}
    >
      <span className="group-card-top">
        <span className="group-card-role">{role}</span>
        {isPrimary && <span className="group-card-role">Primary</span>}
        <span className="group-card-grip" aria-hidden="true" title="Drag to reorder">⠿</span>
      </span>
      <span className="group-card-name">{group.name}</span>
      <span className="group-card-foot">
        {live ? (
          <span className="group-card-live"><span />Live · {live.name}</span>
        ) : (
          <span>
            {finished.length} {finished.length === 1 ? "session" : "sessions"}
            {finished[0] && ` · last ${new Date(finished[0].scheduledAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
          </span>
        )}
        <span className="group-card-chevron" aria-hidden="true">›</span>
      </span>
    </button>
  );
}

// A small centered window over a dimmed page for creating or joining a
// group. Closes on Esc, the X, or a click outside it.
function GroupModal({ title, onClose, children }) {
  const dialogRef = useRef(null);

  // Start typing straight away: focus the first field when it opens.
  useEffect(() => {
    dialogRef.current?.querySelector("input:not([type=checkbox]), select, textarea")?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="group-modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="group-modal" role="dialog" aria-modal="true" aria-label={title} ref={dialogRef}>
        <div className="group-modal-header">
          <h2>{title}</h2>
          <button type="button" className="group-modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function GroupsScreen() {
  const { activeGroup, refresh: refreshTheme } = useGroupTheme();
  const { updateProfile } = useAuth();
  const [openPanel, setOpenPanel] = useState(null);
  const [groups, setGroups] = useState([]);
  // Every session, to show each group's live one and how many it has had.
  const [sessions, setSessions] = useState([]);
  // The group being dragged to a new place in the list, by ID.
  const [draggingId, setDraggingId] = useState(null);
  const [orderError, setOrderError] = useState("");
  const [loading, setLoading] = useState(true);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState("");
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    primaryColor: DEFAULT_TEAM_COLOR,
  });

  useEffect(() => {
    getSessions().then(setSessions).catch(() => {});
    getGroups()
      .then(setGroups)
      .catch((err) => setCreateError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const closePanel = () => {
    setOpenPanel(null);
    setCreateError("");
  };

  const submitGroup = async (event) => {
    event.preventDefault();
    setCreateError("");
    setCreateSubmitting(true);

    try {
      const group = await createGroup(form);
      // A first group becomes the default, which themes the app.
      refreshTheme().catch(() => {});
      // Straight to the new group, asking to invite the team.
      navigate(`/groups/${encodeURIComponent(group.id)}?invite=1`);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreateSubmitting(false);
    }
  };

  // Joined (or already in): open the group.
  const joined = (group) => {
    refreshTheme().catch(() => {});
    navigate(`/groups/${encodeURIComponent(group.id)}`);
  };

  return (
    <div>
      <style>{groupsCss}</style>
      <div className="groups-header">
        <div>
          <h1>Groups</h1>
          {!loading && (
            <p>{groups.length} {groups.length === 1 ? "group" : "groups"} · drag to reorder</p>
          )}
        </div>
        <div className="group-tools">
          <button className="group-tool-button" type="button"
            onClick={() => setOpenPanel("join")}>
            Join group
          </button>
          <button className="group-tool-button group-tool-primary" type="button"
            onClick={() => setOpenPanel("create")}>
            + Create group
          </button>
        </div>
      </div>

      <div className="groups-grid">
        <section className="group-panel">
          {loading ? (
            <p className="group-empty">Loading groups...</p>
          ) : groups.length === 0 ? (
            <EmptyState title="No groups yet">
              Create your team's group, or use Join group with the invite your coach sent.
            </EmptyState>
          ) : (
            <div className={`group-list${draggingId ? " group-list-dragging" : ""}`}>
              {orderError && <p role="alert" className="group-error">{orderError}</p>}
              {groups.map((group) => (
                <GroupTile
                  key={group.id}
                  group={group}
                  dragging={draggingId === group.id}
                  dragHandlers={{
                    onDragStart: (event) => {
                      event.dataTransfer.effectAllowed = "move";
                      setDraggingId(group.id);
                    },
                    // Moves the dragged group to where it's hovering, so the
                    // list shows the new order before it's dropped.
                    onDragOver: (event) => {
                      event.preventDefault();
                      if (!draggingId || draggingId === group.id) return;
                      setGroups((current) => {
                        const from = current.findIndex((g) => g.id === draggingId);
                        const to = current.findIndex((g) => g.id === group.id);
                        const next = [...current];
                        next.splice(to, 0, next.splice(from, 1)[0]);
                        return next;
                      });
                    },
                    onDrop: (event) => event.preventDefault(),
                    onDragEnd: () => {
                      setDraggingId(null);
                      setOrderError("");
                      updateProfile({ groupOrder: groups.map((g) => g.id) })
                        .catch(() => setOrderError("Couldn't save the new order. Try again."));
                    },
                  }}
                  isPrimary={activeGroup?.id === group.id}
                  sessions={sessions.filter((session) => session.groupId === group.id)}
                />
              ))}
            </div>
          )}
        </section>

      </div>

      {openPanel === "create" && (
        <GroupModal title="Create a group" onClose={closePanel}>
          <form className="group-tool-content" onSubmit={submitGroup}>
            {createError && (
              <p className="group-error">{createError}</p>
            )}

            <label className="group-field">
              Name
              <input
                type="text"
                value={form.name}
                onChange={(event) =>
                  updateForm("name", event.target.value)
                }
                placeholder="Group name"
                required
              />
            </label>

            <div className="group-field">
              Team color
              <TeamColorPicker
                value={form.primaryColor}
                onChange={(hex) => updateForm("primaryColor", hex)}
              />
            </div>

            <div className="group-actions">
              <button
                className="group-button"
                type="button"
                onClick={() => setOpenPanel(null)}
              >
                Cancel
              </button>
              <button
                className="group-button group-button-primary"
                type="submit"
                disabled={createSubmitting}
              >
                {createSubmitting ? "Creating..." : "Create Group"}
              </button>
            </div>
          </form>
        </GroupModal>
      )}
      {openPanel === "join" && (
        <GroupModal title="Join a group" onClose={closePanel}>
          <JoinGroupForm onJoined={joined} />
        </GroupModal>
      )}
    </div>
  );
}

const groupsCss = `
  .groups-header {
    display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between;
    gap: 16px; max-width: 1480px; margin: 0 auto;
  }
  .groups-header h1 { margin: 0; font-size: 2.2rem; font-weight: 800; letter-spacing: -0.5px; }
  .groups-header p { margin: 4px 0 0; color: #8a8a8a; font-size: 0.95rem; }
  .groups-grid { max-width: 1480px; margin: 24px auto 0; }
  .group-panel h2 { margin: 0 0 18px; font-size: 1.15rem; }
  .group-tools { display: flex; gap: 10px; }
  .group-tool-button {
    height: 42px; padding: 0 20px; border: none; border-radius: 21px;
    background: #1b1b1e; color: #f0f0f0; font: inherit; font-size: 0.9rem; font-weight: 700; cursor: pointer;
  }
  .group-tool-button:hover { background: #262626; }
  .group-tool-primary { background: var(--accent); color: var(--accent-ink); }
  .group-tool-primary:hover { background: var(--accent-hover); }
  .group-modal-backdrop {
    position: fixed; inset: 0; z-index: 50;
    display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(0, 0, 0, 0.65);
  }
  .group-modal {
    box-sizing: border-box; width: min(440px, 100%); max-height: calc(100vh - 32px);
    overflow: auto; padding: 18px 22px 22px; border-radius: 16px;
    background: #1a1a1a; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  }
  .group-modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .group-modal-header h2 { margin: 0; font-size: 1.2rem; }
  .group-modal-close {
    display: flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; padding: 0; border: none; border-radius: 8px;
    background: transparent; color: #aaa; cursor: pointer;
  }
  .group-modal-close:hover { background: #262626; color: #fff; }
  .group-tool-content {
    margin-top: 10px;
  }
  .group-empty {
    margin: 0;
    padding: 28px 16px;
    border: 1px dashed #3a3a3a;
    border-radius: 8px;
    color: #888;
    text-align: center;
  }
  /* The groups as big cards in their team colors. */
  .group-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .group-card {
    display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-height: 180px;
    box-sizing: border-box; padding: 18px 20px; border: none; border-radius: 22px;
    background: #1b1b1e; color: #f0f0f0; font: inherit; text-align: left; cursor: pointer;
    transition: transform 0.12s, filter 0.12s;
  }
  .group-card:hover { filter: brightness(1.06); transform: translateY(-2px); }
  .group-card-top { display: flex; align-items: center; gap: 6px; margin-bottom: auto; }
  .group-card-role {
    padding: 3px 10px; border-radius: 999px; background: rgba(0,0,0,0.18);
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.3px;
  }
  .group-card-grip { margin-left: auto; opacity: 0.5; font-size: 1.1rem; line-height: 1; cursor: grab; }
  .group-card:hover .group-card-grip { opacity: 0.9; }
  .group-card-name { margin-top: 18px; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.3px; line-height: 1.15; overflow-wrap: anywhere; }
  .group-card-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(127,127,127,0.3);
    font-size: 0.85rem; font-weight: 600;
  }
  .group-card-live { display: inline-flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-card-live span { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #f0432e; box-shadow: 0 0 0 2px rgba(255,255,255,0.7); }
  .group-card-chevron { font-size: 1.5rem; line-height: 1; opacity: 0.75; }
  /* Where the dragged group will land: a faded copy with a dashed outline,
     while the browser carries the card under the pointer. */
  .group-card-dragging { opacity: 0.35; outline: 2px dashed var(--accent); outline-offset: 3px; transform: scale(0.97); }
  .group-list-dragging, .group-list-dragging * { cursor: grabbing !important; }
  .group-list-dragging .group-card:not(.group-card-dragging) { transition: transform 0.15s; }
  .group-error {
    margin: 0 0 14px;
    padding: 9px 11px;
    border: 1px solid #5a2a2a;
    border-radius: 7px;
    background: #2a1a1a;
    color: #ff8a80;
    font-size: 0.85rem;
  }
  .group-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-bottom: 15px;
    color: #ddd;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .group-field input[type="text"],
  .group-field input[type="password"] {
    box-sizing: border-box;
    width: 100%;
    padding: 10px 11px;
    border: 1px solid #3a3a3a;
    border-radius: 7px;
    outline: none;
    background: #262626;
    color: #f0f0f0;
    font: inherit;
  }
  .group-field input:focus {
    border-color: var(--accent);
  }
  .group-field input:disabled {
    border-color: #303030;
    background: #202020;
    color: #666;
    cursor: not-allowed;
    opacity: 0.7;
  }
  .group-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 6px;
  }
  .group-button {
    padding: 9px 14px;
    border: 1px solid #3a3a3a;
    border-radius: 7px;
    background: #262626;
    color: #f0f0f0;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .group-button:hover {
    background: #303030;
  }
  .group-button-primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
  }
  .group-button-primary:hover {
    background: var(--accent-hover);
  }
  .group-button:disabled {
    cursor: default;
    opacity: 0.55;
  }
  @media (max-width: 480px) {
    .group-privacy-row {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .group-visibility {
      margin-bottom: 8px;
    }
  }
`;

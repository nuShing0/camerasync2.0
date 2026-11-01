import { useNavigate } from "react-router-dom";

import { notificationLink, timeAgo } from "../api/notifications.js";

// One line per notification: the group's color dot, what happened, and how
// long ago. Unread ones are brighter. Used by Home and the full list.
export function NotificationList({ notifications }) {
  const navigate = useNavigate();
  return (
    <ul className="notif-list">
      <style>{css}</style>
      {notifications.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            className={n.unread ? "notif notif-unread" : "notif"}
            onClick={() => navigate(notificationLink(n))}
          >
            <span
              className="notif-dot"
              style={{ background: n.group.primaryColor }}
              title={n.group.name}
              aria-hidden="true"
            />
            <span className="notif-text">
              <NotificationText notification={n} />
              {n.type === "comment" && <span className="notif-quote">"{n.comment.body}"</span>}
            </span>
            <span className="notif-time">{timeAgo(n.at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NotificationText({ notification: n }) {
  const actor = <strong>{n.actor.name}</strong>;
  if (n.type === "comment") {
    return (
      <span>
        {actor} commented on <strong>{n.session.name}</strong>
      </span>
    );
  }
  if (n.type === "request") {
    return (
      <span>
        {actor} asked to join <strong>{n.group.name}</strong>
      </span>
    );
  }
  if (n.type === "join") {
    return (
      <span>
        {actor} joined <strong>{n.group.name}</strong>
      </span>
    );
  }
  return (
    <span>
      {actor} started <strong>{n.session.name}</strong>
      {n.session.status === "active" && <span className="notif-live"> · Live now</span>}
    </span>
  );
}

const css = `
  .notif-list { margin: 0; padding: 0; list-style: none; }
  .notif-list li + li { border-top: 1px solid #242424; }
  .notif {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    align-items: start;
    gap: 12px;
    width: 100%;
    padding: 11px 6px;
    border: none;
    border-radius: 10px;
    background: none;
    color: #a0a0a0;
    font: inherit;
    font-size: 0.9rem;
    text-align: left;
    cursor: pointer;
  }
  .notif:hover { background: #1e1e1e; }
  .notif strong { font-weight: 600; }
  .notif-unread { color: #f0f0f0; }
  .notif-unread strong { font-weight: 700; }
  .notif-dot { width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; }
  .notif-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; line-height: 1.4; }
  .notif-quote {
    overflow: hidden;
    color: #8a8a8a;
    font-size: 0.82rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notif-live { color: var(--accent); font-weight: 600; }
  .notif-time { color: #7a7a7a; font-size: 0.8rem; white-space: nowrap; }
`;

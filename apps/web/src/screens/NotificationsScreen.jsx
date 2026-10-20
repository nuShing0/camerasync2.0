import { useEffect, useState } from "react";

import { getNotifications, markNotificationsSeen } from "../api/notifications.js";
import { NotificationList } from "../components/NotificationList.jsx";

const LIMIT = 50;

/// Every notification from the last 30 days, newest first. Opening the page
/// marks them read; the ones that were new stay highlighted while it's open.
export function NotificationsScreen() {
  const [notifications, setNotifications] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getNotifications(LIMIT)
      .then((data) => {
        setNotifications(data.notifications);
        if (data.unreadCount > 0) markNotificationsSeen().catch(() => {});
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="nt-page">
      <style>{css}</style>
      <h1>Notifications</h1>
      <p className="nt-sub">Comments, new members and practices from your groups in the last 30 days.</p>
      <section className="nt-card">
        {error ? (
          <p className="nt-empty">{error}</p>
        ) : notifications === null ? (
          <p className="nt-empty">Loading…</p>
        ) : notifications.length === 0 ? (
          <p className="nt-empty">Nothing yet.</p>
        ) : (
          <NotificationList notifications={notifications} />
        )}
      </section>
    </div>
  );
}

const css = `
  .nt-page { max-width: 720px; display: flex; flex-direction: column; gap: 12px; }
  .nt-page h1 { margin: 0; font-size: 1.8rem; }
  .nt-sub { margin: 0 0 8px; color: #a0a0a0; }
  .nt-card { padding: 10px 14px; border-radius: 14px; background: var(--card); }
  .nt-empty { margin: 0; padding: 28px 8px; color: #8a8a8a; text-align: center; }
`;

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

// loads the newest notifications: comments, joins and practices starting in
// the user's groups. Each one says whether it came after the user last looked.
export async function getNotifications(limit = 20) {
  const response = await fetch(`${SERVER_URL}/api/notifications?limit=${limit}`, {
    credentials: "include",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

// marks everything up to now as read
export async function markNotificationsSeen() {
  await fetch(`${SERVER_URL}/api/notifications/seen`, {
    method: "POST",
    credentials: "include",
  });
}

/// "just now", "5m", "3h", "2d", then a short date.
export function timeAgo(at, now = new Date()) {
  const seconds = Math.max(0, (now - new Date(at)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/// Where tapping a notification goes: the recording for a comment, the group
/// for a join, and for a practice the Record page while it's live (to join
/// it) or its recording once it's over.
export function notificationLink(notification) {
  const { type, session, group } = notification;
  if (type === "join" || type === "request") return `/groups/${encodeURIComponent(group.id)}`;
  if (type === "session" && session.status === "active") return "/record";
  return `/watch/${session.id}`;
}

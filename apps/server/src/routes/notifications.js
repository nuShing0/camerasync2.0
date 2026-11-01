import { Router } from "express";

import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const notificationsRouter = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const WINDOW_DAYS = 30;

// The feed is read straight from what already happened in the user's groups
// rather than written to a table of its own: a comment on a recording
// (session_notes), someone joining (group_members.joined_at), someone asking
// to join (group_join_requests, for the group's admins only, while it waits)
// and a practice going live (its first recording_session_members row, which
// is whoever started it). Only other people's actions, from the user's own join onward,
// over the last 30 days. Deleting a comment drops it from the feed too.
const FEED_SQL = `
  WITH mine AS (
    SELECT gm.group_id, gm.joined_at, gm.role
      FROM group_members gm
     WHERE gm.user_id = $1
  ),
  events AS (
    SELECT 'comment' AS type,
           'comment-' || n.note_id AS id,
           n.created_at AS at,
           n.user_id AS actor_id,
           rs.group_id,
           rs.id AS session_id,
           rs.name AS session_name,
           rs.status AS session_status,
           n.body AS body,
           n.video_time_ms
      FROM session_notes n
      JOIN recording_sessions rs ON rs.id = n.session_id
      JOIN mine ON mine.group_id = rs.group_id
     WHERE n.user_id <> $1
       AND n.created_at >= mine.joined_at

    UNION ALL

    SELECT 'join', 'join-' || gm.group_id || '-' || gm.user_id,
           gm.joined_at, gm.user_id, gm.group_id,
           NULL, NULL, NULL, NULL, NULL
      FROM group_members gm
      JOIN mine ON mine.group_id = gm.group_id
     WHERE gm.user_id <> $1
       AND gm.joined_at > mine.joined_at

    UNION ALL

    SELECT 'request', 'request-' || r.group_id || '-' || r.user_id,
           r.requested_at, r.user_id, r.group_id,
           NULL, NULL, NULL, NULL, NULL
      FROM group_join_requests r
      JOIN mine ON mine.group_id = r.group_id
     WHERE mine.role = 'admin'

    UNION ALL

    SELECT 'session', 'session-' || rs.id,
           first.joined_at, first.user_id, rs.group_id,
           rs.id, rs.name, rs.status, NULL, NULL
      FROM recording_sessions rs
      JOIN mine ON mine.group_id = rs.group_id
      JOIN LATERAL (
        SELECT rsm.user_id, rsm.joined_at
          FROM recording_session_members rsm
         WHERE rsm.session_id = rs.id
         ORDER BY rsm.joined_at, rsm.user_id
         LIMIT 1
      ) first ON TRUE
     WHERE rs.status <> 'cancelled'
       AND first.user_id <> $1
       AND first.joined_at >= mine.joined_at
  )
  SELECT e.*, u.display_name AS actor_name, g.name AS group_name,
         g.primary_color
    FROM events e
    JOIN users u ON u.user_id = e.actor_id
    JOIN groups g ON g.group_id = e.group_id
   WHERE e.at > NOW() - make_interval(days => ${WINDOW_DAYS})
     AND e.type = ANY($3::text[])
   ORDER BY e.at DESC, e.id
   LIMIT $2
`;

function publicNotification(row, seenAt) {
  const notification = {
    id: row.id,
    type: row.type,
    at: row.at,
    unread: !seenAt || row.at > seenAt,
    actor: { id: Number(row.actor_id), name: row.actor_name || "Someone" },
    group: {
      id: row.group_id,
      name: row.group_name,
      primaryColor: row.primary_color,
    },
  };
  if (row.session_id) {
    notification.session = {
      id: row.session_id,
      name: row.session_name,
      status: row.session_status,
    };
  }
  if (row.type === "comment") {
    notification.comment = {
      body: row.body,
      videoTimeMs: Number(row.video_time_ms ?? 0),
    };
  }
  return notification;
}

// The kinds the user's category switches in Settings let through. They
// decide what shows in the feed; the separate push switch only decides
// whether the phone also gets an alert.
const TYPE_OF_KIND = { comments: "comment", joins: "join", sessions: "session" };

function shownTypes(prefs) {
  const types = Object.entries(TYPE_OF_KIND)
    .filter(([kind]) => prefs?.[kind] !== false)
    .map(([, type]) => type);
  // Requests to join go with the joins switch.
  return types.includes("join") ? [...types, "request"] : types;
}

async function seenAtFor(userId) {
  const { rows } = await pool.query(
    "SELECT settings::jsonb ->> 'notificationsSeenAt' AS seen_at FROM users WHERE user_id = $1",
    [userId]
  );
  const value = rows[0]?.seen_at;
  return value ? new Date(value) : null;
}

// newest first, each marked unread if it came after the user last looked
notificationsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const types = shownTypes(req.user.notificationPrefs);
    const [seenAt, { rows }] = await Promise.all([
      seenAtFor(req.user.id),
      types.length
        ? pool.query(FEED_SQL, [req.user.id, limit, types])
        : { rows: [] },
    ]);
    const notifications = rows.map((row) => publicNotification(row, seenAt));
    res.json({
      notifications,
      unreadCount: notifications.filter((n) => n.unread).length,
    });
  } catch (err) {
    next(err);
  }
});

// everything up to now counts as seen
notificationsRouter.post("/seen", requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users
          SET settings = (COALESCE(settings::jsonb, '{}'::jsonb)
                || jsonb_build_object('notificationsSeenAt', NOW()))::json
        WHERE user_id = $1`,
      [req.user.id]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

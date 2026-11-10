// The download audit (web: screens/DownloadAuditScreen.jsx): who downloaded
// each recording, for the groups you own or administer. Built on
// download_logs, which the session download (GET
// /api/recordings/sessions/:id/download) fills through
// recordings/downloadLog.js. Each recording in a session is a "take".
import { Router } from "express";

import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { atLeast, getGroupRole } from "../middleware/groupRole.js";

export const downloadAuditRouter = Router();
downloadAuditRouter.use(requireAuth);

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 50;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Wraps a handler: a thrown httpError becomes { error } with its status,
// anything else goes to Express's error handling.
const route = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

// Groups the user owns or is an admin of, by name.
async function adminGroups(userId) {
  const { rows } = await pool.query(
    `SELECT g.group_id AS id, g.name
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.group_id AND gm.user_id = $1
      WHERE gm.role = 'admin' OR g.owner_id = $1
      ORDER BY LOWER(g.name), g.group_id`,
    [userId]
  );
  return rows;
}

// One group, if the user owns or administers it; otherwise a 403 (or a 404
// for a group that doesn't exist).
async function auditableGroup(groupId, userId) {
  const { rows } = await pool.query(
    "SELECT group_id AS id, name FROM groups WHERE group_id = $1",
    [groupId]
  );
  if (rows.length === 0) throw httpError(404, "Group not found.");
  if (!atLeast(await getGroupRole(groupId, userId), "admin")) {
    throw httpError(403, "Only the group's owner and admins can see its download audit.");
  }
  return rows[0];
}

const isDay = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/// from/to are whole UTC days (YYYY-MM-DD), both included. The default is the
/// last 30 days, as on the screen.
export function parseRange(query) {
  const to = isDay(query.to) ? query.to : new Date().toISOString().slice(0, 10);
  const from = isDay(query.from)
    ? query.from
    : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
  if (from > to) throw httpError(400, "The start date must not be after the end date.");
  return {
    from,
    to,
    start: `${from}T00:00:00Z`,
    end: new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString(),
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
}

// Every download with what the audit shows about it. Rows logged before
// recording numbers were stored have no take, and show as "Other files".
const EVENTS = `(
  SELECT d.id, d.downloaded_at AS at, COALESCE(d.file_type, 'video') AS file_type,
         d.session_id, rs.name AS session_name, rs.scheduled_at, rs.group_id,
         d.recording_number,
         CASE WHEN d.recording_number IS NULL THEN NULL
              ELSE 'Recording ' || LPAD(d.recording_number::text, 3, '0') END AS take_name,
         d.user_id, COALESCE(NULLIF(u.display_name, ''), u.email) AS user_name, u.email
    FROM download_logs d
    JOIN recording_sessions rs ON rs.id = d.session_id
    LEFT JOIN users u ON u.user_id = d.user_id
) e`;

// The WHERE clause every query shares: the groups, the date range, and the
// optional user and search filters. Returns SQL and its parameters.
function eventFilter(groupIds, range, { userId, q } = {}) {
  const params = [groupIds, range.start, range.end];
  let sql = "e.group_id = ANY($1::text[]) AND e.at >= $2 AND e.at < $3";
  if (userId) {
    params.push(String(userId));
    sql += ` AND e.user_id::text = $${params.length}`;
  }
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    const n = params.length;
    sql += ` AND (e.session_name ILIKE $${n} OR e.session_id ILIKE $${n}
                  OR e.take_name ILIKE $${n} OR e.user_name ILIKE $${n} OR e.email ILIKE $${n})`;
  }
  return { sql, params };
}

const filtersFrom = (query) => ({
  userId: query.userId ? String(query.userId) : "",
  q: String(query.q ?? "").trim().slice(0, 100),
});

// A take's id as shown beside its name: the session code and its number.
const takeId = (sessionId, number) => (number == null ? null : `${sessionId}-${number}`);

// GET /teams?from&to: every group you administer, with counts for the range.
downloadAuditRouter.get("/teams", route(async (req, res) => {
  const range = parseRange(req.query);
  const groups = await adminGroups(req.user.id);
  const f = eventFilter(groups.map((g) => g.id), range);

  const [counts, latest, totals] = await Promise.all([
    pool.query(
      `SELECT e.group_id,
              COUNT(DISTINCT e.session_id)::int AS sessions,
              COUNT(DISTINCT e.session_id || ':' || e.recording_number)::int AS takes,
              COUNT(*)::int AS downloads
         FROM ${EVENTS} WHERE ${f.sql} GROUP BY e.group_id`, f.params),
    pool.query(
      `SELECT DISTINCT ON (e.group_id) e.group_id, e.at, e.user_id, e.user_name
         FROM ${EVENTS} WHERE ${f.sql} ORDER BY e.group_id, e.at DESC, e.id DESC`, f.params),
    pool.query(
      `SELECT COUNT(*)::int AS downloads, COUNT(DISTINCT e.user_id)::int AS users
         FROM ${EVENTS} WHERE ${f.sql}`, f.params),
  ]);

  const countsById = new Map(counts.rows.map((r) => [r.group_id, r]));
  const latestById = new Map(latest.rows.map((r) => [r.group_id, r]));
  res.json({
    range: { from: range.from, to: range.to },
    totals: { teams: groups.length, ...totals.rows[0] },
    teams: groups.map((group) => {
      const c = countsById.get(group.id);
      const l = latestById.get(group.id);
      return {
        id: group.id,
        name: group.name,
        sessions: c?.sessions ?? 0,
        takes: c?.takes ?? 0,
        downloads: c?.downloads ?? 0,
        lastDownloadAt: l?.at ?? null,
        // null for a deleted account; the screen shows "Deleted user".
        lastDownloadedBy: l?.user_name ?? null,
      };
    }),
  });
}));

// Builds a page of sessions from its downloads (newest first): takes in the
// order of their newest download.
function groupSessions(pageSessions, events) {
  const sessions = new Map(pageSessions.map((s) => [s.id, {
    id: s.id,
    name: s.name,
    scheduledAt: s.scheduled_at,
    downloadCount: 0,
    takes: [],
    byTake: new Map(),
  }]));
  for (const e of events) {
    const session = sessions.get(e.session_id);
    if (!session) continue;
    const key = e.recording_number ?? "other";
    let take = session.byTake.get(key);
    if (!take) {
      take = {
        id: takeId(e.session_id, e.recording_number),
        name: e.take_name ?? "Other files",
        downloads: [],
      };
      session.byTake.set(key, take);
      session.takes.push(take);
    }
    take.downloads.push({
      id: String(e.id),
      at: e.at,
      fileType: e.file_type,
      user: { id: e.user_id == null ? null : String(e.user_id), name: e.user_name ?? "Deleted user" },
    });
    session.downloadCount += 1;
  }
  return [...sessions.values()].map(({ byTake, ...session }) => ({
    ...session,
    takeCount: session.takes.length,
  }));
}

// GET /teams/:groupId?from&to&userId&q&page&pageSize: one group's totals, the
// users who downloaded in the range, and a page of sessions.
downloadAuditRouter.get("/teams/:groupId", route(async (req, res) => {
  const group = await auditableGroup(req.params.groupId, req.user.id);
  const range = parseRange(req.query);
  const pageSize = clampInt(req.query.pageSize, 5, 1, MAX_PAGE_SIZE);
  const all = eventFilter([group.id], range);
  const f = eventFilter([group.id], range, filtersFrom(req.query));

  const [users, totals] = await Promise.all([
    // The user picker lists everyone in the range, whatever else is filtered.
    pool.query(
      `SELECT e.user_id::text AS id, MAX(e.user_name) AS name
         FROM ${EVENTS} WHERE ${all.sql} AND e.user_id IS NOT NULL
        GROUP BY e.user_id ORDER BY LOWER(MAX(e.user_name))`, all.params),
    pool.query(
      `SELECT COUNT(DISTINCT e.session_id)::int AS sessions,
              COUNT(DISTINCT e.session_id || ':' || e.recording_number)::int AS takes,
              COUNT(*)::int AS downloads
         FROM ${EVENTS} WHERE ${f.sql}`, f.params),
  ]);

  const pageCount = Math.max(1, Math.ceil(totals.rows[0].sessions / pageSize));
  const page = clampInt(req.query.page, 1, 1, pageCount);
  // Sessions in the order of their newest download.
  const pageSessions = await pool.query(
    `SELECT e.session_id AS id, MAX(e.session_name) AS name,
            MAX(e.scheduled_at) AS scheduled_at, MAX(e.at) AS last_at
       FROM ${EVENTS} WHERE ${f.sql}
      GROUP BY e.session_id
      ORDER BY last_at DESC, e.session_id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, f.params);

  let events = [];
  if (pageSessions.rows.length > 0) {
    const result = await pool.query(
      `SELECT e.* FROM ${EVENTS}
        WHERE ${f.sql} AND e.session_id = ANY($${f.params.length + 1}::text[])
        ORDER BY e.at DESC, e.id DESC`,
      [...f.params, pageSessions.rows.map((s) => s.id)]
    );
    events = result.rows;
  }

  res.json({
    group,
    users: users.rows,
    totals: totals.rows[0],
    range: { from: range.from, to: range.to },
    page,
    pageCount,
    sessions: groupSessions(pageSessions.rows, events),
  });
}));

// --- CSV export -------------------------------------------------------------

const CSV_HEADER = [
  "Downloaded at (UTC)", "Group", "Session code", "Session", "Session scheduled (UTC)",
  "Take", "User", "Email", "File type", "IP address",
];

/// One CSV cell: quoted when needed, and with a leading ' on anything a
/// spreadsheet would run as a formula (a session named "=HYPERLINK(...)").
export function csvCell(value) {
  let text = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const slug = (text) =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "group";

async function sendCsv(res, groups, range, filters, label) {
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const f = eventFilter([...names.keys()], range, filters);
  const { rows } = await pool.query(
    `SELECT e.*, d.ip_address FROM ${EVENTS}
       JOIN download_logs d ON d.id = e.id
      WHERE ${f.sql} ORDER BY e.at DESC, e.id DESC`, f.params);

  const lines = [
    CSV_HEADER,
    ...rows.map((e) => [
      e.at, names.get(e.group_id), e.session_id, e.session_name, e.scheduled_at,
      e.take_name ?? "Other files", e.user_name ?? "Deleted user", e.email, e.file_type, e.ip_address,
    ]),
  ].map((row) => row.map(csvCell).join(","));

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="download-audit-${label}-${range.from}-to-${range.to}.csv"`
  );
  // The byte-order mark makes Excel read the file as UTF-8.
  res.send(`﻿${lines.join("\r\n")}\r\n`);
}

// GET /export.csv?from&to: every group you administer.
downloadAuditRouter.get("/export.csv", route(async (req, res) => {
  const range = parseRange(req.query);
  const groups = await adminGroups(req.user.id);
  if (groups.length === 0) throw httpError(403, "You don't own or administer any groups.");
  await sendCsv(res, groups, range, {}, "all-groups");
}));

// GET /teams/:groupId/export.csv?from&to&userId&q: one group, with the same
// filters as its page.
downloadAuditRouter.get("/teams/:groupId/export.csv", route(async (req, res) => {
  const group = await auditableGroup(req.params.groupId, req.user.id);
  const range = parseRange(req.query);
  await sendCsv(res, [group], range, filtersFrom(req.query), slug(group.name));
}));

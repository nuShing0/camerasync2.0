// Recording session REST routes.
//
// Creates and manages recording sessions, delegating the live websocket
// channel work to ../sockets/websocket.js. Mounted at /api/recordings
// (see ../index.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { storage } from "../storage/index.js";
import { fileUrl } from "../storage/cdn.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  ROLE_RANK,
  atLeast,
  getSessionRole,
  sessionVisibleSql,
} from "../middleware/groupRole.js";
import {
  getRecordingSession,
  closeSessionSocket,
  leaveSessionRoom,
} from "../sockets/websocket.js";
import { deleteRecordingFiles, storedFileIds } from "./file.js";
import { ensureRecordingNumber, isRecordingDeleted } from "../recordings/numbering.js";
import { START_OFFSET_UPSERT_SQL, startClock, startOffsetMs } from "../recordings/startOffset.js";
import { STAGES, progressFor, reportProgress } from "../recordings/uploadProgress.js";
import { MAX_PER_GRID, ensureExports, openExport } from "../recordings/syncedExports.js";

export const recordingsRouter = Router();
const SESSION_ID_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const SESSION_ID_PATTERN = /^[a-z0-9]{6}$/;

// makes a random six character session id
function createSessionId() {
  return Array.from(
    { length: 6 },
    () => SESSION_ID_CHARACTERS[crypto.randomInt(SESSION_ID_CHARACTERS.length)]
  ).join("");
}

// shapes session rows for the frontend
function publicSession(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    createdBy: Number(row.created_by),
    status: row.status,
    memberCount: row.member_count == null ? null : Number(row.member_count),
    // How many takes the session has.
    recordingCount: row.recording_count == null ? null : Number(row.recording_count),
    activeMemberCount: Number(row.active_member_count ?? 0),
    // Who's in the session now, earliest first, for Home's live card.
    activeMemberNames: row.active_member_names ?? [],
    isJoined: Boolean(row.is_joined),
    // A still from the session's first take, for the session lists.
    thumbnailUrl: row.thumbnail_file_id ? fileUrl(row.thumbnail_file_id) : null,
  };
}

// lists sessions visible to the current user's groups
recordingsRouter.get("/sessions", requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE recording_sessions rs
          SET status = 'active'
        WHERE rs.status = 'scheduled'
          AND EXISTS (
            SELECT 1
              FROM recording_session_members rsm
             WHERE rsm.session_id = rs.id
          )`
    );

    await pool.query(
      `UPDATE recording_sessions rs
          SET status = 'complete'
        WHERE rs.status = 'scheduled'
          AND rs.scheduled_at + INTERVAL '15 minutes' < NOW()
          AND NOT EXISTS (
            SELECT 1
              FROM recording_session_members rsm
             WHERE rsm.session_id = rs.id
          )`
    );

    const { rows } = await pool.query(
      `SELECT rs.id, rs.group_id, rs.name, rs.scheduled_at,
              rs.created_at, rs.created_by, rs.status,
              CASE WHEN rs.counts_tracked THEN
                (SELECT COUNT(*) FROM recording_session_participants p
                  WHERE p.session_id = rs.id) END AS member_count,
              CASE WHEN rs.counts_tracked THEN
                (SELECT COUNT(DISTINCT v.started_at_ms) FROM recording_session_videos v
                  WHERE v.session_id = rs.id) END AS recording_count,
              (
                SELECT COUNT(*)
                  FROM recording_session_members rsm
                 WHERE rsm.session_id = rs.id
              ) AS active_member_count,
              (
                SELECT ARRAY_AGG(COALESCE(u.display_name, SPLIT_PART(u.email, '@', 1))
                                 ORDER BY rsm.joined_at)
                  FROM recording_session_members rsm
                  JOIN users u ON u.user_id = rsm.user_id
                 WHERE rsm.session_id = rs.id
              ) AS active_member_names,
              EXISTS (
                SELECT 1
                  FROM recording_session_members rsm
                 WHERE rsm.session_id = rs.id
                   AND rsm.user_id = $1
              ) AS is_joined,
              (SELECT v.thumbnail_file_id FROM recording_session_videos v
                WHERE v.session_id = rs.id AND v.thumbnail_file_id IS NOT NULL
                ORDER BY v.started_at_ms, v.user_id LIMIT 1) AS thumbnail_file_id
        FROM recording_sessions rs
        WHERE ${sessionVisibleSql("rs", "$1")}
        ORDER BY
          rs.status <> 'active',
          rs.scheduled_at < NOW(),
          CASE
            WHEN rs.scheduled_at >= NOW() THEN rs.scheduled_at
          END,
          CASE
            WHEN rs.scheduled_at < NOW() THEN rs.scheduled_at
          END DESC,
          rs.created_at`,
      [req.user.id]
    );

    res.json({ sessions: rows.map(publicSession) });
  } catch (err) {
    next(err);
  }
});

// Admins and the group owner can delete a completed session and its videos.
recordingsRouter.delete("/sessions/:id", requireAuth, async (req, res, next) => {
  let client;
  try {
    const role = await getSessionRole(req.params.id, req.user.id);
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT status FROM recording_sessions WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found." });
    }
    if (!atLeast(role, "admin")) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only group admins can delete sessions." });
    }
    if (rows[0].status !== "complete") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "End this session before deleting it." });
    }
    const { rows: videos } = await client.query(
      `SELECT file_id, preview_file_id, thumbnail_file_id, scrub FROM recording_session_videos
        WHERE session_id = $1 FOR UPDATE`,
      [req.params.id]
    );
    await deleteRecordingFiles(storedFileIds(videos));
    await client.query("DELETE FROM recording_sessions WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    next(err);
  } finally {
    client?.release();
  }
});

// Admins and the group owner can delete one recording (every angle of it,
// with its comments), live session or not, unless it's being recorded now.
// Its number stays taken and marked deleted, so the other recordings keep
// theirs and a phone still uploading it is turned away.
recordingsRouter.delete("/sessions/:id/recordings/:startedAt", requireAuth, async (req, res, next) => {
  const startedAt = Number(req.params.startedAt);
  if (!SESSION_ID_PATTERN.test(req.params.id) || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
    return res.status(400).json({ error: "Invalid recording." });
  }
  let client;
  try {
    const role = await getSessionRole(req.params.id, req.user.id);
    if (!atLeast(role, "admin")) {
      return res.status(403).json({ error: "Only group admins can delete recordings." });
    }
    const active = await getRecordingSession(req.params.id).catch(() => null);
    if (Number(active?.recording?.startAtEpochMs) === startedAt) {
      return res.status(409).json({ error: "Stop this recording before deleting it." });
    }
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows: videos } = await client.query(
      `SELECT file_id, preview_file_id, thumbnail_file_id, scrub FROM recording_session_videos
        WHERE session_id = $1 AND started_at_ms = $2 FOR UPDATE`,
      [req.params.id, startedAt]
    );
    const { rowCount: known } = await client.query(
      `UPDATE session_recordings SET deleted_at = NOW()
        WHERE session_id = $1 AND started_at_ms = $2`,
      [req.params.id, startedAt]
    );
    if (videos.length === 0 && known === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Recording not found." });
    }
    await client.query(
      "DELETE FROM recording_session_videos WHERE session_id = $1 AND started_at_ms = $2",
      [req.params.id, startedAt]
    );
    await client.query(
      "DELETE FROM session_notes WHERE session_id = $1 AND started_at_ms = $2",
      [req.params.id, startedAt]
    );
    await client.query("COMMIT");
    // The rows are gone first, so nothing points at a missing file.
    await deleteRecordingFiles(storedFileIds(videos)).catch((err) =>
      console.error("Could not delete a recording's files:", err));
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// Load the session's recordings for members of its group.
recordingsRouter.get("/sessions/:id/videos", requireAuth, async (req, res, next) => {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT rs.id, rs.name FROM recording_sessions rs
       WHERE rs.id = $1 AND ${sessionVisibleSql("rs", "$2")}`,
      [req.params.id, req.user.id]
    );
    if (sessions.length === 0) {
      return res.status(404).json({ error: "Session not found." });
    }
    const { rows } = await pool.query(
      `SELECT v.started_at_ms, v.user_id, v.file_id, v.preview_file_id, v.scrub, v.start_offset_ms,
              u.display_name, sr.recording_number
       FROM recording_session_videos v JOIN users u ON u.user_id = v.user_id
       LEFT JOIN session_recordings sr
         ON sr.session_id = v.session_id AND sr.started_at_ms = v.started_at_ms
       WHERE v.session_id = $1 ORDER BY v.started_at_ms, v.user_id`,
      [req.params.id]
    );
    // Each recording carries its persisted number; clients build the display
    // name "YY-MM-DD HH:MM:SS - Recording 001" from startedAt and number in
    // the viewer's local time.
    const recordings = [];
    for (const row of rows) {
      const startedAt = Number(row.started_at_ms);
      let recording = recordings[recordings.length - 1];
      if (!recording || recording.startedAt !== startedAt) {
        recording = {
          startedAt,
          number: row.recording_number == null
            ? recordings.length + 1
            : Number(row.recording_number),
          videos: [],
        };
        recordings.push(recording);
      }
      recording.videos.push({
        userId: Number(row.user_id),
        name: row.display_name || "Unnamed member",
        // The full video; until it arrives, the phone's preview stands in
        // (previewOnly), so a take can be watched while it uploads.
        url: row.file_id
          ? fileUrl(row.file_id)
          : row.preview_file_id ? fileUrl(row.preview_file_id) : null,
        previewOnly: !row.file_id && Boolean(row.preview_file_id),
        // A smaller copy for when the angle is shown small; null until it's
        // made (see ../recordings/previews.js).
        previewUrl: row.preview_file_id ? fileUrl(row.preview_file_id) : null,
        // Stills shown while the seek bar is dragged; null until they're made
        // (see ../recordings/scrubFrames.js).
        scrub: row.file_id && row.scrub
          ? { ...row.scrub, sheets: row.scrub.sheets.map((id) => fileUrl(id)) }
          : null,
        // How much later this camera really started than the take's
        // startedAt, which players shift the angle by: from the device's
        // first frame where it can say, or the old sync beep for older takes.
        // Null for uploads from before it was tracked (treated as 0).
        startOffsetMs: row.start_offset_ms == null ? null : Number(row.start_offset_ms),
        // How far along its upload is, while the full video isn't in yet.
        upload: row.file_id ? null : progressFor(req.params.id, startedAt, Number(row.user_id)),
      });
    }
    // Admins (and the owner) can delete a recording (see below).
    const canDelete = atLeast(await getSessionRole(req.params.id, req.user.id), "admin");
    res.json({ session: sessions[0], recordings, canDelete });
  } catch (err) {
    next(err);
  }
});

// The uploading device's progress on one angle, every few seconds: the
// preview, then the full video (see ../recordings/uploadProgress.js).
recordingsRouter.post("/sessions/:id/upload-progress", requireAuth, async (req, res, next) => {
  const startedAt = req.body?.startedAt;
  const stage = req.body?.stage;
  const fraction = Number(req.body?.fraction);
  if (!SESSION_ID_PATTERN.test(req.params.id) ||
      !Number.isSafeInteger(startedAt) || startedAt <= 0 ||
      !STAGES.has(stage) || !Number.isFinite(fraction)) {
    return res.status(400).json({ error: "Invalid upload progress." });
  }
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM recording_session_participants
        WHERE session_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: "You did not join this session." });
    }
    // Not for a recording that's been deleted.
    if (!(await isRecordingDeleted(req.params.id, startedAt))) {
      reportProgress(req.params.id, startedAt, Number(req.user.id), stage, fraction);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Count each finished local video once, including when a save is retried.
recordingsRouter.post("/sessions/:id/videos", requireAuth, async (req, res, next) => {
  const startedAt = req.body?.startedAt;
  if (!SESSION_ID_PATTERN.test(req.params.id) ||
      !Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > Date.now()) {
    return res.status(400).json({ error: "Invalid recording details." });
  }
  try {
    const participant = await pool.query(
      `SELECT 1 FROM recording_session_participants
        WHERE session_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (participant.rows.length === 0) {
      return res.status(403).json({ error: "You did not join this session." });
    }
    // Covers participants demoted to viewer after they joined.
    if (!atLeast(await getSessionRole(req.params.id, req.user.id), "member")) {
      return res.status(403).json({ error: "Viewers can't save recordings." });
    }
    if (await isRecordingDeleted(req.params.id, startedAt)) {
      return res.status(410).json({ error: "This recording was deleted." });
    }
    const number = await ensureRecordingNumber(req.params.id, startedAt);
    await pool.query(
      `INSERT INTO recording_session_videos
         (session_id, user_id, started_at_ms, start_offset_ms, start_offset_source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, user_id, started_at_ms) DO UPDATE
         SET ${START_OFFSET_UPSERT_SQL}`,
      [req.params.id, req.user.id, startedAt,
        startOffsetMs(req.body?.actualStartedAt, startedAt), startClock(req.body?.startClock)]
    );
    res.json({ ok: true, recording: { startedAt, number } });
  } catch (err) {
    next(err);
  }
});

// Everything a session recorded, as one zip to keep on a computer, phone or
// USB stick: a folder per recording ("Recording 001") with each member's
// angle named after them. Stored, not compressed: video is already
// compressed, so the zip starts streaming at once and costs no CPU.
//
// With ?kind=synced (what the apps' download button asks for) every angle
// is trimmed to start and end together, like the player, and each folder
// also has "All angles.mp4", every angle side by side in one video. Those
// are made in the background first (POST .../exports, see
// ../recordings/syncedExports.js); until they're ready this answers 409.
// Without it: each phone's original file, as recorded (not lined up).
const SYNCED_PARTS = ["synced", "grid"];
const GRID_NAME = "All angles";

// "All angles", or "All angles 2 of 4" when a recording needed several.
function gridName(index, count) {
  return count === 1 ? GRID_NAME : `${GRID_NAME} ${index + 1} of ${count}`;
}

recordingsRouter.get("/sessions/:id/download", requireAuth, async (req, res, next) => {
  const kind = req.query.kind ?? "original";
  if (kind !== "original" && kind !== "synced") {
    return res.status(400).json({ error: "Unknown download kind." });
  }
  const synced = kind === "synced";
  // Per recording: { synced, grid } finished exports, held until sent.
  const opened = [];
  let archive;
  try {
    const session = await visibleSession(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const takes = await sessionTakes(req.params.id);
    if (takes.length === 0) {
      return res.status(404).json({ error: "No videos have been uploaded for this session." });
    }

    if (synced) {
      for (const take of takes) {
        const parts = {};
        for (const part of SYNCED_PARTS) {
          const ready = await openExport(part, take);
          if (ready) parts[part] = ready;
        }
        opened.push(parts);
      }
      if (opened.some((parts) => SYNCED_PARTS.some((part) => !parts[part]))) {
        const status = await ensureExports(SYNCED_PARTS, takes);
        return res.status(409).json({ error: "This download is still being made.", status });
      }
    }

    const day = new Date(session.scheduled_at).toISOString().slice(0, 10);
    const zipName = `${safeName(session.name) || "Session"} ${day}${synced ? " synced" : ""}.zip`;
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition":
        `attachment; filename="${zipName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    });

    archive = archiver("zip", { store: true });
    archive.on("warning", () => {});
    archive.on("error", (err) => {
      console.error("Session download failed:", err);
      res.destroy(err);
    });
    // Stop reading files if the person cancels the download.
    res.on("close", () => {
      if (!res.writableFinished) archive.abort();
    });
    archive.pipe(res);

    // One file at a time, so a long session doesn't open every video at once.
    const add = async (stream, name, date) => {
      const added = new Promise((resolve) => archive.once("entry", resolve));
      archive.append(stream, { name, date });
      await added;
    };
    for (const [t, take] of takes.entries()) {
      const folder = `Recording ${String(take.number).padStart(3, "0")}`;
      const date = new Date(take.startedAt);
      const used = new Set();
      const named = (base, ext) => {
        let name = `${folder}/${base}${ext}`;
        for (let n = 2; used.has(name); n += 1) name = `${folder}/${base} (${n})${ext}`;
        used.add(name);
        return name;
      };
      if (synced) {
        const { grid } = opened[t];
        for (const [g, video] of grid.videos.entries()) {
          await add(fs.createReadStream(grid.path(video.file)),
            named(gridName(g, grid.videos.length), ".mp4"), date);
        }
      }
      for (const [a, angle] of take.angles.entries()) {
        const base = safeName(angle.name) || "Member";
        if (synced) {
          const ready = opened[t].synced;
          await add(fs.createReadStream(ready.path(ready.angles[a].file)), named(base, ".mp4"), date);
        } else {
          await add(await storage.open(angle.fileId), named(base, path.extname(angle.fileId)), date);
        }
      }
    }
    if (synced) {
      archive.append(syncedReadme(takes, opened), { name: "About these videos.txt" });
    }
    await archive.finalize();
  } catch (err) {
    if (archive) {
      archive.abort();
      if (res.headersSent) return res.destroy(err);
    }
    next(err);
  } finally {
    for (const parts of opened) for (const ready of Object.values(parts)) ready.release();
  }
});

// Asks for the session's synced download to be made, and says how far along
// it is: { state: queued|working|ready|failed, progress (0-1), waiting,
// error }. Safe to repeat: the apps call it every couple of seconds until
// it's "ready", then fetch .../download?kind=synced.
recordingsRouter.post("/sessions/:id/exports", requireAuth, async (req, res, next) => {
  try {
    if (!(await visibleSession(req.params.id, req.user.id))) {
      return res.status(404).json({ error: "Session not found." });
    }
    const takes = await sessionTakes(req.params.id);
    if (takes.length === 0) {
      return res.status(404).json({ error: "No videos have been uploaded for this session." });
    }
    res.json(await ensureExports(SYNCED_PARTS, takes));
  } catch (err) {
    next(err);
  }
});

async function visibleSession(sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT rs.id, rs.name, rs.scheduled_at FROM recording_sessions rs
     WHERE rs.id = $1 AND ${sessionVisibleSql("rs", "$2")}`,
    [sessionId, userId]
  );
  return rows[0] ?? null;
}

// The session's recordings with their uploaded angles (in name order) and
// each angle's start offset: the stored one the player lines it up by.
async function sessionTakes(sessionId) {
  const { rows } = await pool.query(
    `SELECT v.started_at_ms, v.user_id, v.file_id, v.preview_file_id,
            v.start_offset_ms, v.start_offset_source,
            u.display_name, sr.recording_number
       FROM recording_session_videos v
       JOIN users u ON u.user_id = v.user_id
       LEFT JOIN session_recordings sr
         ON sr.session_id = v.session_id AND sr.started_at_ms = v.started_at_ms
      WHERE v.session_id = $1 AND v.file_id IS NOT NULL
      ORDER BY v.started_at_ms, u.display_name, v.user_id`,
    [sessionId]
  );
  const takes = [];
  for (const row of rows) {
    const at = Number(row.started_at_ms);
    let take = takes[takes.length - 1];
    if (!take || take.startedAt !== at) {
      take = {
        sessionId,
        startedAt: at,
        number: row.recording_number == null ? takes.length + 1 : Number(row.recording_number),
        angles: [],
      };
      takes.push(take);
    }
    const startOffsetMs = row.start_offset_ms == null ? null : Number(row.start_offset_ms);
    take.angles.push({
      userId: Number(row.user_id),
      name: row.display_name || "Member",
      fileId: row.file_id,
      // A server preview, or the phone's; both keep the original's timeline.
      previewFileId: row.preview_file_id && row.preview_file_id !== row.file_id
        ? row.preview_file_id : null,
      startOffsetMs,
      // What the offset was measured from, for the note in the zip.
      syncedBy: startOffsetMs == null ? null : row.start_offset_source ?? "call",
    });
  }
  return takes;
}

// start_offset_source: the camera's first frame, the time the phone was
// told to start (older apps), or the sync beep (older takes).
const SYNCED_BY = {
  frame: "first frame",
  call: "phone's clock",
  beep: "sync beep",
};

// A note in the synced zip: how each angle was lined up.
function syncedReadme(takes, opened) {
  const lines = [
    "Every video in a recording's folder starts at the same moment and runs the same length,",
    `lined up the same way as the 8Kount player. "${GRID_NAME}.mp4" shows every angle side by side`,
    `(a big recording has several, up to ${MAX_PER_GRID} angles each).`,
    "",
  ];
  for (const [t, take] of takes.entries()) {
    const { synced } = opened[t];
    lines.push(`Recording ${String(take.number).padStart(3, "0")} (${formatSeconds(synced.length)})`);
    for (const angle of synced.angles) {
      const how = SYNCED_BY[angle.syncedBy] ?? "not measured, kept as recorded";
      lines.push(`  ${angle.name}: ${angle.skip.toFixed(3)} s trimmed from the start (${how})`);
    }
    const { videos } = opened[t].grid;
    if (videos.length > 1) {
      for (const [g, video] of videos.entries()) {
        lines.push(`  ${gridName(g, videos.length)}: ${video.angles.join(", ")}`);
      }
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

function formatSeconds(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// Letters, numbers, spaces and a little punctuation, for names inside a zip.
function safeName(value) {
  return String(value ?? "")
    .replace(/[^\p{L}\p{N} ._()-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// --- Session notes -------------------------------------------------------
//
// Rank comes from the shared group-role ladder (viewer < member < admin <
// owner). You may always delete your own note; otherwise you need a strictly
// higher rank than its author, so an admin cannot delete another admin's
// note and a member can only delete their own.

// The group owner is stored on groups.owner_id, so a note's author only
// counts as "owner" when their id matches it.
function noteAuthorRole(row) {
  // Without a group, whoever started the session owns it.
  const owner = row.group_id == null ? row.created_by : row.owner_id;
  return Number(owner) === Number(row.user_id)
    ? "owner"
    : row.role || "member";
}

function canDeleteNote(row, viewerId, viewerRole) {
  if (Number(row.user_id) === Number(viewerId)) return true;
  return (ROLE_RANK[viewerRole] ?? 0) > (ROLE_RANK[noteAuthorRole(row)] ?? 0);
}

// shapes note rows for the frontend
function publicNote(row, viewerId, viewerRole) {
  return {
    id: Number(row.note_id),
    body: row.body,
    videoTimeMs: Number(row.video_time_ms),
    author: row.display_name || "Unnamed member",
    canDelete: canDeleteNote(row, viewerId, viewerRole),
  };
}

// lists one recording's notes for members of the session's group
recordingsRouter.get("/sessions/:id/notes", requireAuth, async (req, res, next) => {
  const startedAt = Number(req.query.startedAt);
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
    return res.status(400).json({ error: "Invalid recording." });
  }
  try {
    const role = await getSessionRole(req.params.id, req.user.id);
    if (!role) {
      return res.status(404).json({ error: "Session not found." });
    }
    const { rows } = await pool.query(
      `SELECT n.note_id, n.body, n.video_time_ms, n.user_id, rs.group_id, rs.created_by,
              u.display_name, g.owner_id, gm.role
       FROM session_notes n
       JOIN recording_sessions rs ON rs.id = n.session_id
       LEFT JOIN groups g ON g.group_id = rs.group_id
       JOIN users u ON u.user_id = n.user_id
       LEFT JOIN group_members gm
         ON gm.group_id = rs.group_id AND gm.user_id = n.user_id
       WHERE n.session_id = $1 AND n.started_at_ms = $2
       ORDER BY n.video_time_ms, n.note_id`,
      [req.params.id, startedAt]
    );
    res.json({ notes: rows.map((row) => publicNote(row, req.user.id, role)) });
  } catch (err) {
    next(err);
  }
});

// adds a note at a point in one of the session's recordings
recordingsRouter.post("/sessions/:id/notes", requireAuth, async (req, res, next) => {
  const body = String(req.body?.body ?? "").trim();
  const startedAt = Number(req.body?.startedAt);
  const videoTimeMs = Math.round(Number(req.body?.videoTimeMs ?? 0));
  if (!body || body.length > 500) {
    return res.status(400).json({ error: "Notes must be 1 to 500 characters." });
  }
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
    return res.status(400).json({ error: "Invalid recording." });
  }
  if (!Number.isFinite(videoTimeMs) || videoTimeMs < 0) {
    return res.status(400).json({ error: "Invalid note time." });
  }
  try {
    const role = await getSessionRole(req.params.id, req.user.id);
    if (!role) {
      return res.status(404).json({ error: "Session not found." });
    }
    if (!atLeast(role, "member")) {
      return res.status(403).json({ error: "Viewers can't leave notes." });
    }
    await pool.query(
      `INSERT INTO session_notes (session_id, started_at_ms, user_id, body, video_time_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, startedAt, req.user.id, body, videoTimeMs]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// deletes a note the current user outranks, or one of their own
recordingsRouter.delete("/sessions/:id/notes/:noteId", requireAuth, async (req, res, next) => {
  const noteId = Number(req.params.noteId);
  if (!Number.isInteger(noteId)) {
    return res.status(400).json({ error: "Invalid note." });
  }
  try {
    const role = await getSessionRole(req.params.id, req.user.id);
    if (!role) {
      return res.status(404).json({ error: "Session not found." });
    }
    const { rows } = await pool.query(
      `SELECT n.user_id, g.owner_id, gm.role, rs.group_id, rs.created_by
       FROM session_notes n
       JOIN recording_sessions rs ON rs.id = n.session_id
       LEFT JOIN groups g ON g.group_id = rs.group_id
       LEFT JOIN group_members gm
         ON gm.group_id = rs.group_id AND gm.user_id = n.user_id
       WHERE n.note_id = $1 AND n.session_id = $2`,
      [noteId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Note not found." });
    }
    if (!canDeleteNote(rows[0], req.user.id, role)) {
      return res.status(403).json({ error: "You cannot delete this note." });
    }
    await pool.query("DELETE FROM session_notes WHERE note_id = $1", [noteId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// schedules a session for one of the user's groups
recordingsRouter.post("/sessions", requireAuth, async (req, res, next) => {
  const groupId = String(req.body?.groupId ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const scheduledAt = new Date(req.body?.scheduledAt);

  if (!groupId) {
    return res.status(400).json({ error: "Group is required." });
  }
  if (!name) {
    return res.status(400).json({ error: "Session name is required." });
  }
  if (Number.isNaN(scheduledAt.getTime())) {
    return res.status(400).json({ error: "Session date is invalid." });
  }
  if (scheduledAt.getTime() <= Date.now()) {
    return res.status(400).json({
      error: "Sessions must be scheduled for a future date and time.",
    });
  }

  try {
    const membership = await pool.query(
      `SELECT 1
         FROM group_members
        WHERE group_id = $1
          AND user_id = $2
          AND role = 'admin'`,
      [groupId, req.user.id]
    );

    if (membership.rowCount === 0) {
      return res.status(403).json({
        error: "Only owners and admins can schedule a session.",
      });
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = createSessionId();

      try {
        const { rows } = await pool.query(
          `INSERT INTO recording_sessions (
             id, group_id, name, scheduled_at, created_by
           )
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, group_id, name, scheduled_at,
                     created_at, created_by, status`,
          [id, groupId, name, scheduledAt, req.user.id]
        );

        return res.status(201).json({
          session: publicSession(rows[0]),
        });
      } catch (err) {
        if (err.code !== "23505") throw err;
      }
    }

    res.status(500).json({ error: "Unable to create a unique session ID." });
  } catch (err) {
    next(err);
  }
});

// starts a live session with its creator as the first member
recordingsRouter.post("/sessions/live", requireAuth, async (req, res, next) => {
  const groupId = String(req.body?.groupId ?? "").trim();
  const name = String(req.body?.name ?? "").trim();

  if (!name) {
    return res.status(400).json({ error: "Session name is required." });
  }
  // Every session belongs to a group: the group's invite is the one code
  // people share. (Sessions without a group, joined by their own code, were
  // dropped as confusing; old ones still work, see the join route.)
  if (!groupId) {
    return res.status(400).json({ error: "Choose a group for this session." });
  }

  let client;
  try {
    // Only the group's admins and owner start sessions.
    const membership = await pool.query(
      `SELECT 1
         FROM group_members
        WHERE group_id = $1
          AND user_id = $2
          AND role = 'admin'`,
      [groupId, req.user.id]
    );

    if (membership.rowCount === 0) {
      return res.status(403).json({
        error: "Only owners and admins can create a session.",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    let sessionRow = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = createSessionId();

      const { rows } = await client.query(
        `INSERT INTO recording_sessions (
           id, group_id, name, scheduled_at, created_by, status
         )
         VALUES ($1, $2, $3, NOW(), $4, 'active')
         ON CONFLICT (id) DO NOTHING
         RETURNING id, group_id, name, scheduled_at,
                   created_at, created_by, status`,
        [id, groupId, name, req.user.id]
      );

      if (rows.length > 0) {
        sessionRow = rows[0];
        break;
      }
    }

    if (!sessionRow) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        error: "Unable to create a unique session ID.",
      });
    }

    await client.query(
      `INSERT INTO recording_session_members (session_id, user_id)
       VALUES ($1, $2)`,
      [sessionRow.id, req.user.id]
    );
    await client.query(
      `INSERT INTO recording_session_participants (session_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [sessionRow.id, req.user.id]
    );
    await client.query("COMMIT");

    res.status(201).json({
      session: publicSession({
        ...sessionRow,
        active_member_count: 1,
        is_joined: true,
      }),
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    next(err);
  } finally {
    client?.release();
  }
});

// joins live sessions or scheduled sessions in their join window
recordingsRouter.post(
  "/sessions/:id/join",
  requireAuth,
  async (req, res, next) => {
    const id = String(req.params.id ?? "").trim();

    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "Session ID is invalid." });
    }

    try {
      const { rows } = await pool.query(
        `SELECT rs.id, rs.group_id, rs.name, rs.scheduled_at,
                rs.created_at, rs.created_by, rs.status,
                gm.role, g.owner_id,
                EXISTS (
                  SELECT 1
                    FROM recording_session_members rsm
                   WHERE rsm.session_id = rs.id
                ) AS has_members
           FROM recording_sessions rs
           LEFT JOIN groups g ON g.group_id = rs.group_id
           LEFT JOIN group_members gm
             ON gm.group_id = rs.group_id AND gm.user_id = $2
          WHERE rs.id = $1
            AND (gm.user_id IS NOT NULL OR rs.group_id IS NULL)`,
        [id, req.user.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Session not found." });
      }

      const session = rows[0];
      // Joining a session makes this device one of its cameras, which is
      // exactly what a viewer must not be.
      // An old session without a group (they can't be started any more):
      // its code is the invite, so anyone signed in who has it joins as a
      // member.
      const joinRole = session.group_id == null
        ? "member"
        : Number(session.owner_id) === Number(req.user.id)
          ? "owner"
          : session.role;
      if (!atLeast(joinRole, "member")) {
        return res.status(403).json({
          error: "Viewers can watch recordings but can't join and record.",
        });
      }
      if (!["active", "scheduled"].includes(session.status)) {
        return res.status(409).json({
          error: "This session is no longer open for joining.",
        });
      }

      // Opens at its start time (not before), and closes if nobody has
      // joined 15 minutes after.
      const joinOpensAt = new Date(session.scheduled_at).getTime();
      const joinClosesAt =
        new Date(session.scheduled_at).getTime() + 15 * 60 * 1000;

      if (session.status === "scheduled" && !session.has_members) {
        if (Date.now() < joinOpensAt) {
          return res.status(409).json({
            error: "This session opens at its start time.",
          });
        }
        if (Date.now() > joinClosesAt) {
          await pool.query(
            `UPDATE recording_sessions
                SET status = 'complete'
              WHERE id = $1
                AND status = 'scheduled'`,
            [id]
          );
          return res.status(409).json({
            error: "This session's join window has closed.",
          });
        }
      }

      await pool.query(
        `INSERT INTO recording_session_members (session_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [id, req.user.id]
      );

      await pool.query(
        `INSERT INTO recording_session_participants (session_id, user_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, req.user.id]
      );

      if (session.status === "scheduled") {
        await pool.query(
          `UPDATE recording_sessions
              SET status = 'active'
            WHERE id = $1
              AND status = 'scheduled'`,
          [id]
        );
        session.status = "active";
      }

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS active_member_count
           FROM recording_session_members
          WHERE session_id = $1`,
        [id]
      );

      res.json({
        session: publicSession({
          ...session,
          active_member_count: countRows[0].active_member_count,
          is_joined: true,
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

// leaves a session without ending it for everyone
recordingsRouter.delete(
  "/sessions/:id/join",
  requireAuth,
  async (req, res, next) => {
    const id = String(req.params.id ?? "").trim();

    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "Session ID is invalid." });
    }

    try {
      const { rows } = await pool.query(
        `SELECT created_by, status
           FROM recording_sessions
          WHERE id = $1`,
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Session not found." });
      }
      if (Number(rows[0].created_by) === Number(req.user.id)) {
        return res.status(403).json({
          error: "The session creator must end the session.",
        });
      }
      if (rows[0].status !== "active") {
        return res.status(409).json({
          error: "Only live sessions can be left.",
        });
      }

      await pool.query(
        `DELETE FROM recording_session_members
          WHERE session_id = $1
            AND user_id = $2`,
        [id, req.user.id]
      );
      await leaveSessionRoom(id, req.user.id).catch((err) =>
        console.error("Could not update the session's devices:", err));

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// Ends a live session for every connected member. The session's host can,
// and so can the group's admins and owner (say the host never showed up).
recordingsRouter.patch(
  "/sessions/:id/end",
  requireAuth,
  async (req, res, next) => {
    const id = String(req.params.id ?? "").trim();

    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "Session ID is invalid." });
    }

    try {
      const isAdmin = atLeast(await getSessionRole(id, req.user.id), "admin");
      const { rows } = await pool.query(
        `UPDATE recording_sessions
            SET status = 'complete'
          WHERE id = $1
            AND (created_by = $2 OR $3::boolean)
            AND status = 'active'
          RETURNING id, group_id, name, scheduled_at,
                    created_at, created_by, status`,
        [id, req.user.id, isAdmin]
      );

      if (rows.length === 0) {
        const sessionExists = await pool.query(
          `SELECT created_by, status
             FROM recording_sessions
            WHERE id = $1`,
          [id]
        );

        if (sessionExists.rowCount === 0) {
          return res.status(404).json({ error: "Session not found." });
        }
        if (
          Number(sessionExists.rows[0].created_by) !== Number(req.user.id) &&
          !isAdmin
        ) {
          return res.status(403).json({
            error: "Only the session's host or a group admin can end it.",
          });
        }
        return res.status(409).json({
          error: "Only live sessions can be ended.",
        });
      }

      const { rows: memberRows } = await pool.query(
        `SELECT COUNT(*) AS active_member_count,
                BOOL_OR(user_id = $2) AS is_joined
           FROM recording_session_members
          WHERE session_id = $1`,
        [id, req.user.id]
      );

      await closeSessionSocket(id);

      res.json({
        session: publicSession({
          ...rows[0],
          ...memberRows[0],
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

// Cancels a scheduled session but keeps it in the database. The session's
// creator can, and so can the group's admins and owner.
recordingsRouter.patch(
  "/sessions/:id/cancel",
  requireAuth,
  async (req, res, next) => {
    const id = String(req.params.id ?? "").trim();

    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "Session ID is invalid." });
    }

    try {
      const isAdmin = atLeast(await getSessionRole(id, req.user.id), "admin");
      const { rows } = await pool.query(
        `UPDATE recording_sessions
            SET status = 'cancelled'
          WHERE id = $1
            AND (created_by = $2 OR $3::boolean)
            AND status = 'scheduled'
          RETURNING id, group_id, name, scheduled_at,
                    created_at, created_by, status`,
        [id, req.user.id, isAdmin]
      );

      if (rows.length === 0) {
        const sessionExists = await pool.query(
          `SELECT created_by, status
             FROM recording_sessions
            WHERE id = $1`,
          [id]
        );

        if (sessionExists.rowCount === 0) {
          return res.status(404).json({ error: "Session not found." });
        }
        if (sessionExists.rows[0].status !== "scheduled") {
          return res.status(409).json({
            error: "Only scheduled sessions can be cancelled.",
          });
        }
        return res.status(403).json({
          error: "Only the session's host or a group admin can cancel it.",
        });
      }

      res.json({ session: publicSession(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

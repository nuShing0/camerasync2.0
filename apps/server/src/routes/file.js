// file and upload API
//
// Uploads are validated on local disk, then handed to the storage driver
// (local disk or S3, see ../storage/index.js). Downloads go through the same
// driver, so the client-facing URLs never change.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { atLeast, getSessionRole, sessionVisibleSql } from "../middleware/groupRole.js";
import { storage } from "../storage/index.js";
import { ensureRecordingNumber } from "../recordings/numbering.js";
import { START_OFFSET_UPSERT_SQL, startClock, startOffsetMs } from "../recordings/startOffset.js";
import { findEndBeep, findSyncBeep } from "../recordings/syncBeep.js";
import { remuxForStreaming } from "../recordings/remux.js";
import { queuePreview } from "../recordings/previews.js";
import { queueThumbnail } from "../recordings/thumbnails.js";

export const fileRouter = Router();

// 2048 MB upload limit
const MAX_UPLOAD_BYTES = 2048 * 1024 * 1024;

// Only accept these file types to avoid malicious uploads
const MEDIA_TYPES = {
  ".mp4": { family: "isobmff", mime: "video/mp4" },
  ".m4v": { family: "isobmff", mime: "video/x-m4v" },
  ".mov": { family: "isobmff", mime: "video/quicktime" },
  ".3gp": { family: "isobmff", mime: "video/3gpp" },
  ".mkv": { family: "ebml", mime: "video/x-matroska" },
  ".webm": { family: "ebml", mime: "video/webm" },
  ".avi": { family: "riff", mime: "video/x-msvideo" },
  ".mpeg": { family: "mpeg", mime: "video/mpeg" },
  ".mpg": { family: "mpeg", mime: "video/mpeg" },
};

const ALLOWED_EXTENSIONS = Object.keys(MEDIA_TYPES);

// Handle MIME types across different browsers
const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "",
]);

// Regex to handle directory escape attempts or scraping
const FILE_ID_PATTERN = /^[0-9a-f]{32}\.[a-z0-9]{2,4}$/;

// Reads the container family from a file's leading bytes. Returns null when
// the bytes don't look like any media container we accept.
function sniffContainerFamily(header) {
  if (header.length >= 12 && header.toString("latin1", 4, 8) === "ftyp") {
    return "isobmff";
  }
  if (
    header.length >= 4 &&
    header[0] === 0x1a &&
    header[1] === 0x45 &&
    header[2] === 0xdf &&
    header[3] === 0xa3
  ) {
    return "ebml";
  }
  if (
    header.length >= 12 &&
    header.toString("latin1", 0, 4) === "RIFF" &&
    header.toString("latin1", 8, 12) === "AVI "
  ) {
    return "riff";
  }
  // MPEG stream (00 00 01 BA), elementary stream (00 00 01 B3), or
  // transport stream (0x47 sync byte every 188 bytes).
  if (
    header.length >= 4 &&
    header[0] === 0x00 &&
    header[1] === 0x00 &&
    header[2] === 0x01 &&
    (header[3] === 0xba || header[3] === 0xb3)
  ) {
    return "mpeg";
  }
  if (header.length >= 189 && header[0] === 0x47 && header[188] === 0x47) {
    return "mpeg";
  }
  return null;
}

// Reads enough of a stored file to identify its container.
async function readHeader(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Saves a phone's preview of a take (see the kind=preview branch above):
// stored, and filed on the take's row as its preview, so playback shows it
// until the full video arrives. Ignored once the full video (or an earlier
// preview) is there.
async function savePreview(req, res, { fileId, tempPath, mediaType }) {
  await storage.put({ fileId, tempPath, contentType: mediaType.mime, size: req.file.size });
  let rows;
  try {
    const startedAt = Number(req.query.startedAt);
    await ensureRecordingNumber(req.query.sessionId, startedAt);
    ({ rows } = await pool.query(
      `INSERT INTO recording_session_videos
         (session_id, user_id, started_at_ms, preview_file_id, start_offset_ms,
          start_offset_source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, user_id, started_at_ms)
       DO UPDATE SET preview_file_id = EXCLUDED.preview_file_id,
         ${START_OFFSET_UPSERT_SQL}
       WHERE recording_session_videos.file_id IS NULL
         AND recording_session_videos.preview_file_id IS NULL
       RETURNING preview_file_id`,
      [req.query.sessionId, req.user.id, startedAt, fileId,
        startOffsetMs(req.query.actualStartedAt, startedAt), startClock(req.query.startClock)]
    ));
  } catch (err) {
    await storage.remove([fileId]).catch(() => {});
    throw err;
  }
  if (rows.length === 0) {
    await storage.remove([fileId]);
    return res.json({ ok: true });
  }
  return res.status(201).json({ preview: { id: fileId, url: `/api/files/get/${fileId}` } });
}

// Removes a temp file that never made it into storage; a no-op once put()
// has consumed it.
async function discard(filePath) {
  if (!filePath) return;
  await fsp.rm(filePath, { force: true }).catch(() => {});
}

// Marks the rejections that should surface as 415 rather than 500.
class UnsupportedMediaError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}

// Multer upload parameters
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storage.incomingDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID().replace(/-/g, "")}${ext}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 0,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!Object.hasOwn(MEDIA_TYPES, ext)) {
      return cb(new UnsupportedMediaError(
        `Unsupported file type. Allowed extensions: ${ALLOWED_EXTENSIONS.join(", ")}.`
      ));
    }

    const mime = String(file.mimetype ?? "").toLowerCase();
    if (!mime.startsWith("video/") && !GENERIC_MIME_TYPES.has(mime)) {
      return cb(new UnsupportedMediaError(
        `Unsupported content type "${file.mimetype}". Only media files are accepted.`
      ));
    }

    cb(null, true);
  },
});

// Serve a previously uploaded file through the storage driver.
fileRouter.get("/get/:fileId", requireAuth, async (req, res, next) => {
  const fileId = String(req.params.fileId ?? "").toLowerCase();

  if (!FILE_ID_PATTERN.test(fileId)) {
    return res.status(400).json({ error: "File ID is invalid." });
  }

  const ext = path.extname(fileId);
  // Thumbnails (see ../recordings/thumbnails.js) are served too, though
  // never accepted as uploads.
  const mediaType = ext === ".jpg" ? { mime: "image/jpeg" } : MEDIA_TYPES[ext];
  if (!mediaType) {
    return res.status(400).json({ error: "File ID is invalid." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM recording_sessions rs
         WHERE rs.id = v.session_id AND ${sessionVisibleSql("rs", "$2")}
       ) AS allowed FROM recording_session_videos v
        WHERE v.file_id = $1 OR v.preview_file_id = $1 OR v.thumbnail_file_id = $1
        LIMIT 1`,
      [fileId, req.user.id]
    );
    // A file is only reachable through the session it was recorded for.
    // Anything else on disk (an orphan from a failed insert, or a file that
    // predates the sessionId requirement) is not served to anyone.
    if (rows.length === 0) {
      return res.status(404).json({ error: "File not found." });
    }
    if (!rows[0].allowed) {
      return res.status(403).json({ error: "Join this group to watch its recordings." });
    }
  } catch (err) {
    return next(err);
  }
  // Guard against the HTTP Range Request trap (video streaming chunks)
  const isStreamingChunk = req.headers.range && req.headers.range !== 'bytes=0-';
  const isExplicitDownload = req.query.download === 'true';

  if (!isStreamingChunk || isExplicitDownload) {
    try {
      // Non-blocking insert. Finds the session_id dynamically based on the fileId.
      await pool.query(
        `INSERT INTO download_logs (session_id, user_id, file_type, file_id, ip_address)
         SELECT session_id, $2, 'recording', $1, $3
         FROM recording_session_videos
         WHERE file_id = $1 OR preview_file_id = $1 OR thumbnail_file_id = $1
         LIMIT 1`,
        [fileId, req.user.id, req.ip]
      );
    } catch (logError) {
      console.error("[Audit Log Error] Failed to write download_log:", logError);
    }
  }
  

  return storage.serve(req, res, next, { fileId, contentType: mediaType.mime });
});

// Handle file uploads.
fileRouter.post(
  "/upload",
  requireAuth,
  // Every upload belongs to a session the uploader joined. Session-less
  // uploads used to be accepted, which left files that no access check
  // covered, so any signed-in user could fetch them by id.
  async (req, res, next) => {
    if (!req.query.sessionId) {
      return res.status(400).json({ error: "sessionId is required." });
    }
    const startedAt = Number(req.query.startedAt);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > Date.now()) {
      return res.status(400).json({ error: "Invalid recording time." });
    }
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM recording_session_participants WHERE session_id = $1 AND user_id = $2`,
        [req.query.sessionId, req.user.id]
      );
      if (rows.length === 0) {
        return res.status(403).json({ error: "You did not join this session." });
      }
      // Covers participants demoted to viewer after they joined.
      const role = await getSessionRole(req.query.sessionId, req.user.id);
      if (!atLeast(role, "member")) {
        return res.status(403).json({ error: "Viewers can't upload recordings." });
      }
      next();
    } catch (err) {
      next(err);
    }
  },
  // Reject an oversized body before reading it, so the client gets a clean
  // 413 instead of having the connection cut mid-transfer. Requests without a
  // Content-Length still get caught by multer's own limit below.
  (req, res, next) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      return res.status(413).json({
        error: `File is too large. The limit is ${
          MAX_UPLOAD_BYTES / (1024 * 1024)
        } MB.`,
      });
    }
    next();
  },
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (!err) return next();

      if (err instanceof UnsupportedMediaError) {
        return res.status(415).json({ error: err.message });
      }
      if (err instanceof multer.MulterError) {
        switch (err.code) {
          case "LIMIT_FILE_SIZE":
            return res.status(413).json({
              error: `File is too large. The limit is ${
                MAX_UPLOAD_BYTES / (1024 * 1024)
              } MB.`,
            });
          case "LIMIT_FILE_COUNT":
          case "LIMIT_UNEXPECTED_FILE":
            return res.status(400).json({
              error: 'Send exactly one file in a "file" field.',
            });
          case "LIMIT_FIELD_COUNT":
            return res.status(400).json({
              error: "Extra form fields are not accepted.",
            });
          default:
            return res.status(400).json({ error: "Upload was rejected." });
        }
      }
      next(err);
    });
  },
  async (req, res, next) => {
    // reject if no file found
    if (!req.file) {
      return res.status(400).json({ error: 'A "file" field is required.' });
    }

    const tempPath = req.file.path;
    const fileId = req.file.filename;
    const mediaType = MEDIA_TYPES[path.extname(fileId)];
    try {
      // Handle bytes and file checksum verification to ensure theres no spoofing
      const family = sniffContainerFamily(await readHeader(tempPath));

      if (family !== mediaType.family) {
        await discard(tempPath);
        return res.status(415).json({
          error: "File contents are not a supported media file.",
        });
      }

      // Index at the front and seekable, so playback starts quickly. Keeps
      // the original if it can't (no re-encode either way).
      await remuxForStreaming(tempPath, path.extname(fileId));

      // A phone's small preview, sent before the full video so the take can
      // be watched within seconds on a slow connection. It stands in until
      // the full video arrives (which then replaces it).
      if (req.query.kind === "preview") {
        return savePreview(req, res, { fileId, tempPath, mediaType });
      }

      // Listen for the sync beep while the file is still on local disk, in
      // the file as stored: playback lines angles up in that file, and an
      // iPhone's sound can sit ~50 ms differently in the original.
      // findSyncBeep never throws; null just means playback falls back to
      // the start time the device reported.
      const beepAtMs = await findSyncBeep(tempPath);
      // And for the end beep, which lines up an angle that started too late
      // to hear the first.
      const endBeepAtMs = await findEndBeep(tempPath);

      // Store first, then record the row. The other way round, a failed
      // store would leave a row pointing at nothing, and the client's retry
      // would be refused because the row already has a file_id.
      await storage.put({
        fileId,
        tempPath,
        contentType: mediaType.mime,
        size: req.file.size,
      });

      let rows;
      try {
        await ensureRecordingNumber(req.query.sessionId, Number(req.query.startedAt));
        // The phone's preview, if one came first, gives way to one the server
        // makes from the full video (bigger, for the angle grid).
        ({ rows } = await pool.query(
          `WITH old AS (
             SELECT preview_file_id FROM recording_session_videos
              WHERE session_id = $1 AND user_id = $2 AND started_at_ms = $3
                AND file_id IS NULL
           )
           INSERT INTO recording_session_videos
             (session_id, user_id, started_at_ms, file_id, start_offset_ms, beep_at_ms,
              end_beep_at_ms, start_offset_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (session_id, user_id, started_at_ms)
           DO UPDATE SET file_id = EXCLUDED.file_id,
             ${START_OFFSET_UPSERT_SQL},
             beep_at_ms = EXCLUDED.beep_at_ms,
             end_beep_at_ms = EXCLUDED.end_beep_at_ms,
             preview_file_id = NULL,
             preview_failed = FALSE
           WHERE recording_session_videos.file_id IS NULL
           RETURNING file_id, (SELECT preview_file_id FROM old) AS old_preview`,
          [req.query.sessionId, req.user.id, Number(req.query.startedAt), fileId,
            startOffsetMs(req.query.actualStartedAt, Number(req.query.startedAt)),
            beepAtMs, endBeepAtMs, startClock(req.query.startClock)]
        ));
      } catch (err) {
        await storage.remove([fileId]).catch(() => {});
        throw err;
      }
      if (rows.length === 0) {
        // This recording already has a file (a retry after a lost reply).
        await storage.remove([fileId]);
        return res.json({ ok: true });
      }

      if (rows[0].old_preview) {
        await storage.remove([rows[0].old_preview]).catch(() => {});
      }
      // The smaller copy for the angle grid, made in the background.
      queuePreview(fileId);
      // And a still for the session lists.
      queueThumbnail(fileId);

      res.status(201).json({
        file: {
          id: fileId,
          originalName: req.file.originalname,
          contentType: mediaType.mime,
          size: req.file.size,
          url: `/api/files/get/${fileId}`,
          uploadedBy: req.user.id,
          uploadedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      await discard(tempPath);
      next(err);
    }
  }
);

// Every stored file behind these video rows: the originals and their
// previews, once each.
export function storedFileIds(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (row.file_id) ids.add(row.file_id);
    if (row.preview_file_id) ids.add(row.preview_file_id);
    if (row.thumbnail_file_id) ids.add(row.thumbnail_file_id);
  }
  return [...ids];
}

// Remove the stored files when their session is deleted.
export async function deleteRecordingFiles(fileIds) {
  for (const fileId of fileIds) {
    if (!FILE_ID_PATTERN.test(fileId)) throw new Error("Invalid recording file ID.");
  }
  await storage.remove(fileIds);
}

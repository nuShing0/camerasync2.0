// file and upload API
//
// Uploads are validated on local disk, then handed to the storage driver
// (local disk or S3, see ../storage/index.js). Downloads go through the same
// driver, so the client-facing URLs never change.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { atLeast, getSessionRole, sessionVisibleSql } from "../middleware/groupRole.js";
import { storage } from "../storage/index.js";
import { ensureRecordingNumber, isRecordingDeleted } from "../recordings/numbering.js";
import { START_OFFSET_UPSERT_SQL, startClock, startOffsetMs } from "../recordings/startOffset.js";
import { findEndBeep, findSyncBeep } from "../recordings/syncBeep.js";
import { remuxForStreaming } from "../recordings/remux.js";
import { queuePreview } from "../recordings/previews.js";
import { retireFile } from "../recordings/retiredFiles.js";
import { queueThumbnail } from "../recordings/thumbnails.js";
import { queueScrubFrames } from "../recordings/scrubFrames.js";
import { clearProgress } from "../recordings/uploadProgress.js";

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
       ) AS allowed FROM (
         SELECT session_id FROM recording_session_videos
          WHERE file_id = $1 OR preview_file_id = $1 OR thumbnail_file_id = $1
             OR scrub->'sheets' ? $1
         UNION ALL
         SELECT session_id FROM retired_files WHERE file_id = $1
       ) v
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

  return storage.serve(req, res, next, { fileId, contentType: mediaType.mime });
});

// Every upload belongs to a session the uploader joined. Session-less
// uploads used to be accepted, which left files that no access check
// covered, so any signed-in user could fetch them by id.
async function checkUploader(req, res, next) {
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
    // Deleted while this device was still sending it.
    if (await isRecordingDeleted(req.query.sessionId, startedAt)) {
      return res.status(410).json({ error: "This recording was deleted." });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Takes an upload that's fully on local disk (req.file) for the take in
// req.query: checks it's the media it claims, stores it, and files it on the
// take's row, as the take's preview (kind=preview) or its video.
async function finishUpload(req, res, next) {
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
      clearProgress(req.query.sessionId, Number(req.query.startedAt), Number(req.user.id), "preview");
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
      // Kept a while for anyone watching it (see ../recordings/retiredFiles.js).
      await retireFile(rows[0].old_preview, req.query.sessionId)
        .catch(() => storage.remove([rows[0].old_preview]).catch(() => {}));
    }
    // The smaller copy for the angle grid, made in the background.
    queuePreview(fileId);
    // And a still for the session lists.
    queueThumbnail(fileId);
    // And the stills shown while the seek bar is dragged.
    queueScrubFrames(fileId);
    // In: no more progress bar for this angle.
    clearProgress(req.query.sessionId, Number(req.query.startedAt), Number(req.user.id));

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

// Handle file uploads.
fileRouter.post(
  "/upload",
  requireAuth,
  checkUploader,
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
  finishUpload
);

// Resumable uploads: a file sent in pieces, so a dropped connection (or the
// phone pausing uploads during a take) carries on from where it stopped
// instead of starting over. The partial file waits on local disk; once it's
// all there it goes through finishUpload like any other upload.
//
//   POST /uploads?<the /upload query>&size=&name=  starts one: {uploadId, offset}
//   GET  /uploads/:id                              how much has arrived: {offset, size}
//   PUT  /uploads/:id?offset=                      appends the request body there
//   POST /uploads/:id/complete                     finishes it, as /upload replies
//
// A PUT for any other offset than what has arrived gets 409 with the right
// one. Uploads left unfinished are deleted after UNFINISHED_KEEP_MS.

const UNFINISHED_KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;
// Uploads a request is appending to right now, so two can't interleave.
const appending = new Set();

const partPath = (id) => path.join(storage.incomingDir, `${id}.part`);

async function arrivedBytes(id) {
  const stat = await fsp.stat(partPath(id)).catch(() => null);
  return stat ? stat.size : null;
}

// The caller's unfinished upload, or null (someone else's counts as missing).
async function findUpload(req) {
  const id = String(req.params.id ?? "");
  if (!UPLOAD_ID_PATTERN.test(id)) return null;
  const { rows } = await pool.query(
    "SELECT id, ext, size, query FROM resumable_uploads WHERE id = $1 AND user_id = $2",
    [id, req.user.id]
  );
  if (rows.length === 0) return null;
  return { ...rows[0], size: Number(rows[0].size) };
}

fileRouter.post("/uploads", requireAuth, checkUploader, async (req, res, next) => {
  const size = Number(req.query.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    return res.status(400).json({ error: "Invalid file size." });
  }
  if (size > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      error: `File is too large. The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    });
  }
  const ext = path.extname(String(req.query.name ?? "")).toLowerCase();
  if (!Object.hasOwn(MEDIA_TYPES, ext)) {
    return res.status(415).json({
      error: `Unsupported file type. Allowed extensions: ${ALLOWED_EXTENSIONS.join(", ")}.`,
    });
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await fsp.writeFile(partPath(id), "");
    // The take's details, to finish it with once it's all here.
    const { size: _size, ...query } = req.query;
    await pool.query(
      `INSERT INTO resumable_uploads (id, user_id, ext, size, query)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.user.id, ext, size, JSON.stringify(query)]
    );
    res.status(201).json({ uploadId: id, offset: 0 });
  } catch (err) {
    await discard(partPath(id));
    next(err);
  }
});

fileRouter.get("/uploads/:id", requireAuth, async (req, res, next) => {
  try {
    const upload = await findUpload(req);
    const offset = upload && (await arrivedBytes(upload.id));
    if (!upload || offset == null) {
      return res.status(404).json({ error: "Upload not found. Start it again." });
    }
    res.json({ offset, size: upload.size });
  } catch (err) {
    next(err);
  }
});

fileRouter.put("/uploads/:id", requireAuth, async (req, res, next) => {
  let upload;
  try {
    upload = await findUpload(req);
  } catch (err) {
    return next(err);
  }
  if (!upload) return res.status(404).json({ error: "Upload not found. Start it again." });
  if (appending.has(upload.id)) {
    return res.status(409).json({ error: "This upload is already being sent." });
  }
  appending.add(upload.id);
  try {
    const offset = await arrivedBytes(upload.id);
    if (offset == null) {
      return res.status(404).json({ error: "Upload not found. Start it again." });
    }
    if (Number(req.query.offset) !== offset) {
      return res.status(409).json({ error: "Wrong offset.", offset });
    }
    let received = 0;
    const limit = upload.size - offset;
    const out = fs.createWriteStream(partPath(upload.id), { flags: "a" });
    try {
      await pipeline(req, async function* (chunks) {
        for await (const chunk of chunks) {
          received += chunk.length;
          if (received > limit) throw new RangeError("More than the file's size.");
          yield chunk;
        }
      }, out);
    } catch (err) {
      // What arrived before the connection dropped stays; the client asks
      // where to carry on from. Too much is cut back to the size.
      if (err instanceof RangeError) {
        await fsp.truncate(partPath(upload.id), upload.size).catch(() => {});
        return res.status(413).json({ error: err.message });
      }
      if (!res.headersSent && !req.destroyed) return next(err);
      return;
    }
    res.json({ offset: await arrivedBytes(upload.id), size: upload.size });
  } catch (err) {
    next(err);
  } finally {
    appending.delete(upload.id);
  }
});

fileRouter.post(
  "/uploads/:id/complete",
  requireAuth,
  async (req, res, next) => {
    try {
      const upload = await findUpload(req);
      const offset = upload && (await arrivedBytes(upload.id));
      if (!upload || offset == null) {
        return res.status(404).json({ error: "Upload not found. Start it again." });
      }
      if (offset !== upload.size || appending.has(upload.id)) {
        return res.status(409).json({ error: "The upload isn't all here yet.", offset });
      }
      // Handed to finishUpload as if it had come in one request.
      const fileId = `${upload.id}${upload.ext}`;
      const tempPath = path.join(storage.incomingDir, fileId);
      await fsp.rename(partPath(upload.id), tempPath);
      await pool.query("DELETE FROM resumable_uploads WHERE id = $1", [upload.id]);
      req.query = upload.query;
      req.file = {
        path: tempPath,
        filename: fileId,
        size: upload.size,
        originalname: String(upload.query.name ?? fileId),
      };
      next();
    } catch (err) {
      next(err);
    }
  },
  // Still allowed to (a member demoted to viewer meanwhile isn't).
  checkUploader,
  finishUpload
);

// Deletes uploads nobody finished, every few hours.
export function startUnfinishedUploadSweep({ everyMs = 6 * 60 * 60 * 1000 } = {}) {
  const sweep = async () => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM resumable_uploads
          WHERE created_at < NOW() - make_interval(secs => $1)
          RETURNING id`,
        [UNFINISHED_KEEP_MS / 1000]
      );
      for (const { id } of rows) await discard(partPath(id));
    } catch (err) {
      console.error("[uploads] sweep failed:", err);
    }
  };
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return timer;
}

// Every stored file behind these video rows: the originals, their previews,
// thumbnails and seek-bar stills, once each.
export function storedFileIds(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (row.file_id) ids.add(row.file_id);
    if (row.preview_file_id) ids.add(row.preview_file_id);
    if (row.thumbnail_file_id) ids.add(row.thumbnail_file_id);
    for (const sheet of row.scrub?.sheets ?? []) ids.add(sheet);
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

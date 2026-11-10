// Small stills from each video, several a second, for dragging the seek
// bar: the players show these while the handle moves, so every angle shows
// the same instant under the finger at once (jumping real video around
// can't keep up), and the real videos take over where it's let go.
//
// SCRUB_FPS frames a second, SCRUB_SIZE px on the shorter side, as JPEGs
// tiled COLS x ROWS to a sheet (one download per SHEET_FRAMES / SCRUB_FPS
// seconds of video). Frame k of the video's own timeline (k / SCRUB_FPS s)
// is tile k % SHEET_FRAMES of sheet floor(k / SHEET_FRAMES), left to right,
// top to bottom. Made in the background after the upload, from the small
// preview when there is one, one video at a time; older videos are worked
// through when the server starts. Without ffmpeg nothing is made, and
// dragging moves the real videos as before.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pool } from "../db/pool.js";
import { storage } from "../storage/index.js";
import { probe, run } from "./previews.js";

export const SCRUB_FPS = 5;
export const SCRUB_SIZE = 144;
export const COLS = 10;
export const ROWS = 10;
const SHEET_FRAMES = COLS * ROWS;

// One tile's size for a video this size: SCRUB_SIZE on the shorter side,
// the other in proportion, both even (as ffmpeg's -2 makes them).
export function tileSize(width, height) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return width >= height
    ? { width: even((width * SCRUB_SIZE) / height), height: SCRUB_SIZE }
    : { width: SCRUB_SIZE, height: even((height * SCRUB_SIZE) / width) };
}

// The ffmpeg arguments for the sheets of [input], written as
// [outputPattern] (with a %03d for the sheet number).
export function scrubArgs(input, outputPattern, tile) {
  return [
    "-v", "error", "-y", "-i", input, "-an",
    "-vf", `fps=${SCRUB_FPS},scale=${tile.width}:${tile.height},tile=${COLS}x${ROWS}`,
    "-q:v", "6", "-start_number", "0", "-f", "image2", outputPattern,
  ];
}

let ffmpegMissing = false;

// Makes the sheets for one stored video (by its original's file id) and
// records them on the video's row.
export async function makeScrubFrames(fileId) {
  const { rows } = await pool.query(
    `SELECT preview_file_id FROM recording_session_videos
      WHERE file_id = $1 AND scrub IS NULL`,
    [fileId]
  );
  if (rows.length === 0) return "skipped";
  // The preview has the same timeline and is quicker to decode.
  const sourceId = rows[0].preview_file_id || fileId;
  const work = path.join(storage.incomingDir, `scrub-${crypto.randomUUID()}`);
  const source = `${work}-source${path.extname(sourceId)}`;
  const made = [];
  const stored = [];
  try {
    await pipeline(await storage.open(sourceId), fs.createWriteStream(source));
    const info = await probe(source);
    if (info?.missing) {
      ffmpegMissing = true;
      return "missing";
    }
    if (!info?.width || !info?.height || !info?.duration) throw new Error("couldn't read the video");
    const tile = tileSize(info.width, info.height);
    const result = await run("ffmpeg", scrubArgs(source, `${work}-%03d.jpg`, tile), { timeoutMs: 600_000 });
    if (result.missing) {
      ffmpegMissing = true;
      return "missing";
    }
    if (!result.ok) throw new Error(result.err?.trim() || "ffmpeg failed");
    const prefix = `${path.basename(work)}-`;
    const names = (await fsp.readdir(path.dirname(work)))
      .filter((name) => name.startsWith(prefix) && /^\d{3}\.jpg$/.test(name.slice(prefix.length)))
      .sort();
    if (names.length === 0) throw new Error("ffmpeg made no sheets");
    made.push(...names.map((name) => path.join(path.dirname(work), name)));
    const frames = Math.min(
      Math.max(1, Math.floor(info.duration * SCRUB_FPS)), names.length * SHEET_FRAMES);
    for (const sheet of made) {
      const id = `${crypto.randomUUID().replace(/-/g, "")}.jpg`;
      await storage.put({ fileId: id, tempPath: sheet, contentType: "image/jpeg" });
      stored.push(id);
    }
    const scrub = {
      fps: SCRUB_FPS, width: tile.width, height: tile.height,
      cols: COLS, rows: ROWS, frames, sheets: stored,
    };
    const { rowCount } = await pool.query(
      `UPDATE recording_session_videos SET scrub = $2
        WHERE file_id = $1 AND scrub IS NULL`,
      [fileId, JSON.stringify(scrub)]
    );
    // The video was deleted (or got its frames) meanwhile.
    if (rowCount === 0) await storage.remove(stored);
    return "made";
  } catch (err) {
    console.error(`[scrub frames] ${fileId}: ${err.message}`);
    if (stored.length > 0) await storage.remove(stored).catch(() => {});
    await pool.query(
      "UPDATE recording_session_videos SET scrub_failed = TRUE WHERE file_id = $1",
      [fileId]
    ).catch(() => {});
    return "failed";
  } finally {
    await fsp.rm(source, { force: true }).catch(() => {});
    const dir = path.dirname(work);
    const prefix = `${path.basename(work)}-`;
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.startsWith(prefix) && name.endsWith(".jpg")) {
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    }
  }
}

const queue = [];
const queued = new Set();
let draining = false;

export function queueScrubFrames(fileId) {
  if (ffmpegMissing || !fileId || queued.has(fileId)) return;
  queued.add(fileId);
  queue.push(fileId);
  if (!draining) drain();
}

async function drain() {
  draining = true;
  while (queue.length > 0 && !ffmpegMissing) {
    const fileId = queue.shift();
    try {
      await makeScrubFrames(fileId);
    } finally {
      queued.delete(fileId);
    }
  }
  queue.length = 0;
  queued.clear();
  draining = false;
}

// Videos without frames yet, newest first, once the server is up.
export function startScrubBackfill({ delayMs = 40_000 } = {}) {
  const timer = setTimeout(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT file_id FROM recording_session_videos
          WHERE file_id IS NOT NULL AND scrub IS NULL AND NOT scrub_failed
          ORDER BY started_at_ms DESC`
      );
      if (rows.length > 0) console.log(`[scrub frames] ${rows.length} video(s) to do`);
      for (const { file_id: fileId } of rows) queueScrubFrames(fileId);
    } catch (err) {
      console.error("[scrub frames] backfill failed:", err);
    }
  }, delayMs);
  timer.unref();
  return timer;
}

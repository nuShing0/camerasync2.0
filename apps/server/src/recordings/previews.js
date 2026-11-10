// Smaller copies of uploaded videos, for watching many angles at once.
//
// A phone can only decode so many full-HD videos at a time: with six or
// more angles on a TV some never start and the rest stutter. So each upload
// also gets a preview, at most 720p and 30 fps, that the angle grid plays
// while an angle is drawn small. The original is never changed; it's still
// what plays full screen and what downloads.
//
// The preview keeps the original's timeline (same start, same moments), so
// the sync beep and start offsets measured in the original line it up too.
//
// Made in the background, one at a time and at low priority, after the
// upload has answered. Videos uploaded before previews existed are worked
// through when the server starts. Needs ffmpeg (in the server image); where
// it's missing nothing is marked, and the angles just play the originals.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { pool } from "../db/pool.js";
import { storage } from "../storage/index.js";

// The preview's shorter side; never more than the original's.
export const PREVIEW_SIZE = 720;
const PREVIEW_FPS = 30;
// An original already this small, light and slow is its own preview.
const SMALL_ENOUGH_BITRATE = 4_000_000;
// ...as long as every phone can play it. Laptops record VP9, which iPhones
// can't, so those always get an H.264 copy (the preview the apps fall back
// to), even when they're small.
const PLAYABLE_EVERYWHERE = new Set(["h264", "hevc"]);

const TIMEOUT_MS = 30 * 60 * 1000;

// Runs a tool and collects its output. `missing` when it isn't installed.
export function run(command, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    // Low priority on Linux, so the API stays quick while a preview is made.
    const [cmd, cmdArgs] =
      process.platform === "linux" ? ["nice", ["-n", "15", command, ...args]] : [command, args];
    try {
      child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, missing: true, out: "" });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, missing: e.code === "ENOENT", out, err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // nice exits 127 when it can't find the command.
      resolve({ ok: code === 0, missing: code === 127, out, err });
    });
  });
}

// Size, frame rate, bitrate and length of the first video stream, as
// displayed (a phone's sideways-stored video counts as upright).
export async function probe(filePath) {
  const { ok, missing, out } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate,bit_rate:stream_side_data=rotation:format=bit_rate,duration",
    "-of", "json", filePath,
  ], { timeoutMs: 60_000 });
  if (missing) return { missing: true };
  if (!ok) return null;
  try {
    const info = JSON.parse(out);
    const stream = info.streams?.[0];
    if (!stream) return null;
    const rotation = Math.abs(Number(stream.side_data_list?.find((d) => "rotation" in d)?.rotation ?? 0));
    const sideways = rotation === 90 || rotation === 270;
    const [num, den] = String(stream.avg_frame_rate ?? "0/1").split("/").map(Number);
    return {
      width: sideways ? stream.height : stream.width,
      height: sideways ? stream.width : stream.height,
      fps: den ? num / den : 0,
      bitRate: Number(stream.bit_rate ?? info.format?.bit_rate ?? 0),
      codec: stream.codec_name,
      duration: Number(info.format?.duration ?? 0),
    };
  } catch {
    return null;
  }
}

// The ffmpeg arguments for a preview of a video with this probe.
export function previewArgs(input, output, { fps }) {
  const filters = [];
  // Fewer frames to decode; the timeline is unchanged (frames are dropped,
  // not retimed).
  if (fps > PREVIEW_FPS + 1) filters.push(`fps=${PREVIEW_FPS}`);
  // Shorter side down to PREVIEW_SIZE, portrait or landscape, never up.
  filters.push(
    `scale='if(gte(iw,ih),-2,min(${PREVIEW_SIZE},iw))':'if(gte(iw,ih),min(${PREVIEW_SIZE},ih),-2)'`
  );
  return [
    "-v", "error", "-y", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", filters.join(","),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "25",
    "-maxrate", "3M", "-bufsize", "6M", "-pix_fmt", "yuv420p",
    // A keyframe every second, so the grid's catch-up jumps land quickly.
    "-force_key_frames", "expr:gte(t,n_forced*1)",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart", "-f", "mp4", output,
  ];
}

export function isSmallEnough({ width, height, bitRate, fps, codec }) {
  return (!codec || PLAYABLE_EVERYWHERE.has(codec)) &&
    Math.min(width, height) <= PREVIEW_SIZE &&
    bitRate > 0 && bitRate <= SMALL_ENOUGH_BITRATE &&
    fps > 0 && fps <= PREVIEW_FPS + 1;
}

let ffmpegMissing = false;

// Makes the preview for one stored video and records it on the video's row.
export async function makePreview(fileId) {
  const work = path.join(storage.incomingDir, `preview-${crypto.randomUUID()}`);
  const source = `${work}-source${path.extname(fileId)}`;
  const output = `${work}.mp4`;
  try {
    await pipeline(await storage.open(fileId), fs.createWriteStream(source));
    const info = await probe(source);
    if (info?.missing) {
      ffmpegMissing = true;
      return "missing";
    }
    if (!info) throw new Error("couldn't read the video");

    let previewId = fileId;
    if (!isSmallEnough(info)) {
      const result = await run("ffmpeg", previewArgs(source, output, info));
      if (result.missing) {
        ffmpegMissing = true;
        return "missing";
      }
      const { size } = result.ok ? await fsp.stat(output) : { size: 0 };
      if (!result.ok || size === 0) {
        throw new Error(result.err?.trim().split("\n").pop() || "ffmpeg failed");
      }
      previewId = `${crypto.randomUUID().replace(/-/g, "")}.mp4`;
      await storage.put({ fileId: previewId, tempPath: output, contentType: "video/mp4" });
    }

    const { rowCount } = await pool.query(
      `UPDATE recording_session_videos SET preview_file_id = $2, preview_checked = TRUE
        WHERE file_id = $1 AND (preview_file_id IS NULL OR preview_file_id = file_id)`,
      [fileId, previewId]
    );
    // The video was deleted (or got a preview) while this one was made.
    if (rowCount === 0 && previewId !== fileId) await storage.remove([previewId]);
    return previewId === fileId ? "original" : "made";
  } catch (err) {
    console.error(`[previews] ${fileId}: ${err.message}`);
    await pool.query(
      "UPDATE recording_session_videos SET preview_failed = TRUE WHERE file_id = $1",
      [fileId]
    ).catch(() => {});
    return "failed";
  } finally {
    await fsp.rm(source, { force: true }).catch(() => {});
    await fsp.rm(output, { force: true }).catch(() => {});
  }
}

// One at a time: making a preview takes the CPU for about the length of
// the video.
const queue = [];
const queued = new Set();
let draining = false;

export function queuePreview(fileId) {
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
      const result = await makePreview(fileId);
      if (result === "made") console.log(`[previews] made one for ${fileId}`);
      if (result === "missing") console.log("[previews] ffmpeg isn't installed; skipping previews");
    } finally {
      queued.delete(fileId);
    }
  }
  queue.length = 0;
  queued.clear();
  draining = false;
}

// Videos without a preview yet, newest first, once the server is up.
export function startPreviewBackfill({ delayMs = 30_000 } = {}) {
  const timer = setTimeout(async () => {
    try {
      // Also, once, videos that are their own preview from before the
      // codec was checked (a laptop's VP9 needs an H.264 copy).
      const { rows } = await pool.query(
        `SELECT file_id FROM recording_session_videos
          WHERE file_id IS NOT NULL AND NOT preview_failed
            AND (preview_file_id IS NULL
              OR (preview_file_id = file_id AND NOT preview_checked))
          ORDER BY started_at_ms DESC`
      );
      if (rows.length > 0) console.log(`[previews] ${rows.length} video(s) to do`);
      for (const { file_id: fileId } of rows) queuePreview(fileId);
    } catch (err) {
      console.error("[previews] backfill failed:", err);
    }
  }, delayMs);
  timer.unref();
  return timer;
}

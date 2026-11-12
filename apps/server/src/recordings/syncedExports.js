// Downloads that come out lined up, like the in-app player.
//
// Each phone starts recording a moment after the take's shared start, by a
// different amount each time, so the originals in the plain session zip
// don't line up. The player fixes that live by skipping each angle ahead by
// its stored start_offset_ms (see angleTrims.js on the web). This makes
// files that are already fixed, two ways:
//
//   synced  every angle cut to start at the same instant (when the last
//           camera began) and end together (when the first one stopped),
//           at full quality: one MP4 per angle.
//   grid    one MP4 with every angle side by side, cut the same way, built
//           from the 720p previews (see previews.js) to keep it cheap.
//
// Why re-encode: a stream copy (-c copy) can only start on a keyframe, and
// phones put one every 1-2 s, so a copied cut would land up to a couple of
// seconds off: worse than the drift being fixed. Re-encoding from the
// decoded frame is exact to the frame. The one angle that started last
// needs no start cut, so it is copied as it is (cut only at the end, which
// a copy does fine): one re-encode saved per take.
//
// It takes minutes per take on a small server, so it never runs in a
// request: a request asks for an export (ensureExports) and gets progress
// back; the work runs in the background, one take at a time, at low
// priority; the result is kept on disk (EXPORT_DIR) so the next download is
// instant. A cached export is keyed by the take's files and offsets, so a
// late upload or a better offset makes a new one. Old ones are swept by age
// and total size, and dropped when their recording is deleted.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { pool } from "../db/pool.js";
import { UPLOAD_DIR, storage } from "../storage/index.js";

export const EXPORT_KINDS = new Set(["synced", "grid"]);

export const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.join(UPLOAD_DIR, "exports");
// The instance has a 30 GB disk; recordings themselves are in S3.
const CACHE_LIMIT_BYTES = Number(process.env.EXPORT_CACHE_MB || 5000) * 1024 * 1024;
const CACHE_MAX_AGE_MS = Number(process.env.EXPORT_CACHE_HOURS || 72) * 3600 * 1000;
// How long a failure is remembered before asking again retries it.
const FAILURE_MEMORY_MS = 60_000;
const TIMEOUT_MS = 60 * 60 * 1000;

// Shorter than this together, the angles don't really overlap.
const MIN_SHARED_SECONDS = 0.5;
// A start cut this small is under a frame: copy instead of re-encoding.
const COPY_BELOW_SECONDS = 0.02;

// The grid: each cell fits a 16:9 (or 9:16) 640x360 box, the whole frame
// no bigger than 1920 on its long side.
const CELL_LONG = 640;
const CELL_SHORT = 360;
const GRID_MAX = 1920;
const GRID_FPS = 30;

// --- Planning (pure) -------------------------------------------------------

/// Where each angle is cut so a take lines up: the shared start is when the
/// last camera began, the shared end when the first one stopped. Offsets are
/// how much later each camera began than the take's start (ms; unknown counts
/// as on time, as in the player); durations are each file's length (s).
/// Returns { skips: seconds to cut from each start, length } or null when the
/// angles don't overlap.
export function syncWindow(angles) {
  if (angles.length === 0) return null;
  const offsets = angles.map((angle) => angle.startOffsetMs ?? 0);
  const latest = Math.max(...offsets);
  const skips = offsets.map((offset) => round3((latest - offset) / 1000));
  const length = round3(Math.min(...angles.map((angle, i) => angle.duration - skips[i])));
  if (!Number.isFinite(length) || length < MIN_SHARED_SECONDS) return null;
  return { skips, length };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/// ffmpeg arguments for one angle of a synced take: frame-exact cut by
/// re-encoding, or a copy when there's nothing to cut at the start (`copy`,
/// see canCopy).
export function syncedAngleArgs(input, output, { skip, length, copy = false }) {
  const head = ["-v", "error", "-nostats", "-progress", "pipe:1", "-y"];
  if (copy) {
    return [
      ...head, "-i", input, "-t", String(length),
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-movflags", "+faststart", "-f", "mp4", output,
    ];
  }
  return [
    // -ss before -i seeks fast, and with re-encoding starts at the exact
    // frame (ffmpeg decodes from the keyframe before and drops the rest).
    ...head, ...(skip > 0 ? ["-ss", String(skip)] : []), "-i", input, "-t", String(length),
    "-map", "0:v:0", "-map", "0:a:0?",
    // Close to the original's quality; veryfast keeps the CPU time down.
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart", "-f", "mp4", output,
  ];
}

/// Whether an angle can be copied rather than re-encoded: nothing to cut at
/// the start, and a codec an MP4 holds (a laptop's VP9 WebM gets re-encoded).
export function canCopy(skip, codec) {
  return skip < COPY_BELOW_SECONDS && (codec === "h264" || codec === "hevc");
}

/// Rows and columns for a grid of `count` angles, and each cell's size.
/// `portrait` when most angles are taller than wide.
export function gridLayout(count, portrait) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  let cellW = portrait ? CELL_SHORT : CELL_LONG;
  let cellH = portrait ? CELL_LONG : CELL_SHORT;
  const fit = Math.min(1, GRID_MAX / (cols * cellW), GRID_MAX / (rows * cellH));
  cellW = even(cellW * fit);
  cellH = even(cellH * fit);
  // Top-left corner of each cell; a short last row is centred.
  const cells = [];
  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const indent = ((cols - inRow) * cellW) / 2;
    cells.push({ x: even(indent + (i % cols) * cellW), y: row * cellH });
  }
  return { cols, rows, cellW, cellH, width: cols * cellW, height: rows * cellH, cells };
}

function even(value) {
  return Math.floor(value / 2) * 2;
}

/// ffmpeg arguments for the grid video: each angle cut to the shared window,
/// fitted into its cell (letterboxed, never stretched), stacked with xstack.
/// Sound comes from one angle (`audioFrom`, an index, or null for none):
/// mixing every phone's would echo.
export function gridArgs(inputs, output, { skips, length, portrait, audioFrom }) {
  const layout = gridLayout(inputs.length, portrait);
  const args = ["-v", "error", "-nostats", "-progress", "pipe:1", "-y"];
  inputs.forEach((input, i) => {
    args.push("-ss", String(skips[i]), "-t", String(length), "-i", input);
  });
  const { cellW: w, cellH: h } = layout;
  const fitted = inputs.map((_, i) =>
    `[${i}:v:0]fps=${GRID_FPS},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`);
  const stacked = inputs.length === 1
    ? "[v0]null[grid]"
    : `${inputs.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${inputs.length}:` +
      `layout=${layout.cells.map(({ x, y }) => `${x}_${y}`).join("|")}:fill=black[grid]`;
  args.push(
    "-filter_complex", [...fitted, stacked].join(";"),
    "-map", "[grid]",
    ...(audioFrom == null ? [] : ["-map", `${audioFrom}:a:0`]),
    "-t", String(length),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    ...(audioFrom == null ? [] : ["-c:a", "aac", "-b:a", "128k"]),
    "-movflags", "+faststart", "-f", "mp4", output,
  );
  return { args, layout };
}

/// What identifies an export: its kind and every angle's file and offset.
/// Anything that changes how the take lines up makes a new key.
export function exportKey(kind, take) {
  const angles = take.angles
    .map((a) => [a.fileId, a.startOffsetMs ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash("sha256")
    .update(JSON.stringify({ v: 1, kind, angles }))
    .digest("hex")
    .slice(0, 32);
}

// --- Running ffmpeg --------------------------------------------------------

// Runs ffmpeg/ffprobe, collecting output; `onProgress` hears seconds done,
// from ffmpeg's -progress lines. Low priority on Linux.
export function runTool(command, args, { onProgress, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const [cmd, cmdArgs] =
      process.platform === "linux" ? ["nice", ["-n", "15", command, ...args]] : [command, args];
    let child;
    try {
      child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, missing: true, out: "", err: "" });
      return;
    }
    let out = "";
    let err = "";
    let partial = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > 1_000_000) out = out.slice(-100_000);
      if (!onProgress) return;
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop();
      for (const line of lines) {
        const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (match) onProgress(Number(match[1]) / 1e6);
      }
    });
    child.stderr.on("data", (chunk) => {
      err = (err + chunk).slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, missing: e.code === "ENOENT", out, err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, missing: code === 127, out, err });
    });
  });
}

// Length, codec, upright size and whether there's sound.
async function probeMedia(filePath) {
  const result = await runTool("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height:stream_side_data=rotation:format=duration",
    "-of", "json", filePath,
  ], { timeoutMs: 60_000 });
  if (result.missing) throw new ToolMissing();
  if (!result.ok) throw new Error("couldn't read a video");
  const info = JSON.parse(result.out);
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error("a video has no picture");
  const rotation = Math.abs(Number(video.side_data_list?.find((d) => "rotation" in d)?.rotation ?? 0));
  const sideways = rotation === 90 || rotation === 270;
  return {
    duration: Number(info.format?.duration ?? 0),
    codec: video.codec_name,
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    hasAudio: Boolean(info.streams?.some((s) => s.codec_type === "audio")),
  };
}

class ToolMissing extends Error {
  constructor() {
    super("This server can't make synced videos (ffmpeg isn't installed).");
  }
}

// --- The cache -------------------------------------------------------------
//
// EXPORT_DIR/<key>/ holds a finished export's files and manifest.json, which
// is written last: a folder without one is unfinished (or from a crash).

// Exports being made, apart from the finished ones the sweep looks at.
const WORK_DIR = path.join(EXPORT_DIR, ".work");

function keyDir(key) {
  return path.join(EXPORT_DIR, key);
}

async function readManifest(key) {
  try {
    return JSON.parse(await fsp.readFile(path.join(keyDir(key), "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

// Exports being sent right now, which the sweep leaves alone.
const inUse = new Map();

/// The finished export's manifest, marked as in use until `release()` is
/// called; null when it isn't ready.
export async function openExport(kind, take) {
  const key = exportKey(kind, take);
  const manifest = await readManifest(key);
  if (!manifest) return null;
  inUse.set(key, (inUse.get(key) ?? 0) + 1);
  // Recently used, for the size sweep.
  const now = new Date();
  await fsp.utimes(path.join(keyDir(key), "manifest.json"), now, now).catch(() => {});
  let released = false;
  return {
    ...manifest,
    path: (file) => path.join(keyDir(key), file),
    release() {
      if (released) return;
      released = true;
      const left = (inUse.get(key) ?? 1) - 1;
      if (left > 0) inUse.set(key, left);
      else inUse.delete(key);
    },
  };
}

/// Drops cached exports made from any of these stored files (their
/// recording was deleted). Never throws.
export async function purgeExportsUsing(fileIds) {
  const gone = new Set(fileIds);
  if (gone.size === 0) return;
  for (const [key, job] of jobs) {
    if (job.take.angles.some((a) => gone.has(a.fileId) || gone.has(a.previewFileId))) {
      job.cancelled = true;
      if (job.state !== "working") jobs.delete(key);
    }
  }
  try {
    for (const key of await fsp.readdir(EXPORT_DIR)) {
      const manifest = await readManifest(key);
      if (manifest?.sources?.some((id) => gone.has(id))) {
        await fsp.rm(keyDir(key), { recursive: true, force: true });
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[exports] purge failed:", err.message);
  }
}

/// Removes unfinished folders, exports older than the cache's age limit,
/// then the least recently used until the cache fits its size limit.
export async function sweepExports({ now = Date.now() } = {}) {
  let names;
  try {
    names = await fsp.readdir(EXPORT_DIR);
  } catch {
    return;
  }
  const entries = [];
  for (const key of names) {
    if (key === ".work" || inUse.has(key)) continue;
    const dir = keyDir(key);
    let stat;
    try {
      stat = await fsp.stat(path.join(dir, "manifest.json"));
    } catch {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (now - stat.mtimeMs > CACHE_MAX_AGE_MS) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    entries.push({ dir, usedAt: stat.mtimeMs, bytes: await folderBytes(dir) });
  }
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  entries.sort((a, b) => a.usedAt - b.usedAt);
  for (const entry of entries) {
    if (total <= CACHE_LIMIT_BYTES) break;
    await fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    total -= entry.bytes;
  }
}

async function folderBytes(dir) {
  let bytes = 0;
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    bytes += (await fsp.stat(path.join(dir, name)).catch(() => ({ size: 0 }))).size;
  }
  return bytes;
}

export function startExportSweep({ everyMs = 60 * 60 * 1000 } = {}) {
  // On start, nothing is being made: clear what a restart left half done.
  fsp.rm(WORK_DIR, { recursive: true, force: true })
    .catch(() => {})
    .then(() => sweepExports())
    .catch(() => {});
  const timer = setInterval(() => sweepExports().catch(() => {}), everyMs);
  timer.unref();
  return timer;
}

// --- Jobs ------------------------------------------------------------------
//
// One take of one kind is one job. They run one at a time: an export takes
// the CPU for minutes, and the server also makes previews.

const jobs = new Map();
const queue = [];
let draining = false;
let current = null;

/// Status of these takes' exports of `kind`, queueing any that aren't made
/// yet. `take`: { sessionId, startedAt, number, angles: [{ userId, name,
/// fileId, previewFileId, startOffsetMs, syncedBy }] }, angles with a file.
export async function ensureExports(kind, takes) {
  const parts = [];
  for (const take of takes) {
    const key = exportKey(kind, take);
    if (await readManifest(key)) {
      parts.push({ state: "ready", fraction: 1 });
      continue;
    }
    let job = jobs.get(key);
    if (job?.state === "failed" && Date.now() - job.failedAt > FAILURE_MEMORY_MS) {
      jobs.delete(key);
      job = null;
    }
    if (!job) {
      job = { key, kind, take, state: "queued", fraction: 0 };
      jobs.set(key, job);
      queue.push(job);
      if (!draining) drain();
    }
    parts.push(job);
  }
  return summarize(parts);
}

function summarize(parts) {
  const failed = parts.find((p) => p.state === "failed");
  const ready = parts.filter((p) => p.state === "ready").length;
  const fraction = parts.reduce((sum, p) => sum + (p.state === "ready" ? 1 : p.fraction), 0);
  return {
    state: failed ? "failed" : ready === parts.length ? "ready"
      : parts.some((p) => p.state === "working") ? "working" : "queued",
    progress: parts.length ? Math.min(1, fraction / parts.length) : 1,
    ready,
    total: parts.length,
    ...(failed ? { error: failed.error } : {}),
    // Other takes (perhaps other people's) ahead of or among these.
    waiting: [current, ...queue].filter((job) => job && !parts.includes(job)).length,
  };
}

async function drain() {
  draining = true;
  while (queue.length > 0) {
    const job = queue.shift();
    if (job.cancelled) continue;
    job.state = "working";
    current = job;
    try {
      await (job.kind === "grid" ? makeGrid(job) : makeSynced(job));
      jobs.delete(job.key);
    } catch (err) {
      job.state = "failed";
      job.failedAt = Date.now();
      job.error = err instanceof ToolMissing || err.userFacing
        ? err.message
        : "Couldn't make this download. Try again in a minute.";
      console.error(`[exports] ${job.kind} ${job.take.sessionId}/${job.take.startedAt}: ${err.message}`);
    }
    current = null;
    await sweepExports().catch(() => {});
  }
  draining = false;
}

function userFacing(message) {
  return Object.assign(new Error(message), { userFacing: true });
}

// Copies stored files into a work folder; returns their paths.
async function fetchSources(work, fileIds) {
  const paths = [];
  for (const [i, fileId] of fileIds.entries()) {
    const file = path.join(work, `source-${i}${path.extname(fileId)}`);
    await pipeline(await storage.open(fileId), fs.createWriteStream(file));
    paths.push(file);
  }
  return paths;
}

async function withWorkFolder(job, make) {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const work = path.join(WORK_DIR, `${job.key}-${crypto.randomUUID().slice(0, 8)}`);
  await fsp.mkdir(work);
  try {
    const manifest = await make(work);
    if (!manifest || job.cancelled || !(await sourcesStillThere(job.take))) return;
    await fsp.writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest));
    await fsp.rm(keyDir(job.key), { recursive: true, force: true });
    await fsp.rename(work, keyDir(job.key));
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// The recording wasn't deleted while its export was being made.
async function sourcesStillThere(take) {
  const ids = take.angles.map((a) => a.fileId);
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM recording_session_videos WHERE file_id = ANY($1)",
    [ids]
  );
  return rows[0].n === ids.length;
}

// Shared by both kinds: the take's sources, probed, and where each is cut.
async function plan(job, work, sourceIds) {
  const files = await fetchSources(work, sourceIds);
  const infos = [];
  for (const file of files) infos.push(await probeMedia(file));
  const window = syncWindow(job.take.angles.map((angle, i) => ({
    startOffsetMs: angle.startOffsetMs,
    duration: infos[i].duration,
  })));
  if (!window) throw userFacing("These angles don't overlap, so they can't be lined up.");
  return { files, infos, window };
}

async function makeSynced(job) {
  const { take } = job;
  await withWorkFolder(job, async (work) => {
    const { files, infos, window } =
      await plan(job, work, take.angles.map((a) => a.fileId));
    const total = window.length * take.angles.length;
    const outputs = [];
    for (const [i, angle] of take.angles.entries()) {
      if (job.cancelled) return null;
      const skip = window.skips[i];
      const file = `angle-${i}.mp4`;
      const args = syncedAngleArgs(files[i], path.join(work, file), {
        skip,
        length: window.length,
        copy: canCopy(skip, infos[i].codec),
      });
      const result = await runTool("ffmpeg", args, {
        onProgress: (done) => {
          job.fraction = Math.min(1, (i * window.length + Math.min(done, window.length)) / total);
        },
      });
      if (result.missing) throw new ToolMissing();
      if (!result.ok) throw new Error(result.err.trim().split("\n").pop() || "ffmpeg failed");
      await fsp.rm(files[i], { force: true });
      outputs.push({ name: angle.name, file, skip, syncedBy: angle.syncedBy ?? null });
    }
    return {
      kind: "synced",
      length: window.length,
      angles: outputs,
      sources: take.angles.map((a) => a.fileId),
    };
  });
}

async function makeGrid(job) {
  const { take } = job;
  // Cells follow the angles' order (by name, from the route), so a grid
  // reads the same way each time.
  await withWorkFolder(job, async (work) => {
    // The preview has the original's timeline, so the same offsets apply.
    const { files, infos, window } =
      await plan(job, work, take.angles.map((a) => a.previewFileId || a.fileId));
    const portrait = infos.filter((info) => info.height > info.width).length > infos.length / 2;
    const audioFrom = infos.findIndex((info) => info.hasAudio);
    const file = "grid.mp4";
    const { args } = gridArgs(files, path.join(work, file), {
      skips: window.skips,
      length: window.length,
      portrait,
      audioFrom: audioFrom === -1 ? null : audioFrom,
    });
    const result = await runTool("ffmpeg", args, {
      onProgress: (done) => { job.fraction = Math.min(1, done / window.length); },
    });
    if (result.missing) throw new ToolMissing();
    if (!result.ok) throw new Error(result.err.trim().split("\n").pop() || "ffmpeg failed");
    return {
      kind: "grid",
      length: window.length,
      file,
      angles: take.angles.map((a, i) => ({ name: a.name, skip: window.skips[i], syncedBy: a.syncedBy ?? null })),
      sources: take.angles.flatMap((a) => [a.fileId, a.previewFileId].filter(Boolean)),
    };
  });
}

// For tests: forget queued and failed jobs.
export function resetExportJobs() {
  queue.length = 0;
  jobs.clear();
}

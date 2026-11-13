// The lined-up session download (every angle side by side), through the
// routes: POST .../exports to make it, GET .../download?kind=synced to fetch
// it. With ffmpeg installed (the server image has it) real videos are made
// and checked frame by frame;
// without it only the routes are. Run against the dev Postgres and the
// local-disk storage driver, like the other route tests.
import "dotenv/config";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const EXPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "synced-download-"));
process.env.EXPORT_DIR = EXPORT_DIR;

vi.mock("../src/email/mailer.js", () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
}));

const { authRouter } = await import("../src/routes/auth.js");
const { groupRouter } = await import("../src/routes/groups.js");
const { recordingsRouter } = await import("../src/routes/recordings.js");
const { UPLOAD_DIR, storage } = await import("../src/storage/index.js");
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/groups", groupRouter);
app.use("/api/recordings", recordingsRouter);

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;
const LOCAL = storage.describe().startsWith("local");

const RUN = `${Date.now()}${process.pid}`;
const GROUP_ID = `sync${RUN}`;
const STARTED_AT = 1_790_000_000_000;
const FPS = 30;

// Three phones filming one "world" whose brightness steps every frame, so a
// frame's brightness says which moment it shows. Each began at a different
// time (its offset) and stopped at a different time. Only Ana's has sound.
const ANGLES = [
  { name: "Ana", offsetMs: 0, seconds: 3.0, audio: true },
  { name: "Ben", offsetMs: 400, seconds: 2.6 },
  { name: "Cy", offsetMs: 200, seconds: 2.0 },
];
// The last to start (Ben, +400 ms) sets the shared start; the last to stop
// (Ana and Ben, at 3.0 s) the end, as in the player. Cy stops first (at
// 0.2 s + 2.0 s, world frame 65) and holds that frame.
const SHARED_START_FRAME = 12;
const SHARED_SECONDS = 2.6;
const CY_LAST_FRAME = 65;
const brightness = (worldFrame) => 16 + ((worldFrame * 4) % 200);

const fileIdFor = (i) => `${RUN}${i}`.padEnd(32, "0") + ".mp4";
// A second recording whose only video is broken: it can't be made, and
// mustn't hold up the first.
const BROKEN = `${RUN}b`.padEnd(32, "0") + ".mp4";

function makeVideo(file, { offsetMs, seconds, audio }) {
  const firstFrame = Math.round((offsetMs / 1000) * FPS);
  const args = [
    "-v", "error", "-y",
    "-f", "lavfi", "-i",
    `color=c=gray:s=320x240:r=${FPS}:d=${seconds},` +
      `geq=lum='16+mod((N+${firstFrame})*4\\,200)':cb=128:cr=128`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`] : []),
    // Keyframes 2 s apart, as on a phone: a copy couldn't cut between them.
    "-c:v", "libx264", "-g", "60", "-pix_fmt", "yuv420p",
    ...(audio ? ["-c:a", "aac"] : []),
    file,
  ];
  const result = spawnSync("ffmpeg", args);
  if (result.status !== 0) throw new Error(String(result.stderr));
}

// Brightness of the frame `at` seconds in, in a w x h box at x, y.
function frameBrightness(file, { x, y, w, h }, at = 0) {
  const result = spawnSync("ffmpeg", [
    "-v", "info", "-ss", String(at), "-i", file, "-frames:v", "1",
    "-vf", `crop=${w}:${h}:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    "-f", "null", "-",
  ]);
  return Number(/YAVG=([\d.]+)/.exec(String(result.stderr))?.[1]);
}

function probe(file) {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
    "-of", "json", file,
  ]);
  const info = JSON.parse(String(result.stdout));
  const video = info.streams.find((s) => s.codec_type === "video");
  return {
    duration: Number(info.format.duration),
    width: video.width,
    height: video.height,
    hasAudio: info.streams.some((s) => s.codec_type === "audio"),
  };
}

// The entries of a stored (uncompressed) zip, by name.
function unzip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.set(name, zip.subarray(data, data + size));
    at += 46 + skip;
  }
  return files;
}

function binary(res, done) {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => done(null, Buffer.concat(chunks)));
}

async function signUp(label, name) {
  const email = `synced-test-${RUN}-${label}@ucf.edu`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name, email, password: "synced-pass-1" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [email]);
  return { cookie: res.headers["set-cookie"], id: res.body.user.id };
}

// Asks for an export until it's made (or fails).
async function waitForExport(query = "") {
  for (let i = 0; i < 300; i += 1) {
    const res = await request(app)
      .post(`/api/recordings/sessions/${sessionId}/exports${query}`)
      .set("Cookie", members[0].cookie);
    expect(res.status).toBe(200);
    if (res.body.state === "ready" || res.body.state === "failed") return res.body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("export never finished");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "synced-out-"));
let members;
let stranger;
let sessionId;

beforeAll(async () => {
  members = [];
  for (const [i, angle] of ANGLES.entries()) members.push(await signUp(`m${i}`, angle.name));
  stranger = await signUp("stranger", "Stranger");
  expect((await request(app).post("/api/groups").set("Cookie", members[0].cookie)
    .send({ id: GROUP_ID, name: "Sync Test", isPublic: true })).status).toBe(201);
  const live = await request(app).post("/api/recordings/sessions/live")
    .set("Cookie", members[0].cookie).send({ groupId: GROUP_ID, name: "Pyramid" });
  sessionId = live.body.session.id;

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const [i, angle] of ANGLES.entries()) {
    const file = path.join(UPLOAD_DIR, fileIdFor(i));
    if (HAS_FFMPEG) makeVideo(file, angle);
    else fs.writeFileSync(file, `video bytes ${i}`);
    await pool.query(
      `INSERT INTO recording_session_videos
         (session_id, user_id, started_at_ms, file_id, start_offset_ms, start_offset_source)
       VALUES ($1, $2, $3, $4, $5, 'frame')`,
      [sessionId, members[i].id, STARTED_AT, fileIdFor(i), angle.offsetMs]
    );
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, BROKEN), "not a video");
  await pool.query(
    `INSERT INTO recording_session_videos (session_id, user_id, started_at_ms, file_id)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, members[0].id, STARTED_AT + 60_000, BROKEN]
  );
}, 60_000);

afterAll(async () => {
  for (const i of ANGLES.keys()) fs.rmSync(path.join(UPLOAD_DIR, fileIdFor(i)), { force: true });
  fs.rmSync(path.join(UPLOAD_DIR, BROKEN), { force: true });
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  await pool.query("DELETE FROM groups WHERE group_id = $1", [GROUP_ID]);
  await pool.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE email LIKE $1)",
    [`synced-test-${RUN}-%`]
  );
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`synced-test-${RUN}-%`]);
  await pool.end();
});

describe("the synced session download", () => {
  it("answers 409 with progress until it's made", async () => {
    if (!LOCAL) return;
    const res = await request(app)
      .get(`/api/recordings/sessions/${sessionId}/download?kind=synced`)
      .set("Cookie", members[0].cookie);
    expect(res.status).toBe(409);
    expect(["queued", "working", "ready", "failed"]).toContain(res.body.status.state);
    expect(res.body.status.progress).toBeGreaterThanOrEqual(0);
  });

  it("refuses unknown kinds", async () => {
    expect((await request(app).get(`/api/recordings/sessions/${sessionId}/download?kind=grid`)
      .set("Cookie", members[0].cookie)).status).toBe(400);
  });

  it("can't find a recording that isn't there", async () => {
    const path = `/api/recordings/sessions/${sessionId}`;
    expect((await request(app).post(`${path}/exports?startedAt=123`)
      .set("Cookie", members[0].cookie)).status).toBe(404);
    expect((await request(app).get(`${path}/download?kind=synced&startedAt=123`)
      .set("Cookie", members[0].cookie)).status).toBe(404);
  });

  it("is only for members of the session's group", async () => {
    expect((await request(app).post(`/api/recordings/sessions/${sessionId}/exports`)
      .set("Cookie", stranger.cookie)).status).toBe(404);
    expect((await request(app).get(`/api/recordings/sessions/${sessionId}/download?kind=synced`)
      .set("Cookie", stranger.cookie)).status).toBe(404);
  });

  it("says why when this server can't make it", async () => {
    if (HAS_FFMPEG || !LOCAL) return;
    const status = await waitForExport();
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/ffmpeg/);
  });

  it.skipIf(!HAS_FFMPEG || !LOCAL)("puts every angle side by side, lined up", async () => {
    // Ready, with the broken recording left out.
    expect(await waitForExport()).toMatchObject({ state: "ready", progress: 1, skipped: 1 });

    const res = await request(app)
      .get(`/api/recordings/sessions/${sessionId}/download?kind=synced`)
      .set("Cookie", members[0].cookie)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/filename="Pyramid \d{4}-\d{2}-\d{2} synced\.zip"/);

    const files = unzip(res.body);
    expect([...files.keys()].sort()).toEqual(["About these videos.txt", "Recording 001.mp4"]);
    const about = String(files.get("About these videos.txt"));
    expect(about).toContain("Ana: 0.400 s trimmed from the start (first frame)");
    expect(about).toContain("Ben: 0.000 s trimmed from the start (first frame)");
    expect(about).toContain("Recording 002: not included.");

    const grid = path.join(work, "Recording 001.mp4");
    fs.writeFileSync(grid, files.get("Recording 001.mp4"));
    // Three landscape angles: 2x2 cells of 640x360, Ana's sound, the shared length.
    const info = probe(grid);
    expect(info).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    expect(Math.abs(info.duration - SHARED_SECONDS)).toBeLessThan(0.1);
    // The middle of each cell (Ana, Ben, then Cy centred on the last row).
    const cells = [[0, 0], [640, 0], [320, 360]].map(([x, y]) => ({ x: x + 220, y: y + 80, w: 200, h: 200 }));
    // Every cell starts on the same moment (frame-exact, though 12 frames is
    // mid-GOP for Ana)...
    for (const cell of cells) {
      expect(Math.abs(frameBrightness(grid, cell) - brightness(SHARED_START_FRAME))).toBeLessThan(2);
    }
    // ...and after Cy stopped, Ana and Ben play on while Cy holds his last frame.
    const at = 2.3;
    const now = SHARED_START_FRAME + Math.round(at * FPS);
    expect(Math.abs(frameBrightness(grid, cells[0], at) - brightness(now))).toBeLessThan(2);
    expect(Math.abs(frameBrightness(grid, cells[1], at) - brightness(now))).toBeLessThan(2);
    expect(Math.abs(frameBrightness(grid, cells[2], at) - brightness(CY_LAST_FRAME))).toBeLessThan(2);
  }, 60_000);

  it.skipIf(!HAS_FFMPEG || !LOCAL)("gives just one recording's video, not a zip", async () => {
    const path = `/api/recordings/sessions/${sessionId}`;
    const status = await request(app).post(`${path}/exports?startedAt=${STARTED_AT}`)
      .set("Cookie", members[0].cookie);
    expect(status.body).toMatchObject({ state: "ready", progress: 1 });
    expect(status.body.skipped).toBeUndefined();

    const res = await request(app)
      .get(`${path}/download?kind=synced&startedAt=${STARTED_AT}`)
      .set("Cookie", members[0].cookie)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-disposition"])
      .toMatch(/filename="Pyramid \d{4}-\d{2}-\d{2} Recording 001\.mp4"/);
    const video = `${work}/one.mp4`;
    fs.writeFileSync(video, res.body);
    expect(probe(video)).toMatchObject({ width: 1280, height: 720, hasAudio: true });

    // The broken one, asked for on its own: says it couldn't be made.
    expect((await waitForExport(`?startedAt=${STARTED_AT + 60_000}`)).state).toBe("failed");
  }, 60_000);
});

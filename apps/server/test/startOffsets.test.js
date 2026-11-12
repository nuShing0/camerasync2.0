// Each device reports when its camera really started (actualStartedAt) next
// to the shared start (startedAt); playback lines the angles up by the
// difference. Run against the dev Postgres like the other route tests.
import "dotenv/config";

import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/email/mailer.js", () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
}));

const { authRouter } = await import("../src/routes/auth.js");
const { groupRouter } = await import("../src/routes/groups.js");
const { recordingsRouter } = await import("../src/routes/recordings.js");
const { startOffsetMs } = await import("../src/recordings/startOffset.js");
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/groups", groupRouter);
app.use("/api/recordings", recordingsRouter);

const RUN = `${Date.now()}${process.pid}`;
const GROUP_ID = `offsets${RUN}`;
const EMAIL = `offsets-test-${RUN}@ucf.edu`;

let cookie;
let sessionId;

beforeAll(async () => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Coach", email: EMAIL, password: "offsets-test-pass-1" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [EMAIL]);
  cookie = res.headers["set-cookie"];

  const group = await request(app)
    .post("/api/groups")
    .set("Cookie", cookie)
    .send({ id: GROUP_ID, name: "Offsets", isPublic: true });
  expect(group.status).toBe(201);

  const live = await request(app)
    .post("/api/recordings/sessions/live")
    .set("Cookie", cookie)
    .send({ groupId: GROUP_ID, name: "Sync check" });
  expect(live.status).toBe(201);
  sessionId = live.body.session.id;
});

afterAll(async () => {
  await pool.query("DELETE FROM groups WHERE group_id = $1", [GROUP_ID]);
  await pool.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE email = $1)",
    [EMAIL]
  );
  await pool.query("DELETE FROM users WHERE email = $1", [EMAIL]);
  await pool.end();
});

describe("startOffsetMs", () => {
  it("is how much later the camera really started", () => {
    expect(startOffsetMs(1_000_870, 1_000_000)).toBe(870);
    expect(startOffsetMs("999900", 1_000_000)).toBe(-100);
  });

  it("is unknown when missing or implausible", () => {
    for (const actual of [undefined, null, "", "soon", 1.5]) {
      expect(startOffsetMs(actual, 1_000_000)).toBeNull();
    }
    expect(startOffsetMs(1_000_000 + 31_000, 1_000_000)).toBeNull();
    expect(startOffsetMs(1_000_000 - 11_000, 1_000_000)).toBeNull();
  });
});

describe("saving a video's real start", () => {
  const save = (body) =>
    request(app)
      .post(`/api/recordings/sessions/${sessionId}/videos`)
      .set("Cookie", cookie)
      .send(body);
  const videosOf = async () =>
    (
      await request(app)
        .get(`/api/recordings/sessions/${sessionId}/videos`)
        .set("Cookie", cookie)
    ).body.recordings;

  it("returns the offset with the take's videos", async () => {
    const startedAt = Date.now() - 20_000;
    expect((await save({ startedAt, actualStartedAt: startedAt + 870 })).status).toBe(200);

    const take = (await videosOf()).find((r) => r.startedAt === startedAt);
    expect(take.videos[0].startOffsetMs).toBe(870);
  });

  it("keeps the first offset when the save is retried", async () => {
    const startedAt = Date.now() - 15_000;
    await save({ startedAt, actualStartedAt: startedAt + 400 });
    await save({ startedAt, actualStartedAt: startedAt + 9_000 });

    const take = (await videosOf()).find((r) => r.startedAt === startedAt);
    expect(take.videos[0].startOffsetMs).toBe(400);
  });

  it("takes a first-frame time over a rougher one, and keeps it", async () => {
    const startedAt = Date.now() - 2_000;
    await save({ startedAt, actualStartedAt: startedAt + 100, startClock: "call" });
    await save({ startedAt, actualStartedAt: startedAt + 640, startClock: "frame" });
    // A later, rougher save can't replace it.
    await save({ startedAt, actualStartedAt: startedAt + 90, startClock: "call" });

    const take = (await videosOf()).find((r) => r.startedAt === startedAt);
    expect(take.videos[0].startOffsetMs).toBe(640);
  });

  it("is null for clients that don't report it", async () => {
    const startedAt = Date.now() - 10_000;
    expect((await save({ startedAt })).status).toBe(200);

    const take = (await videosOf()).find((r) => r.startedAt === startedAt);
    expect(take.videos[0].startOffsetMs).toBeNull();
  });
});

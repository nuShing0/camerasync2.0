// GET /api/notifications and POST /api/notifications/seen: comments, joins
// and practices starting in the user's groups. Run against the dev Postgres
// like the other route tests; unique ids per run, cleaned up after.
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
const { notificationsRouter } = await import("../src/routes/notifications.js");
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/groups", groupRouter);
app.use("/api/recordings", recordingsRouter);
app.use("/api/notifications", notificationsRouter);

const RUN = `${Date.now()}${process.pid}`;
const GROUP_ID = `notes${RUN}`;
const OTHER_GROUP_ID = `notesx${RUN}`;

async function signUp(label) {
  const email = `notifications-test-${RUN}-${label.toLowerCase()}@ucf.edu`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: label, email, password: "notifications-test-1" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [email]);
  return { cookie: res.headers["set-cookie"], id: res.body.user.id };
}

const feed = (user) => request(app).get("/api/notifications").set("Cookie", user.cookie);

let coach;
let dancer;
let stranger;
let sessionId;

beforeAll(async () => {
  coach = await signUp("Coach");
  dancer = await signUp("Dancer");
  stranger = await signUp("Stranger");

  let inviteCode;
  for (const [user, id] of [[coach, GROUP_ID], [stranger, OTHER_GROUP_ID]]) {
    const created = await request(app)
      .post("/api/groups")
      .set("Cookie", user.cookie)
      .send({ id, name: `Group ${id}` });
    expect(created.status).toBe(201);
    if (id === GROUP_ID) inviteCode = created.body.group.inviteCode;
  }

  // The dancer joins, then the coach starts a practice and the dancer
  // comments on it. Meanwhile the stranger is busy in a group of their own.
  const joined = await request(app)
    .post(`/api/groups/invites/${inviteCode}/join`)
    .set("Cookie", dancer.cookie)
    .send({});
  expect(joined.status).toBe(201);

  const started = await request(app)
    .post("/api/recordings/sessions/live")
    .set("Cookie", coach.cookie)
    .send({ groupId: GROUP_ID, name: "Stunt practice" });
  expect(started.status).toBe(201);
  sessionId = started.body.session.id;

  const note = await request(app)
    .post(`/api/recordings/sessions/${sessionId}/notes`)
    .set("Cookie", dancer.cookie)
    .send({ body: "Watch the arms at 0:12", startedAt: Date.now(), videoTimeMs: 12000 });
  expect(note.status).toBe(201);

  const elsewhere = await request(app)
    .post("/api/recordings/sessions/live")
    .set("Cookie", stranger.cookie)
    .send({ groupId: OTHER_GROUP_ID, name: "Private practice" });
  expect(elsewhere.status).toBe(201);
});

afterAll(async () => {
  await pool.query("DELETE FROM recording_sessions WHERE group_id IN ($1, $2)", [
    GROUP_ID,
    OTHER_GROUP_ID,
  ]);
  await pool.query("DELETE FROM groups WHERE group_id IN ($1, $2)", [GROUP_ID, OTHER_GROUP_ID]);
  await pool.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE email LIKE $1)",
    [`notifications-test-${RUN}-%`]
  );
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`notifications-test-${RUN}-%`]);
  await pool.end();
});

describe("GET /api/notifications", () => {
  it("needs a signed-in user", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });

  it("tells the coach who joined and who commented, newest first", async () => {
    const res = await feed(coach);
    expect(res.status).toBe(200);
    const types = res.body.notifications.map((n) => n.type);
    expect(types).toEqual(["comment", "join"]);

    const [comment, join] = res.body.notifications;
    expect(comment).toMatchObject({
      unread: true,
      actor: { id: dancer.id, name: "Dancer" },
      group: { id: GROUP_ID },
      session: { id: sessionId, name: "Stunt practice" },
      comment: { body: "Watch the arms at 0:12", videoTimeMs: 12000 },
    });
    expect(join).toMatchObject({ actor: { name: "Dancer" }, group: { id: GROUP_ID } });
    expect(join).not.toHaveProperty("session");
    expect(res.body.unreadCount).toBe(2);
  });

  it("tells the dancer the practice started, but not about their own actions", async () => {
    const res = await feed(dancer);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({
      type: "session",
      actor: { id: coach.id, name: "Coach" },
      session: { id: sessionId, name: "Stunt practice", status: "active" },
    });
  });

  it("shows nothing from groups the user isn't in", async () => {
    const res = await feed(stranger);
    expect(res.body.notifications).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  it("drops a deleted comment from the feed", async () => {
    const { rows } = await pool.query(
      "SELECT note_id FROM session_notes WHERE session_id = $1",
      [sessionId]
    );
    const removed = await request(app)
      .delete(`/api/recordings/sessions/${sessionId}/notes/${rows[0].note_id}`)
      .set("Cookie", dancer.cookie);
    expect(removed.status).toBeLessThan(300);

    const res = await feed(coach);
    expect(res.body.notifications.map((n) => n.type)).toEqual(["join"]);
  });
});

describe("POST /api/notifications/seen", () => {
  it("marks everything so far as read", async () => {
    const seen = await request(app)
      .post("/api/notifications/seen")
      .set("Cookie", coach.cookie);
    expect(seen.status).toBe(204);

    const res = await feed(coach);
    expect(res.body.notifications.length).toBeGreaterThan(0);
    expect(res.body.notifications.every((n) => !n.unread)).toBe(true);
    expect(res.body.unreadCount).toBe(0);
  });
});

describe("category switches", () => {
  it("leave everything in the feed when only push is off", async () => {
    await request(app).patch("/api/auth/me").set("Cookie", coach.cookie)
      .send({ notificationPrefs: { push: false } });
    const res = await feed(coach);
    expect(res.body.notifications.map((n) => n.type)).toEqual(["join"]);
  });

  it("hide a category from the feed when it's turned off", async () => {
    await request(app).patch("/api/auth/me").set("Cookie", coach.cookie)
      .send({ notificationPrefs: { joins: false } });
    const res = await feed(coach);
    expect(res.body.notifications).toEqual([]);

    // The dancer's own switches are untouched.
    expect((await feed(dancer)).body.notifications.map((n) => n.type)).toEqual(["session"]);
  });
});

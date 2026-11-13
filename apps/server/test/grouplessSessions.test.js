// Sessions without a group can't be started any more (every session is in a
// group, whose invite is the one code people share), but the old ones keep
// working: anyone with the code can join; only the creator and the people
// who joined can see it. Run against the dev Postgres like the other route
// tests.
import "dotenv/config";

import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/email/mailer.js", () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
}));
// No socket server in tests; ending a session just closes its room.
vi.mock("../src/sockets/websocket.js", () => ({
  closeSessionSocket: vi.fn(async () => {}),
  removeMemberFromGroupSessions: vi.fn(async () => {}),
}));

const { authRouter } = await import("../src/routes/auth.js");
const { recordingsRouter } = await import("../src/routes/recordings.js");
const { getSessionRole } = await import("../src/middleware/groupRole.js");
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/recordings", recordingsRouter);

const RUN = `${Date.now()}${process.pid}`;

async function signUp(label) {
  const email = `groupless-test-${RUN}-${label}@ucf.edu`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: label, email, password: "groupless-pass-1" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [email]);
  return { cookie: res.headers["set-cookie"], id: res.body.user.id };
}

const listOf = async (user) =>
  (await request(app).get("/api/recordings/sessions").set("Cookie", user.cookie)).body.sessions;

let host;
let friend;
let stranger;
let session;

beforeAll(async () => {
  host = await signUp("host");
  friend = await signUp("friend");
  stranger = await signUp("stranger");
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM recording_sessions WHERE created_by IN
       (SELECT user_id FROM users WHERE email LIKE $1)`,
    [`groupless-test-${RUN}-%`]
  );
  await pool.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE email LIKE $1)",
    [`groupless-test-${RUN}-%`]
  );
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`groupless-test-${RUN}-%`]);
  await pool.end();
});

describe("sessions without a group", () => {
  it("can't be started any more", async () => {
    const res = await request(app)
      .post("/api/recordings/sessions/live")
      .set("Cookie", host.cookie)
      .send({ name: "Pickup practice" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/group/);
  });

  it("from before still show for their host", async () => {
    // One started back when they could be, as that route did then.
    const id = `g${RUN}`.slice(-6).replace(/^\d/, "g");
    await pool.query(
      `INSERT INTO recording_sessions (id, group_id, name, scheduled_at, created_by, status)
       VALUES ($1, NULL, 'Pickup practice', NOW(), $2, 'active')`,
      [id, host.id]
    );
    for (const table of ["recording_session_members", "recording_session_participants"]) {
      await pool.query(`INSERT INTO ${table} (session_id, user_id) VALUES ($1, $2)`, [id, host.id]);
    }
    session = { id };
    expect((await listOf(host)).map((s) => s.id)).toContain(session.id);
    expect(await getSessionRole(session.id, host.id)).toBe("owner");
  });

  it("are hidden from people who haven't joined", async () => {
    expect((await listOf(friend)).map((s) => s.id)).not.toContain(session.id);
    const videos = await request(app)
      .get(`/api/recordings/sessions/${session.id}/videos`)
      .set("Cookie", friend.cookie);
    expect(videos.status).toBe(404);
    expect(await getSessionRole(session.id, friend.id)).toBeNull();
  });

  it("can be joined by anyone with the code", async () => {
    const res = await request(app)
      .post(`/api/recordings/sessions/${session.id}/join`)
      .set("Cookie", friend.cookie);
    expect(res.status).toBe(200);
    expect(res.body.session.isJoined).toBe(true);
    expect((await listOf(friend)).map((s) => s.id)).toContain(session.id);
    expect(await getSessionRole(session.id, friend.id)).toBe("member");

    const videos = await request(app)
      .get(`/api/recordings/sessions/${session.id}/videos`)
      .set("Cookie", friend.cookie);
    expect(videos.status).toBe(200);
  });

  it("still keep out everyone else", async () => {
    expect((await listOf(stranger)).map((s) => s.id)).not.toContain(session.id);
  });

  it("let members comment but not delete the host's comments", async () => {
    const startedAt = Date.now() - 5_000;
    expect((await request(app).post(`/api/recordings/sessions/${session.id}/notes`)
      .set("Cookie", host.cookie)
      .send({ body: "From the host", startedAt, videoTimeMs: 0 })).status).toBe(201);
    expect((await request(app).post(`/api/recordings/sessions/${session.id}/notes`)
      .set("Cookie", friend.cookie)
      .send({ body: "From a friend", startedAt, videoTimeMs: 1000 })).status).toBe(201);

    const notes = (await request(app)
      .get(`/api/recordings/sessions/${session.id}/notes?startedAt=${startedAt}`)
      .set("Cookie", friend.cookie)).body.notes;
    const byBody = Object.fromEntries(notes.map((n) => [n.body, n]));
    expect(byBody["From a friend"].canDelete).toBe(true);
    expect(byBody["From the host"].canDelete).toBe(false);
  });

  it("can be ended by the host but not by a member", async () => {
    const byFriend = await request(app)
      .patch(`/api/recordings/sessions/${session.id}/end`)
      .set("Cookie", friend.cookie);
    expect(byFriend.status).toBe(403);
    const byHost = await request(app)
      .patch(`/api/recordings/sessions/${session.id}/end`)
      .set("Cookie", host.cookie);
    expect(byHost.status).toBe(200);
  });
});

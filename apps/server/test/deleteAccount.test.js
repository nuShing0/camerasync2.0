// DELETE /api/auth/me: deleting your own account, which both app stores
// require. Runs against the dev Postgres like account.test.js; unique ids
// per run, cleaned up after.
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
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/groups", groupRouter);
app.use("/api/recordings", recordingsRouter);

const RUN = `${Date.now()}${process.pid}`;
const OWNER = `delete-owner-${RUN}@ucf.edu`;
const MEMBER = `delete-member-${RUN}@ucf.edu`;
const PASSWORD = "delete-test-pass-1";
const GROUP_ID = `del${RUN}`;

const signUp = async (email) => {
  const res = await request(app).post("/api/auth/register")
    .send({ name: "Delete Test", email, password: PASSWORD });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [email]);
  return res.headers["set-cookie"];
};

let ownerCookie;
let memberCookie;
let sessionId;

beforeAll(async () => {
  ownerCookie = await signUp(OWNER);
  memberCookie = await signUp(MEMBER);
  expect((await request(app).post("/api/groups").set("Cookie", ownerCookie)
    .send({ id: GROUP_ID, name: "Delete Test Team", isPublic: true })).status).toBe(201);
  // A session the member started (an old one without a group), to outlive
  // them.
  const member = await pool.query("SELECT user_id FROM users WHERE email = $1", [MEMBER]);
  sessionId = `d${RUN}`.slice(-6).replace(/^\d/, "d");
  await pool.query(
    `INSERT INTO recording_sessions (id, group_id, name, scheduled_at, created_by, status)
     VALUES ($1, NULL, 'Left behind', NOW(), $2, 'active')`,
    [sessionId, member.rows[0].user_id]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM recording_sessions WHERE id = $1", [sessionId]);
  await pool.query("DELETE FROM groups WHERE group_id = $1", [GROUP_ID]);
  await pool.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE email = ANY($1))",
    [[OWNER, MEMBER]]
  );
  await pool.query("DELETE FROM users WHERE email = ANY($1)", [[OWNER, MEMBER]]);
  await pool.end();
});

describe("DELETE /api/auth/me", () => {
  it("needs the password, and the right one", async () => {
    expect((await request(app).delete("/api/auth/me").set("Cookie", memberCookie)
      .send({})).status).toBe(400);
    const wrong = await request(app).delete("/api/auth/me").set("Cookie", memberCookie)
      .send({ password: "not-the-password" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("Password is incorrect.");
  });

  it("asks a group's owner to hand it over first", async () => {
    const res = await request(app).delete("/api/auth/me").set("Cookie", ownerCookie)
      .send({ password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Delete Test Team");
    expect(res.body.groups).toEqual([{ id: GROUP_ID, name: "Delete Test Team" }]);
    // Still there.
    expect((await request(app).get("/api/auth/me").set("Cookie", ownerCookie)).status).toBe(200);
  });

  it("deletes the account and signs it out, keeping the session it started", async () => {
    const res = await request(app).delete("/api/auth/me").set("Cookie", memberCookie)
      .send({ password: PASSWORD });
    expect(res.status).toBe(204);

    expect((await request(app).get("/api/auth/me").set("Cookie", memberCookie)).status).toBe(401);
    const { rowCount } = await pool.query("SELECT 1 FROM users WHERE email = $1", [MEMBER]);
    expect(rowCount).toBe(0);
    const { rows } = await pool.query(
      "SELECT created_by FROM recording_sessions WHERE id = $1", [sessionId]);
    expect(rows).toEqual([{ created_by: null }]);
  });

  it("needs a signed-in user", async () => {
    expect((await request(app).delete("/api/auth/me").send({ password: PASSWORD })).status)
      .toBe(401);
  });
});

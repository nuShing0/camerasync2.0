// What owners, admins, members and viewers may do to a group and its
// sessions: leaving, owner-only settings, handing the group over, deleting
// it, and admins ending, cancelling or deleting sessions they didn't start.
// Runs against the dev Postgres like auth.test.js.
import "dotenv/config";

import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/email/mailer.js", () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
}));
// Sessions talk to the socket server; these tests only care about the rows.
vi.mock("../src/sockets/websocket.js", () => ({
  closeSessionSocket: vi.fn(async () => {}),
  removeMemberFromGroupSessions: vi.fn(async () => {}),
  getRecordingSession: vi.fn(),
}));

const { authRouter } = await import("../src/routes/auth.js");
const { groupRouter } = await import("../src/routes/groups.js");
const { recordingsRouter } = await import("../src/routes/recordings.js");
const { requireAuth } = await import("../src/middleware/requireAuth.js");
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/groups", requireAuth, groupRouter);
app.use("/api/recordings", recordingsRouter);

const RUN = `${Date.now()}${process.pid}`;
const GROUP = `rules${RUN}`;
const people = {};

async function signUp(label) {
  const email = `rules-test-${RUN}-${label}@ucf.edu`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: label, email, password: "rules-test-pass-1" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [email]);
  return { cookie: res.headers["set-cookie"], id: Number(res.body.user.id) };
}

async function session(status, createdBy) {
  const id = Math.random().toString(36).slice(2, 8).padEnd(6, "x");
  await pool.query(
    `INSERT INTO recording_sessions (id, group_id, name, scheduled_at, created_by, status)
     VALUES ($1, $2, 'Practice', NOW() + interval '1 day', $3, $4)`,
    [id, GROUP, createdBy, status]
  );
  return id;
}

beforeAll(async () => {
  for (const label of ["owner", "admin", "member", "viewer", "coach2"]) {
    people[label] = await signUp(label);
  }
  const created = await request(app)
    .post("/api/groups")
    .set("Cookie", people.owner.cookie)
    .send({ id: GROUP, name: "Rules Test" });
  expect(created.status).toBe(201);
  const { inviteCode } = created.body.group;
  for (const label of ["admin", "member", "viewer", "coach2"]) {
    const joined = await request(app)
      .post(`/api/groups/invites/${inviteCode}/join`)
      .set("Cookie", people[label].cookie)
      .send({});
    expect(joined.status).toBe(201);
  }
  await pool.query(
    "UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND user_id = ANY($2)",
    [GROUP, [people.admin.id, people.coach2.id]]
  );
  await pool.query(
    "UPDATE group_members SET role = 'viewer' WHERE group_id = $1 AND user_id = $2",
    [GROUP, people.viewer.id]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM groups WHERE group_id LIKE $1", [`${GROUP}%`]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`rules-test-${RUN}-%`]);
  await pool.end();
});

describe("owner-only group settings", () => {
  it("lets the owner rename the group", async () => {
    const res = await request(app)
      .patch(`/api/groups/${GROUP}`)
      .set("Cookie", people.owner.cookie)
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.group).toMatchObject({ name: "Renamed" });
  });

  it("refuses admins: they can change the color, not the name", async () => {
    const rename = await request(app)
      .patch(`/api/groups/${GROUP}`)
      .set("Cookie", people.admin.cookie)
      .send({ name: "Admin was here" });
    expect(rename.status).toBe(403);
    const color = await request(app)
      .patch(`/api/groups/${GROUP}`)
      .set("Cookie", people.admin.cookie)
      .send({ primaryColor: "#16a34a" });
    expect(color.status).toBe(200);
  });
});

describe("sessions: admins can end, cancel and delete any session", () => {
  it("lets another admin cancel a session they didn't schedule", async () => {
    const id = await session("scheduled", people.admin.id);
    const res = await request(app)
      .patch(`/api/recordings/sessions/${id}/cancel`)
      .set("Cookie", people.coach2.cookie);
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("cancelled");
  });

  it("lets the owner end a live session someone else is hosting", async () => {
    const id = await session("active", people.admin.id);
    const res = await request(app)
      .patch(`/api/recordings/sessions/${id}/end`)
      .set("Cookie", people.owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("complete");
  });

  it("refuses members", async () => {
    const id = await session("scheduled", people.admin.id);
    const res = await request(app)
      .patch(`/api/recordings/sessions/${id}/cancel`)
      .set("Cookie", people.member.cookie);
    expect(res.status).toBe(403);
  });

  it("lets admins delete a finished session, but not members", async () => {
    const id = await session("complete", people.owner.id);
    const byMember = await request(app)
      .delete(`/api/recordings/sessions/${id}`)
      .set("Cookie", people.member.cookie);
    expect(byMember.status).toBe(403);
    const byAdmin = await request(app)
      .delete(`/api/recordings/sessions/${id}`)
      .set("Cookie", people.admin.cookie);
    expect(byAdmin.status).toBe(200);
  });
});

describe("leaving and handing over", () => {
  it("lets a member or viewer leave", async () => {
    const res = await request(app)
      .post(`/api/groups/${GROUP}/leave`)
      .set("Cookie", people.viewer.cookie);
    expect(res.status).toBe(200);
    const roster = await request(app)
      .get(`/api/groups/${GROUP}/members`)
      .set("Cookie", people.owner.cookie);
    expect(roster.body.members.map((m) => m.id)).not.toContain(people.viewer.id);
  });

  it("makes the owner hand the group over before leaving", async () => {
    const leave = await request(app)
      .post(`/api/groups/${GROUP}/leave`)
      .set("Cookie", people.owner.cookie);
    expect(leave.status).toBe(409);

    const notOwner = await request(app)
      .post(`/api/groups/${GROUP}/transfer`)
      .set("Cookie", people.admin.cookie)
      .send({ userId: people.member.id });
    expect(notOwner.status).toBe(403);

    const transfer = await request(app)
      .post(`/api/groups/${GROUP}/transfer`)
      .set("Cookie", people.owner.cookie)
      .send({ userId: people.member.id });
    expect(transfer.status).toBe(200);
    expect(transfer.body.group.owner).toBe(people.member.id);

    const leaveAfter = await request(app)
      .post(`/api/groups/${GROUP}/leave`)
      .set("Cookie", people.owner.cookie);
    expect(leaveAfter.status).toBe(200);
  });
});

describe("deleting a group", () => {
  it("is only for the owner", async () => {
    const byAdmin = await request(app)
      .delete(`/api/groups/${GROUP}`)
      .set("Cookie", people.admin.cookie);
    expect(byAdmin.status).toBe(403);

    // The member was handed the group above.
    const byOwner = await request(app)
      .delete(`/api/groups/${GROUP}`)
      .set("Cookie", people.member.cookie);
    expect(byOwner.status).toBe(200);
    const { rowCount } = await pool.query("SELECT 1 FROM groups WHERE group_id = $1", [GROUP]);
    expect(rowCount).toBe(0);
  });
});

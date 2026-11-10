// Invites and join requests: every group has an invite code (its link and
// QR), the preview behind it shows the group before joining, admins can swap
// it for a new one, and people without one can ask to join by the group's ID.
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

const { authRouter } = await import("../src/routes/auth.js");
const { groupRouter, normalizeInviteCode } = await import("../src/routes/groups.js");
const { notificationsRouter } = await import("../src/routes/notifications.js");
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/groups", groupRouter);
app.use("/api/notifications", notificationsRouter);

const RUN = `${Date.now()}${process.pid}`;
const GROUP = `invite${RUN}`;
let owner;
let guest;
let asker;
let code;

async function signUp(label) {
  const email = `invite-test-${RUN}-${label}@ucf.edu`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: label, email, password: "invite-test-pass-1" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [email]);
  return res.headers["set-cookie"];
}

beforeAll(async () => {
  owner = await signUp("owner");
  guest = await signUp("guest");
  asker = await signUp("asker");
  const created = await request(app)
    .post("/api/groups")
    .set("Cookie", owner)
    .send({ id: GROUP, name: "Invite Test", primaryColor: "#7c3aed" });
  expect(created.status).toBe(201);
  code = created.body.group.inviteCode;
});

afterAll(async () => {
  await pool.query("DELETE FROM groups WHERE group_id = $1", [GROUP]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`invite-test-${RUN}-%`]);
  await pool.end();
});

describe("invites", () => {
  it("come with every group: a six-character code and a link to the web join page", async () => {
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    const res = await request(app).get("/api/groups").set("Cookie", owner);
    const group = res.body.groups.find((g) => g.id === GROUP);
    expect(group.inviteCode).toBe(code);
    expect(group.inviteUrl).toMatch(new RegExp(`/join/${code}$`));
    expect(group).not.toHaveProperty("isPublic");
  });

  it("read codes as people type them", () => {
    expect(normalizeInviteCode(" abc-d2f ")).toBe("ABCD2F");
    // Letters that look like 0 and 1 count as them (old codes can hold both).
    expect(normalizeInviteCode("o1-iL")).toBe("0111");
  });

  it("preview the group for someone not in it yet, typed with a dash in any case", async () => {
    const typed = `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase();
    const res = await request(app).get(`/api/groups/invites/${typed}`).set("Cookie", guest);
    expect(res.status).toBe(200);
    expect(res.body.group).toEqual({
      id: GROUP,
      name: "Invite Test",
      primaryColor: "#7c3aed",
      memberCount: 1,
      isMember: false,
    });
  });

  it("join the group, and joining again just returns it", async () => {
    const joined = await request(app).post(`/api/groups/invites/${code}/join`).set("Cookie", guest);
    expect(joined.status).toBe(201);
    expect(joined.body.group).toMatchObject({ id: GROUP, role: "member" });

    const again = await request(app).post(`/api/groups/invites/${code}/join`).set("Cookie", guest);
    expect(again.status).toBe(200);

    const preview = await request(app).get(`/api/groups/invites/${code}`).set("Cookie", guest);
    expect(preview.body.group).toMatchObject({ isMember: true, memberCount: 2 });
  });

  it("can't be found by a wrong code", async () => {
    const res = await request(app).get("/api/groups/invites/ZZZZZZZ").set("Cookie", guest);
    expect(res.status).toBe(404);
  });

  it("are reset by admins only, and the old code stops working", async () => {
    const denied = await request(app).post(`/api/groups/${GROUP}/invite/reset`).set("Cookie", guest);
    expect(denied.status).toBe(403);

    const reset = await request(app).post(`/api/groups/${GROUP}/invite/reset`).set("Cookie", owner);
    expect(reset.status).toBe(200);
    expect(reset.body.group.inviteCode).not.toBe(code);

    const old = await request(app).get(`/api/groups/invites/${code}`).set("Cookie", asker);
    expect(old.status).toBe(404);
    code = reset.body.group.inviteCode;
  });
});

describe("join requests", () => {
  it("need the exact group ID", async () => {
    const partial = await request(app)
      .post("/api/groups/requests").set("Cookie", asker).send({ groupId: GROUP.slice(0, -2) });
    expect(partial.status).toBe(404);
  });

  it("wait for an admin, who sees them and a notification", async () => {
    const asked = await request(app)
      .post("/api/groups/requests").set("Cookie", asker).send({ groupId: GROUP.toUpperCase() });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: "requested", group: { id: GROUP } });

    const notJoined = await request(app).get("/api/groups").set("Cookie", asker);
    expect(notJoined.body.groups.some((g) => g.id === GROUP)).toBe(false);

    expect((await request(app).get(`/api/groups/${GROUP}/requests`).set("Cookie", guest)).status).toBe(403);
    const list = await request(app).get(`/api/groups/${GROUP}/requests`).set("Cookie", owner);
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0].name).toBe("asker");

    const feed = await request(app).get("/api/notifications").set("Cookie", owner);
    expect(feed.body.notifications.some((n) => n.type === "request" && n.group.id === GROUP)).toBe(true);
    // Not for members who can't answer it.
    const memberFeed = await request(app).get("/api/notifications").set("Cookie", guest);
    expect(memberFeed.body.notifications.some((n) => n.type === "request")).toBe(false);
  });

  it("let the asker in once approved", async () => {
    const list = await request(app).get(`/api/groups/${GROUP}/requests`).set("Cookie", owner);
    const userId = list.body.requests[0].userId;
    const approved = await request(app)
      .post(`/api/groups/${GROUP}/requests/${userId}/approve`).set("Cookie", owner);
    expect(approved.status).toBe(200);

    const groups = await request(app).get("/api/groups").set("Cookie", asker);
    expect(groups.body.groups.find((g) => g.id === GROUP)).toMatchObject({ role: "member" });
    const after = await request(app).get(`/api/groups/${GROUP}/requests`).set("Cookie", owner);
    expect(after.body.requests).toHaveLength(0);
  });

  it("say so when you're already in the group", async () => {
    const res = await request(app)
      .post("/api/groups/requests").set("Cookie", asker).send({ groupId: GROUP });
    expect(res.body.status).toBe("member");
  });

  it("are gone once declined", async () => {
    await pool.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = (SELECT user_id FROM users WHERE email = $2)",
      [GROUP, `invite-test-${RUN}-asker@ucf.edu`]);
    await request(app).post("/api/groups/requests").set("Cookie", asker).send({ groupId: GROUP });
    const list = await request(app).get(`/api/groups/${GROUP}/requests`).set("Cookie", owner);
    const declined = await request(app)
      .delete(`/api/groups/${GROUP}/requests/${list.body.requests[0].userId}`).set("Cookie", owner);
    expect(declined.status).toBe(200);
    const groups = await request(app).get("/api/groups").set("Cookie", asker);
    expect(groups.body.groups.some((g) => g.id === GROUP)).toBe(false);
  });
});

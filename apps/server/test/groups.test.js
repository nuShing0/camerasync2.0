// Integration tests for editing a group's team colors (SCRUM-71), run against
// the dev Postgres like auth.test.js. Unique ids per run, cleaned up after.
import "dotenv/config";

import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Sign-up sends a confirmation email; never let a test send real mail.
vi.mock("../src/email/mailer.js", () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
}));

const { authRouter } = await import("../src/routes/auth.js");
const { groupRouter } = await import("../src/routes/groups.js");
const { pool } = await import("../src/db/pool.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/groups", groupRouter);

const RUN = `${Date.now()}${process.pid}`;
const GROUP_ID = `colors${RUN}`;

// Registers a confirmed user and returns their session cookie. Confirmation
// itself is tested in emailVerification.test.js, so it's done directly here.
async function signUp(label) {
  const email = `groups-test-${RUN}-${label}@ucf.edu`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: label, email, password: "groups-test-pass-1" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = $1", [email]);
  return res.headers["set-cookie"];
}

let owner;
let member;
let outsider;

beforeAll(async () => {
  owner = await signUp("owner");
  member = await signUp("member");
  outsider = await signUp("outsider");

  const created = await request(app)
    .post("/api/groups")
    .set("Cookie", owner)
    .send({ id: GROUP_ID, name: "Color Test" });
  expect(created.status).toBe(201);
  const { inviteCode } = created.body.group;

  const joined = await request(app)
    .post(`/api/groups/invites/${inviteCode}/join`)
    .set("Cookie", member)
    .send({});
  expect(joined.status).toBe(201);
});

afterAll(async () => {
  await pool.query("DELETE FROM groups WHERE group_id LIKE $1", [`${GROUP_ID}%`]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [
    `groups-test-${RUN}-%`,
  ]);
  await pool.end();
});

describe("PATCH /api/groups/:id (team color)", () => {
  it("lets the owner pick a team color", async () => {
    const res = await request(app)
      .patch(`/api/groups/${GROUP_ID}`)
      .set("Cookie", owner)
      .send({ primaryColor: "#1E3A8A" });
    expect(res.status).toBe(200);
    // Stored in the palette's lowercase form.
    expect(res.body.group.primaryColor).toBe("#1e3a8a");
    expect(res.body.group).not.toHaveProperty("secondaryColor");
  });

  it("shows the new color in the group list", async () => {
    const res = await request(app).get("/api/groups").set("Cookie", member);
    const group = res.body.groups.find((g) => g.id === GROUP_ID);
    expect(group.primaryColor).toBe("#1e3a8a");
  });

  it("refuses plain members", async () => {
    const res = await request(app)
      .patch(`/api/groups/${GROUP_ID}`)
      .set("Cookie", member)
      .send({ primaryColor: "#dc2626" });
    expect(res.status).toBe(403);
  });

  it("refuses people outside the group", async () => {
    const res = await request(app)
      .patch(`/api/groups/${GROUP_ID}`)
      .set("Cookie", outsider)
      .send({ primaryColor: "#dc2626" });
    expect(res.status).toBe(403);
  });

  it("only accepts colors from the team palette", async () => {
    // #000000 and #ffff00 are valid hex but not in the palette.
    for (const bad of ["red", "#fff", "#12345g", "#000000", "#ffff00"]) {
      const res = await request(app)
        .patch(`/api/groups/${GROUP_ID}`)
        .set("Cookie", owner)
        .send({ primaryColor: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Pick one of the team colors.");
    }
  });

  it("rejects an empty update", async () => {
    const res = await request(app)
      .patch(`/api/groups/${GROUP_ID}`)
      .set("Cookie", owner)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/groups (team color)", () => {
  it("defaults to gold and rejects colors outside the palette", async () => {
    const created = await request(app)
      .post("/api/groups")
      .set("Cookie", owner)
      .send({ id: `${GROUP_ID}b`, name: "Default Color" });
    expect(created.status).toBe(201);
    expect(created.body.group.primaryColor).toBe("#ead217");

    const rejected = await request(app)
      .post("/api/groups")
      .set("Cookie", owner)
      .send({ id: `${GROUP_ID}c`, name: "Bad Color", isPublic: true, primaryColor: "#123456" });
    expect(rejected.status).toBe(400);
  });
});

import crypto from "node:crypto";
import { Router } from "express";

import { pool } from "../db/pool.js";
import {
  closeSessionSocket,
  removeMemberFromGroupSessions,
} from "../sockets/websocket.js";
import { deleteRecordingFiles, storedFileIds } from "./file.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ROLE_RANK, atLeast, getGroupRole } from "../middleware/groupRole.js";
import { DEFAULT_TEAM_COLOR, teamColor } from "../groups/teamColors.js";

export const groupRouter = Router();

//group IDs can only use letters and numbers
const GROUP_ID_PATTERN = /^[A-Za-z0-9]+$/;
const COLOR_ERROR = "Pick one of the team colors.";
const WEB_ORIGIN = (process.env.WEB_ORIGIN || "http://localhost:5173").replace(/\/$/, "");

// Invite codes: six characters that are hard to mix up when read out or
// typed (no 0/O, 1/I/L). Shown as ABC-DEF.
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 6;

function newInviteCode() {
  return Array.from({ length: INVITE_LENGTH },
    () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)]).join("");
}

// A code as typed or pasted: any case, with or without the dash. Codes made
// before this alphabet (from the backfill) can hold 0 and 1, so the letters
// people mistake for them are read as them; new codes never contain O, I or L.
export function normalizeInviteCode(text) {
  return String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0").replace(/[IL]/g, "1");
}

// The link members share to invite people. It opens the web app's join page,
// which hands it to the phone app when that's installed.
function inviteUrl(code) {
  return `${WEB_ORIGIN}/join/${encodeURIComponent(code)}`;
}

//shape a group before sending it to the frontend
function publicGroup(row) {
  return {
    id: row.group_id,
    name: row.name,
    owner: Number(row.owner_id),
    primaryColor: row.primary_color,
    inviteCode: row.invite_code,
    inviteUrl: row.invite_code ? inviteUrl(row.invite_code) : null,
    createdAt: row.created_at,
    joinedAt: row.joined_at,
    role: row.role,
  };
}

// Wrong invite codes per person, so codes can't be guessed by trying many:
// past MAX_CODE_MISSES in CODE_MISS_WINDOW_MS, lookups wait out the window.
// In memory: a restart starts the count over, which is fine for this.
const MAX_CODE_MISSES = 10;
const CODE_MISS_WINDOW_MS = 10 * 60 * 1000;
const codeMisses = new Map();

function tooManyMisses(userId) {
  const recent = (codeMisses.get(userId) ?? []).filter((at) => Date.now() - at < CODE_MISS_WINDOW_MS);
  codeMisses.set(userId, recent);
  return recent.length >= MAX_CODE_MISSES;
}

function recordMiss(userId) {
  codeMisses.get(userId)?.push(Date.now()) ?? codeMisses.set(userId, [Date.now()]);
}

// The group an invite code belongs to, with whether this user is in it.
// null when no group has the code.
async function groupForCode(code, userId) {
  const { rows } = await pool.query(
    `SELECT g.group_id, g.name, g.owner_id, g.primary_color, g.created_at, g.invite_code,
            gm.role, gm.joined_at,
            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.group_id) AS member_count
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.group_id AND gm.user_id = $2
      WHERE g.invite_code = $1`,
    [code, userId]
  );
  return rows[0] ?? null;
}

//all group routes require a logged-in user
groupRouter.use(requireAuth);

//get every group the current user belongs to
groupRouter.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      // In the order the user dragged them into (users.settings.groupOrder);
      // groups not placed yet, like a newly joined one, come after, newest
      // first.
      `SELECT g.group_id, g.name, g.owner_id, g.invite_code,
              g.primary_color, g.created_at, gm.role, gm.joined_at
         FROM groups g
         JOIN group_members gm ON gm.group_id = g.group_id
         JOIN users u ON u.user_id = gm.user_id
        WHERE gm.user_id = $1
        ORDER BY array_position(
                   ARRAY(SELECT json_array_elements_text(
                     COALESCE(u.settings -> 'groupOrder', '[]'::json))),
                   g.group_id::text) NULLS LAST,
                 g.created_at DESC`,
      [req.user.id]
    );

    res.json({ groups: rows.map(publicGroup) });
  } catch (err) {
    console.error("Unable to load groups:", err);
    res.status(500).json({ error: "Unable to load groups." });
  }
});

// What an invite shows before joining: the group's name, color and size.
// The code is the invitation, so anyone signed in who has it can look.
groupRouter.get("/invites/:code", async (req, res) => {
  const code = normalizeInviteCode(req.params.code);
  if (tooManyMisses(req.user.id)) {
    return res.status(429).json({ error: "Too many wrong codes. Try again in a few minutes." });
  }
  try {
    const row = code ? await groupForCode(code, req.user.id) : null;
    if (!row) {
      recordMiss(req.user.id);
      return res.status(404).json({ error: "No group has that invite. Check the code, or ask for a new link." });
    }
    res.json({
      group: {
        id: row.group_id,
        name: row.name,
        primaryColor: row.primary_color,
        memberCount: Number(row.member_count),
        isMember: Boolean(row.role),
      },
    });
  } catch (err) {
    console.error("Unable to load invite:", err);
    res.status(500).json({ error: "Unable to load invite." });
  }
});

// Join a group with its invite. Joining one you're already in just returns it.
groupRouter.post("/invites/:code/join", async (req, res) => {
  const code = normalizeInviteCode(req.params.code);
  if (tooManyMisses(req.user.id)) {
    return res.status(429).json({ error: "Too many wrong codes. Try again in a few minutes." });
  }
  try {
    const row = code ? await groupForCode(code, req.user.id) : null;
    if (!row) {
      recordMiss(req.user.id);
      return res.status(404).json({ error: "No group has that invite. Check the code, or ask for a new link." });
    }
    if (row.role) return res.json({ group: publicGroup(row) });

    const { rows } = await pool.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (group_id, user_id) DO UPDATE SET role = group_members.role
       RETURNING role, joined_at`,
      [row.group_id, req.user.id]
    );
    // An invite answers any request they'd sent.
    await pool.query("DELETE FROM group_join_requests WHERE group_id = $1 AND user_id = $2",
      [row.group_id, req.user.id]);
    res.status(201).json({ group: publicGroup({ ...row, ...rows[0] }) });
  } catch (err) {
    console.error("Unable to join group:", err);
    res.status(500).json({ error: "Unable to join group." });
  }
});

// A new invite code for the group (admins and the owner): the old code,
// link and QR stop working.
groupRouter.post("/:id/invite/reset", async (req, res) => {
  try {
    const role = await getGroupRole(req.params.id, req.user.id);
    if (!atLeast(role, "admin")) {
      return res.status(403).json({ error: "Only group admins can reset the invite." });
    }
    for (let tries = 0; ; tries += 1) {
      try {
        const { rows } = await pool.query(
          `UPDATE groups g SET invite_code = $2
             FROM group_members gm
            WHERE g.group_id = $1 AND gm.group_id = g.group_id AND gm.user_id = $3
            RETURNING g.group_id, g.name, g.owner_id, g.primary_color, g.created_at,
                      g.invite_code, gm.role, gm.joined_at`,
          [req.params.id, newInviteCode(), req.user.id]
        );
        return res.json({ group: publicGroup(rows[0]) });
      } catch (err) {
        // Another group has that code: draw again.
        if (err.code !== "23505" || tries >= 5) throw err;
      }
    }
  } catch (err) {
    console.error("Unable to reset invite:", err);
    res.status(500).json({ error: "Unable to reset the invite." });
  }
});

// Ask to join a group by its exact ID, without an invite. An admin approves
// it from the group's page.
groupRouter.post("/requests", async (req, res) => {
  const id = String(req.body?.groupId ?? "").trim();
  if (!id || !GROUP_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Enter the group's ID: letters and numbers only." });
  }
  try {
    const { rows } = await pool.query(
      `SELECT g.group_id, g.name, gm.role
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.group_id AND gm.user_id = $2
        WHERE LOWER(g.group_id) = LOWER($1)`,
      [id, req.user.id]
    );
    const group = rows[0];
    if (!group) {
      return res.status(404).json({ error: "No group has that ID. Check it with the group's coach." });
    }
    if (group.role) {
      return res.json({ status: "member", group: { id: group.group_id, name: group.name } });
    }
    await pool.query(
      `INSERT INTO group_join_requests (group_id, user_id) VALUES ($1, $2)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [group.group_id, req.user.id]
    );
    res.status(201).json({ status: "requested", group: { id: group.group_id, name: group.name } });
  } catch (err) {
    console.error("Unable to request to join:", err);
    res.status(500).json({ error: "Unable to send the request." });
  }
});

// The group's waiting requests, oldest first (admins and the owner).
groupRouter.get("/:id/requests", async (req, res) => {
  try {
    const role = await getGroupRole(req.params.id, req.user.id);
    if (!atLeast(role, "admin")) {
      return res.status(403).json({ error: "Only group admins can see requests." });
    }
    const { rows } = await pool.query(
      `SELECT r.user_id, r.requested_at, u.display_name, u.email
         FROM group_join_requests r JOIN users u ON u.user_id = r.user_id
        WHERE r.group_id = $1
        ORDER BY r.requested_at, r.user_id`,
      [req.params.id]
    );
    res.json({ requests: rows.map((row) => ({
      userId: Number(row.user_id),
      name: row.display_name || row.email.split("@")[0],
      email: row.email,
      requestedAt: row.requested_at,
    })) });
  } catch (err) {
    console.error("Unable to load requests:", err);
    res.status(500).json({ error: "Unable to load requests." });
  }
});

// Approve (POST .../approve) or decline (DELETE) a request.
async function answerRequest(req, res) {
  const userId = Number(req.params.userId);
  const approving = req.method === "POST";
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Pick a request." });
  }
  try {
    const role = await getGroupRole(req.params.id, req.user.id);
    if (!atLeast(role, "admin")) {
      return res.status(403).json({ error: "Only group admins can answer requests." });
    }
    const { rowCount } = await pool.query(
      "DELETE FROM group_join_requests WHERE group_id = $1 AND user_id = $2",
      [req.params.id, userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: "That request was already answered." });
    }
    if (approving) {
      await pool.query(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [req.params.id, userId]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Unable to answer request:", err);
    res.status(500).json({ error: "Unable to answer the request." });
  }
}
groupRouter.post("/:id/requests/:userId/approve", answerRequest);
groupRouter.delete("/:id/requests/:userId", answerRequest);

groupRouter.get("/:id/members", async (req, res) => {
  try {
    const membership = await pool.query(
      "SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(403).json({ error: "Join this group to view its roster." });
    }

    const { rows } = await pool.query(
      `SELECT u.user_id, u.display_name, gm.role
         FROM group_members gm
         JOIN users u ON u.user_id = gm.user_id
         JOIN groups g ON g.group_id = gm.group_id
        WHERE gm.group_id = $1
        ORDER BY (gm.user_id = g.owner_id) DESC, gm.joined_at, gm.user_id`,
      [req.params.id]
    );
    res.json({ members: rows.map((row) => ({
      id: Number(row.user_id),
      name: row.display_name || "Unnamed member",
      role: row.role,
    })) });
  } catch (err) {
    console.error("Unable to load roster:", err);
    res.status(500).json({ error: "Unable to load roster." });
  }
});

// Rank rules: you need to outrank someone to change or remove them, and you
// can never hand out a role above your own. So the owner manages everyone,
// admins manage members and viewers (including promoting them to admin), and
// nobody touches the owner.
async function changeMember(req, res) {
  const memberId = Number(req.params.memberId);
  const removing = req.method === "DELETE";
  const role = req.body?.role;
  if (!Number.isSafeInteger(memberId) || memberId <= 0 ||
      (!removing && !["admin", "member", "viewer"].includes(role))) {
    return res.status(400).json({ error: "Invalid member or role." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Keep simultaneous role changes from using outdated permissions.
    const { rows: groups } = await client.query(
      "SELECT owner_id FROM groups WHERE group_id = $1 FOR UPDATE",
      [req.params.id]
    );
    const { rows: members } = await client.query(
      "SELECT user_id, role FROM group_members WHERE group_id = $1 AND user_id IN ($2, $3)",
      [req.params.id, req.user.id, memberId]
    );
    const actor = members.find((member) => Number(member.user_id) === Number(req.user.id));
    const target = members.find((member) => Number(member.user_id) === memberId);
    const ownerId = Number(groups[0]?.owner_id);
    const actorRole =
      Number(req.user.id) === ownerId ? "owner" : actor?.role;
    const allowed = actor && target && memberId !== ownerId &&
      atLeast(actorRole, "admin") &&
      ROLE_RANK[actorRole] > (ROLE_RANK[target.role] ?? 0) &&
      (removing || ROLE_RANK[role] <= ROLE_RANK[actorRole]);
    if (!allowed) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "You cannot change this member." });
    }

    if (removing) {
      await client.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2",
        [req.params.id, memberId]);
      await client.query(
        `DELETE FROM recording_session_members rsm USING recording_sessions rs
          WHERE rsm.session_id = rs.id AND rs.group_id = $1 AND rsm.user_id = $2`,
        [req.params.id, memberId]
      );
    } else {
      await client.query("UPDATE group_members SET role = $3 WHERE group_id = $1 AND user_id = $2",
        [req.params.id, memberId, role]);
    }
    await client.query("COMMIT");
    if (removing) await removeMemberFromGroupSessions(req.params.id, memberId);
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Unable to update member:", err);
    res.status(500).json({ error: "Unable to update member." });
  } finally {
    client.release();
  }
}

groupRouter.patch("/:id/members/:memberId", changeMember);
groupRouter.delete("/:id/members/:memberId", changeMember);

//create a group and make its owner an admin
groupRouter.post("/", async (req, res) => {
  const id = String(req.body?.id ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const primaryColor = teamColor(req.body?.primaryColor ?? DEFAULT_TEAM_COLOR);

  if (!name) {
    return res.status(400).json({ error: "Group name is required." });
  }
  if (!id || !GROUP_ID_PATTERN.test(id)) {
    return res.status(400).json({
      error: "Group ID must contain only letters and numbers.",
    });
  }
  if (!primaryColor) {
    return res.status(400).json({ error: COLOR_ERROR });
  }

  //save the group and owner membership together
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // A code another group has (rare) fails the insert like a taken ID
    // would; the client tries again.
    const { rows } = await client.query(
      `INSERT INTO groups (group_id, name, owner_id, primary_color, invite_code)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING group_id, name, owner_id, primary_color, created_at, invite_code`,
      [id, name, req.user.id, primaryColor, newInviteCode()]
    );

    await client.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [id, req.user.id]
    );

    await client.query("COMMIT");
    res.status(201).json({
      group: publicGroup({ ...rows[0], role: "admin" }),
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK");

    if (err.code === "23505") {
      return res.status(409).json({
        error: err.constraint === "groups_invite_code_idx"
          ? "Couldn't make an invite for the group. Try again."
          : "That group ID already exists.",
      });
    }

    console.error("Unable to create group:", err);
    res.status(500).json({ error: "Unable to create group." });
  } finally {
    client?.release();
  }
});

const MAX_GROUP_NAME_LENGTH = 100; // groups.name is VARCHAR(100)

// Update a group. Admins and the owner can change the team color (SCRUM-71);
// only the owner can rename the group.
groupRouter.patch("/:id", async (req, res) => {
  const body = req.body ?? {};
  const wantsColor = body.primaryColor !== undefined;
  const wantsDetails = body.name !== undefined;
  if (!wantsColor && !wantsDetails) {
    return res.status(400).json({ error: "Nothing to update." });
  }

  const primaryColor = wantsColor ? teamColor(body.primaryColor) : null;
  if (wantsColor && !primaryColor) {
    return res.status(400).json({ error: COLOR_ERROR });
  }
  const name = body.name === undefined ? null : String(body.name).trim();
  if (name !== null && (!name || name.length > MAX_GROUP_NAME_LENGTH)) {
    return res.status(400).json({
      error: `Group name must be 1 to ${MAX_GROUP_NAME_LENGTH} characters.`,
    });
  }

  try {
    const role = await getGroupRole(req.params.id, req.user.id);
    if (wantsColor && !atLeast(role, "admin")) {
      return res.status(403).json({
        error: "Only group admins can change the team colors.",
      });
    }
    if (wantsDetails && role !== "owner") {
      return res.status(403).json({
        error: "Only the group owner can rename the group.",
      });
    }

    const { rows } = await pool.query(
      `UPDATE groups g
          SET primary_color = COALESCE($2, g.primary_color),
              name = COALESCE($3, g.name)
         FROM group_members gm
        WHERE g.group_id = $1
          AND gm.group_id = g.group_id
          AND gm.user_id = $4
        RETURNING g.group_id, g.name, g.owner_id, g.invite_code,
                  g.primary_color, g.created_at, gm.role, gm.joined_at`,
      [req.params.id, primaryColor, name, req.user.id]
    );
    res.json({ group: publicGroup(rows[0]) });
  } catch (err) {
    console.error("Unable to update group:", err);
    res.status(500).json({ error: "Unable to update group." });
  }
});

// Leave a group. Everyone but the owner can; the owner hands the group to
// someone else first (POST /:id/transfer).
groupRouter.post("/:id/leave", async (req, res) => {
  try {
    const role = await getGroupRole(req.params.id, req.user.id);
    if (!role) {
      return res.status(404).json({ error: "You're not in this group." });
    }
    if (role === "owner") {
      return res.status(409).json({
        error: "Hand the group to someone else before leaving it.",
      });
    }
    await pool.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]);
    await pool.query(
      `DELETE FROM recording_session_members rsm USING recording_sessions rs
        WHERE rsm.session_id = rs.id AND rs.group_id = $1 AND rsm.user_id = $2`,
      [req.params.id, req.user.id]
    );
    await removeMemberFromGroupSessions(req.params.id, Number(req.user.id));
    res.json({ ok: true });
  } catch (err) {
    console.error("Unable to leave group:", err);
    res.status(500).json({ error: "Unable to leave group." });
  }
});

// Hand the group to another member (owner only). They become the owner and
// the old owner stays on as an admin, free to leave afterwards.
groupRouter.post("/:id/transfer", async (req, res) => {
  const newOwnerId = Number(req.body?.userId);
  if (!Number.isSafeInteger(newOwnerId) || newOwnerId <= 0) {
    return res.status(400).json({ error: "Pick someone to hand the group to." });
  }
  if (newOwnerId === Number(req.user.id)) {
    return res.status(400).json({ error: "You already own this group." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: groups } = await client.query(
      "SELECT owner_id FROM groups WHERE group_id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (Number(groups[0]?.owner_id) !== Number(req.user.id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the group owner can hand the group over." });
    }
    const { rowCount } = await client.query(
      "UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND user_id = $2",
      [req.params.id, newOwnerId]
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Pick someone in this group." });
    }
    await client.query("UPDATE groups SET owner_id = $2 WHERE group_id = $1",
      [req.params.id, newOwnerId]);
    const { rows } = await client.query(
      `SELECT g.group_id, g.name, g.owner_id, g.primary_color, g.invite_code,
              g.created_at, gm.role, gm.joined_at
         FROM groups g
         JOIN group_members gm ON gm.group_id = g.group_id AND gm.user_id = $2
        WHERE g.group_id = $1`,
      [req.params.id, req.user.id]
    );
    await client.query("COMMIT");
    res.json({ group: publicGroup(rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Unable to transfer group:", err);
    res.status(500).json({ error: "Unable to transfer group." });
  } finally {
    client.release();
  }
});

// Delete a group with all its sessions, recordings and comments (owner only).
groupRouter.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: groups } = await client.query(
      "SELECT owner_id FROM groups WHERE group_id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (groups.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Group not found." });
    }
    if (Number(groups[0].owner_id) !== Number(req.user.id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the group owner can delete the group." });
    }
    const { rows: sessions } = await client.query(
      "SELECT id, status FROM recording_sessions WHERE group_id = $1",
      [req.params.id]
    );
    const { rows: videos } = await client.query(
      `SELECT v.file_id, v.preview_file_id, v.thumbnail_file_id, v.scrub FROM recording_session_videos v
         JOIN recording_sessions rs ON rs.id = v.session_id
        WHERE rs.group_id = $1 AND v.file_id IS NOT NULL`,
      [req.params.id]
    );
    await client.query("DELETE FROM groups WHERE group_id = $1", [req.params.id]);
    await client.query("COMMIT");

    // The rows are gone; now the files, and anyone still in a live session.
    await deleteRecordingFiles(storedFileIds(videos));
    for (const session of sessions.filter((item) => item.status === "active")) {
      await closeSessionSocket(session.id).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Unable to delete group:", err);
    res.status(500).json({ error: "Unable to delete group." });
  } finally {
    client.release();
  }
});

import { Server } from "socket.io";
import { createAdapter } from "@socket.io/postgres-adapter";

import {
  SESSION_COOKIE,
  getUserBySessionToken,
  isUnverified,
  publicUser,
} from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { ensureRecordingNumber } from "../recordings/numbering.js";
import { SYNC_BEEP_DELAY_MS } from "../recordings/syncBeep.js";
import { EVENTS } from "./events.js";
import { startDelayMs, stopSchedule, trackRoundTrips } from "./startDelay.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:5173";
let io = null;
const activeRecordings = new Map();
// When each session's last stopped take really ends (its cameras stop a
// moment after the stop command, see stopSchedule), so the next take can't
// start while they are still rolling.
const stoppingUntil = new Map();
// Fallback numbering for the legacy /api/recordings/update flow, whose
// session ids are not recording_sessions rows and so cannot be persisted.
const recordingNumbers = new Map();

// keeps one socket room for each session
function roomName(sessionId) {
  return `recording:${sessionId}`;
}

// reads the login token from the socket cookie
function readCookie(cookieHeader, name) {
  const cookies = String(cookieHeader || "").split(";");

  for (const cookie of cookies) {
    const [cookieName, ...valueParts] = cookie.trim().split("=");
    if (cookieName === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
}

// gets each connected user once
async function getRoomMembers(sessionId) {
  return roomMembersFrom(await getIO().in(roomName(sessionId)).fetchSockets());
}

/// One entry per person in the room. camera: false marks someone only
/// starting and stopping the others; with a camera on any of their devices
/// they count as recording.
// The account's other connections in a room, apart from [socket] itself:
// on other devices (which keep it out), and this same device's older ones
// (a reconnect, which it replaces). Devices that don't send an id (older
// app versions) can't be told apart, so between two of those nothing is
// blocked, as before.
export function otherDevicesOf(sockets, socket) {
  const userId = Number(socket.data.user?.id);
  const mine = socket.data.deviceId ?? null;
  const elsewhere = [];
  const staleHere = [];
  for (const other of sockets) {
    if (other.id === socket.id || Number(other.data.user?.id) !== userId) continue;
    const theirs = other.data.deviceId ?? null;
    if (mine !== null && theirs === mine) staleHere.push(other);
    else if (mine !== null || theirs !== null) elsewhere.push(other);
  }
  return { elsewhere, staleHere };
}

/// roundTripMs is how long their connection takes to answer (the slowest of
/// their devices; null until it's been timed), so everyone can see whose
/// connection is weak.
export function roomMembersFrom(sockets) {
  const members = new Map();
  for (const socket of sockets) {
    const user = socket.data.user;
    if (!user) continue;
    const earlier = members.get(user.id);
    const camera = socket.data.camera !== false || earlier?.camera === true;
    const timed = [earlier?.roundTripMs, socket.data.roundTripMs]
      .filter((ms) => Number.isFinite(ms));
    const roundTripMs = timed.length > 0 ? Math.round(Math.max(...timed)) : null;
    members.set(user.id, { ...user, camera, roundTripMs });
  }
  return Array.from(members.values());
}

// Every heartbeat, each live session gets its device list again, so the
// connection levels in it stay current.
const MEMBERS_EVERY_MS = 10_000;

function startMemberUpdates(server) {
  const timer = setInterval(async () => {
    for (const room of server.of("/").adapter.rooms.keys()) {
      if (!room.startsWith("recording:")) continue;
      const sessionId = room.slice("recording:".length);
      try {
        server.to(room).emit(EVENTS.SESSION_MEMBERS, await getRoomMembers(sessionId));
      } catch (err) {
        console.error("Could not update session members:", err);
      }
    }
  }, MEMBERS_EVERY_MS);
  timer.unref();
}

// Called whenever a device joins or leaves, so it also notes the session's
// last activity (see ../sessions/idleSessions.js).
async function sendRoomMembers(sessionId) {
  pool
    .query("UPDATE recording_sessions SET last_active_at = NOW() WHERE id = $1", [sessionId])
    .catch((err) => console.error("Could not note session activity:", err));
  const members = await getRoomMembers(sessionId);
  getIO().to(roomName(sessionId)).emit(EVENTS.SESSION_MEMBERS, members);
  return members;
}

// Who may start and stop takes for everyone in a session: whoever created
// it, plus the group's admins and owner, from any device.
export function canControlRecording({ created_by, role, owner_id }, userId) {
  return (
    Number(created_by) === Number(userId) ||
    Number(owner_id) === Number(userId) ||
    role === "admin"
  );
}

async function isSessionHost(socket, sessionId) {
  if (socket.data.sessionId !== sessionId) return false;

  const { rows } = await pool.query(
    `SELECT rs.created_by, gm.role, g.owner_id
       FROM recording_sessions rs
       LEFT JOIN groups g ON g.group_id = rs.group_id
       LEFT JOIN group_members gm ON gm.group_id = rs.group_id AND gm.user_id = $2
      WHERE rs.id = $1
        AND rs.status = 'active'
        AND (gm.user_id IS NOT NULL OR rs.group_id IS NULL)`,
    [sessionId, socket.data.user.id]
  );

  return rows.length > 0 && canControlRecording(rows[0], socket.data.user.id);
}

export async function initSocket(httpServer) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS socket_io (
      id BIGSERIAL UNIQUE PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      payload BYTEA
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS socket_io_attachments (
      id BIGSERIAL UNIQUE PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      payload BYTEA
    )
  `);

  io = new Server(httpServer, {
    cors: {
      origin: WEB_ORIGIN,
      credentials: true,
    },
    // Heartbeats also time each connection for the start delay (see
    // startDelay.js), so they come every 10 s rather than the default 25.
    pingInterval: 10000,
  });
  io.adapter(createAdapter(pool));
  startMemberUpdates(io);

  // socket rooms use the same login cookie as the api
  io.use(async (socket, next) => {
    try {
      const token = readCookie(
        socket.handshake.headers.cookie,
        SESSION_COOKIE
      );
      const userRow = await getUserBySessionToken(token);

      if (!userRow) return next(new Error("Not authenticated"));
      if (isUnverified(userRow)) {
        return next(new Error("Confirm your email address to continue."));
      }

      socket.data.user = publicUser(userRow);
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on("connection", (socket) => {
    trackRoundTrips(socket);

    socket.on(EVENTS.JOIN_SESSION, async ({ sessionId, camera, deviceId } = {}, ack) => {
      if (typeof ack !== "function") return;
      if (!sessionId) {
        return ack({ ok: false, error: "Session ID is required." });
      }

      try {
        const { rows } = await pool.query(
          `SELECT rs.id, rs.name, rs.created_by, rs.status,
                  gm.role, g.owner_id
             FROM recording_sessions rs
             LEFT JOIN groups g
               ON g.group_id = rs.group_id
             LEFT JOIN group_members gm
               ON gm.group_id = rs.group_id
              AND gm.user_id = $2
             JOIN recording_session_members rsm
               ON rsm.session_id = rs.id
              AND rsm.user_id = $2
            WHERE rs.id = $1
              AND rs.status = 'active'
              AND (gm.user_id IS NOT NULL OR rs.group_id IS NULL)`,
          [sessionId, socket.data.user.id]
        );

        if (rows.length === 0) {
          return ack({
            ok: false,
            error: "This session is not live or you have not joined it.",
          });
        }

        // The socket room is the recording fleet. Viewers watch afterwards;
        // they never record, so they never join it (covers members demoted
        // to viewer after joining the session).
        const isOwner =
          Number(rows[0].owner_id) === Number(socket.data.user.id);
        if (!isOwner && rows[0].role === "viewer") {
          return ack({
            ok: false,
            error: "Viewers can watch recordings but can't join and record.",
          });
        }

        // One device per account in a session: the server keeps one video
        // per account per take, so a second device's would be lost.
        socket.data.deviceId = typeof deviceId === "string" ? deviceId.slice(0, 64) : null;
        const { elsewhere, staleHere } = otherDevicesOf(
          await getIO().in(roomName(sessionId)).fetchSockets(), socket);
        if (elsewhere.length > 0) {
          return ack({
            ok: false,
            error: "This account is already in this session on another device. " +
              "Leave it there first, or sign in with a different account.",
          });
        }
        // This device's own older connection (it dropped and came back).
        for (const old of staleHere) old.leave(roomName(sessionId));

        const previousSessionId = socket.data.sessionId;
        if (previousSessionId && previousSessionId !== sessionId) {
          await socket.leave(roomName(previousSessionId));
          await sendRoomMembers(previousSessionId);
        }

        socket.data.sessionId = sessionId;
        // A host or admin can join without recording, to run the others.
        socket.data.camera = camera !== false;
        await socket.join(roomName(sessionId));
        const members = await sendRoomMembers(sessionId);

        ack({
          ok: true,
          members,
          recording: activeRecordings.get(sessionId) ?? null,
          session: {
            id: rows[0].id,
            name: rows[0].name,
            createdBy: Number(rows[0].created_by),
            status: rows[0].status,
            canControl: canControlRecording(rows[0], socket.data.user.id),
          },
        });
      } catch (err) {
        console.error("Unable to join Socket.IO session:", err);
        ack({ ok: false, error: "Unable to join the live session." });
      }
    });

    socket.on(EVENTS.LEAVE_SESSION, async () => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) return;

      socket.data.sessionId = null;
      await socket.leave(roomName(sessionId));
      await sendRoomMembers(sessionId);
    });

    // lets the host send one shared recording start time
    socket.on(
      EVENTS.START_RECORDING,
      async ({ sessionId } = {}, ack = () => {}) => {
        try {
          if (!(await isSessionHost(socket, sessionId))) {
            return ack({
              ok: false,
              error: "Only the session's host or a group admin can start recording.",
            });
          }

          // The server picks the delay; any bufferMs an older app sends is
          // ignored.
          const recording = await startSessionRecording(sessionId);
          ack({ ok: true, recording });
        } catch (err) {
          ack({ ok: false, error: err.message });
        }
      }
    );

    // sends the stop command to every device in the room
    socket.on(
      EVENTS.STOP_RECORDING,
      async ({ sessionId } = {}, ack = () => {}) => {
        try {
          if (!(await isSessionHost(socket, sessionId))) {
            return ack({
              ok: false,
              error: "Only the session's host or a group admin can stop recording.",
            });
          }

          const recording = await stopSessionRecording(sessionId);
          ack({ ok: true, recording });
        } catch (err) {
          ack({ ok: false, error: err.message });
        }
      }
    );

    // A camera left the app mid-take (its recording stopped there); tell the
    // rest of the room, so whoever runs the session can redo the take.
    socket.on(EVENTS.CAMERA_DROPPED, () => {
      const sessionId = socket.data.sessionId;
      if (!sessionId || !activeRecordings.has(sessionId)) return;
      socket
        .to(roomName(sessionId))
        .emit(EVENTS.CAMERA_DROPPED, {
          user: {
            id: socket.data.user.id,
            email: socket.data.user.email,
            name: socket.data.user.name,
          },
        });
    });

    socket.on("disconnect", async () => {
      const sessionId = socket.data.sessionId;
      if (sessionId) await sendRoomMembers(sessionId);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error("Socket server has not been initialized.");
  return io;
}

// keeps this available for parker's later recording work
export async function createRecordingSession(sessionId) {
  return getRecordingSession(sessionId);
}

export async function getRecordingSession(sessionId) {
  const sockets = await getIO().in(roomName(sessionId)).fetchSockets();
  return {
    deviceCount: sockets.length,
    devices: sockets.map((socket) => socket.data.user ?? { id: socket.id }),
    recording: activeRecordings.get(sessionId) ?? null,
  };
}

export async function startSessionRecording(sessionId) {
  if (activeRecordings.has(sessionId)) {
    throw new Error("This session is already recording.");
  }

  // Waits for the slowest device in the room (see startDelay.js).
  const sockets = await getIO().in(roomName(sessionId)).fetchSockets();
  const bufferMs = startDelayMs(sockets.map((socket) => socket.data.roundTripMs));

  const serverSentAtEpochMs = Date.now();
  const startAtEpochMs = Math.max(
    serverSentAtEpochMs + bufferMs,
    (stoppingUntil.get(sessionId) ?? 0) + 500
  );

  // The number is persisted against the start time so playback shows the
  // same "Recording N" the host saw, even after a server restart.
  let recordingNumber;
  try {
    recordingNumber = await ensureRecordingNumber(sessionId, startAtEpochMs);
  } catch (err) {
    if (err.code !== "23503") throw err; // not a recording_sessions row
    recordingNumber = (recordingNumbers.get(sessionId) ?? 0) + 1;
    recordingNumbers.set(sessionId, recordingNumber);
  }

  const recording = {
    sessionId,
    recordingNumber,
    bufferMs,
    serverSentAtEpochMs,
    startAtEpochMs,
    // The device that asked for the start plays the sync beep at this time.
    beepAtEpochMs: startAtEpochMs + SYNC_BEEP_DELAY_MS,
  };

  activeRecordings.set(sessionId, recording);
  getIO().to(roomName(sessionId)).emit(EVENTS.RECORDING_STARTED, recording);
  return recording;
}

export async function stopSessionRecording(sessionId) {
  const recording = activeRecordings.get(sessionId);
  if (!recording) throw new Error("This session is not recording.");
  // Taken off at once, so a second Stop while this one is awaited fails.
  activeRecordings.delete(sessionId);

  const sockets = await getIO().in(roomName(sessionId)).fetchSockets();
  const { stopAtEpochMs, endBeepAtEpochMs } = stopSchedule(
    sockets.map((socket) => socket.data.roundTripMs),
    recording.startAtEpochMs,
    Date.now()
  );
  const stoppedRecording = {
    ...recording,
    stopAtEpochMs,
    // Older app versions play an end beep at this time (now the stop itself).
    endBeepAtEpochMs,
  };
  stoppingUntil.set(sessionId, stopAtEpochMs);
  // Sent before saving anything: the stop's delay is for the network.
  getIO()
    .to(roomName(sessionId))
    .emit(EVENTS.RECORDING_STOPPED, stoppedRecording);
  if (endBeepAtEpochMs != null) {
    // Kept with the take so uploads can be lined up by it. Legacy session
    // ids have no row, which is fine: they just go without.
    await pool
      .query(
        `UPDATE session_recordings SET end_beep_epoch_ms = $3
          WHERE session_id = $1 AND started_at_ms = $2`,
        [sessionId, recording.startAtEpochMs, endBeepAtEpochMs]
      )
      .catch((err) => console.error("Unable to save the end beep time:", err));
  }
  return stoppedRecording;
}

// Whether any device is in the session right now, or a take is running.
export async function sessionInUse(sessionId) {
  if (activeRecordings.has(sessionId)) return true;
  const sockets = await getIO().in(roomName(sessionId)).fetchSockets();
  return sockets.length > 0;
}

export async function closeSessionSocket(sessionId) {
  const room = roomName(sessionId);
  if (activeRecordings.has(sessionId)) {
    await stopSessionRecording(sessionId);
  }
  getIO().to(room).emit(EVENTS.CLOSE_SESSION, { sessionId });
  getIO().in(room).socketsLeave(room);
}

// Someone left a session (its leave route): take their devices out of the
// live room and tell everyone still in it, so device counts update even if
// the phone's own leave message never got through.
export async function leaveSessionRoom(sessionId, userId) {
  const room = roomName(sessionId);
  const sockets = await getIO().in(room).fetchSockets();
  for (const socket of sockets) {
    if (Number(socket.data.user?.id) === Number(userId)) {
      socket.leave(room);
      socket.data.sessionId = null;
    }
  }
  await sendRoomMembers(sessionId);
}

// Stop sending session events to someone removed from the group.
export async function removeMemberFromGroupSessions(groupId, userId) {
  const { rows: hostedSessions } = await pool.query(
    `UPDATE recording_sessions SET status = 'complete'
      WHERE group_id = $1 AND created_by = $2 AND status = 'active'
      RETURNING id`,
    [groupId, userId]
  );
  for (const session of hostedSessions) {
    await closeSessionSocket(session.id);
  }
  const { rows } = await pool.query(
    "SELECT id FROM recording_sessions WHERE group_id = $1 AND status = 'active'",
    [groupId]
  );
  for (const session of rows) {
    const sockets = await getIO().in(roomName(session.id)).fetchSockets();
    for (const socket of sockets) {
      if (Number(socket.data.user?.id) === userId) {
        socket.emit(EVENTS.CLOSE_SESSION, { sessionId: session.id });
        await socket.leave(roomName(session.id));
      }
    }
    await sendRoomMembers(session.id);
  }
}

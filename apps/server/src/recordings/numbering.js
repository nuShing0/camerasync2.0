// Recording numbers within a session ("Recording 001", "Recording 002", ...).
//
// A recording is identified by its session and its shared server-clock start
// time. The first time a start time is seen, it takes the next free number
// for that session; later calls for the same start time return that number.

import { pool } from "../db/pool.js";

/**
 * Returns the recording number for `startedAtMs` in `sessionId`, allocating
 * the next one if this start time has not been seen before.
 *
 * Runs in its own short transaction with a per-session advisory lock, so two
 * devices reporting different new start times at once cannot both take the
 * same number.
 */
export async function ensureRecordingNumber(sessionId, startedAtMs) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `session_recordings:${sessionId}`,
    ]);
    const { rows } = await client.query(
      `INSERT INTO session_recordings (session_id, started_at_ms, recording_number)
       SELECT $1::varchar, $2::bigint, COALESCE(MAX(recording_number), 0) + 1
         FROM session_recordings
        WHERE session_id = $1::varchar
       ON CONFLICT (session_id, started_at_ms)
       DO UPDATE SET started_at_ms = EXCLUDED.started_at_ms
       RETURNING recording_number`,
      [sessionId, startedAtMs]
    );
    await client.query("COMMIT");
    return Number(rows[0].recording_number);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Whether the recording at `startedAtMs` in `sessionId` was deleted. Its
 * number stays taken (so later recordings keep theirs) and marked, so a
 * device still uploading it is turned away rather than bringing it back.
 */
export async function isRecordingDeleted(sessionId, startedAtMs) {
  const { rows } = await pool.query(
    `SELECT 1 FROM session_recordings
      WHERE session_id = $1 AND started_at_ms = $2 AND deleted_at IS NOT NULL`,
    [sessionId, startedAtMs]
  );
  return rows.length > 0;
}

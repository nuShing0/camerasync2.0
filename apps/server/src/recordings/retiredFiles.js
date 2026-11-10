// Files a take stops using while someone may be watching them.
//
// When an angle's full video arrives, its phone preview gives way. Anyone
// already playing that preview keeps it until the take plays through (the
// player doesn't swap videos mid-take), so the preview stays reachable
// through its session for an hour before it's deleted.

import { pool } from "../db/pool.js";
import { storage } from "../storage/index.js";

export const KEEP_FOR_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

export async function retireFile(fileId, sessionId) {
  await pool.query(
    `INSERT INTO retired_files (file_id, session_id) VALUES ($1, $2)
     ON CONFLICT (file_id) DO NOTHING`,
    [fileId, sessionId]
  );
}

// Deletes the files retired more than KEEP_FOR_MS ago.
export async function sweepRetiredFiles() {
  const { rows } = await pool.query(
    `DELETE FROM retired_files
      WHERE retired_at < NOW() - make_interval(secs => $1)
      RETURNING file_id`,
    [KEEP_FOR_MS / 1000]
  );
  if (rows.length > 0) await storage.remove(rows.map((row) => row.file_id));
  return rows.length;
}

export function startRetiredFileSweep() {
  const timer = setInterval(() => {
    sweepRetiredFiles().catch((err) => console.error("[retired files] sweep failed:", err));
  }, SWEEP_EVERY_MS);
  timer.unref();
  return timer;
}

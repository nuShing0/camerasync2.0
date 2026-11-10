import { pool } from "../db/pool.js";

/// Records a session download in download_logs for the download audit: one
/// row per recording ("take") the download contains. A failure is logged and
/// swallowed, so the audit can never stop someone getting their videos.
export async function logSessionDownload({ sessionId, userId, ip, recordingNumbers, fileType = "video" }) {
  const numbers = [...new Set(recordingNumbers)];
  if (numbers.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO download_logs (session_id, user_id, file_type, ip_address, recording_number)
       SELECT $1, $2, $3, $4, n FROM UNNEST($5::int[]) AS n`,
      [sessionId, userId, fileType, ip ?? null, numbers]
    );
  } catch (err) {
    console.error("[download audit] Failed to log a session download:", err);
  }
}

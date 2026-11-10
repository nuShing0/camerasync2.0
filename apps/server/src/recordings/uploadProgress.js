// How far along each angle's upload is, for the progress bars under angles
// that are still on their way. The uploading device reports every few
// seconds; viewers get it with the session's videos.
//
// Kept in memory only: it matters for a few minutes, and a restart just
// means the bars wait for the next report. (One server process; with more,
// this would move to the database or the socket adapter.)

// A report older than this means the device stopped sending: shown as
// waiting for a connection.
export const STALLED_AFTER_MS = 30_000;
// Forgotten after this long without a report (the upload gave up for now).
const FORGET_AFTER_MS = 30 * 60 * 1000;

const progress = new Map();
const key = (sessionId, startedAt, userId) => `${sessionId}:${startedAt}:${userId}`;

export const STAGES = new Set(["preview", "full"]);

export function reportProgress(sessionId, startedAt, userId, stage, fraction, now = Date.now()) {
  progress.set(key(sessionId, startedAt, userId), {
    stage,
    fraction: Math.min(1, Math.max(0, fraction)),
    at: now,
  });
}

// An upload finished (or its file arrived some other way): no more bar for
// that stage.
export function clearProgress(sessionId, startedAt, userId, stage) {
  const k = key(sessionId, startedAt, userId);
  const entry = progress.get(k);
  if (entry && (!stage || entry.stage === stage)) progress.delete(k);
}

// What a viewer sees for one angle, or null when there's no upload going.
export function progressFor(sessionId, startedAt, userId, now = Date.now()) {
  const k = key(sessionId, startedAt, userId);
  const entry = progress.get(k);
  if (!entry) return null;
  if (now - entry.at > FORGET_AFTER_MS) {
    progress.delete(k);
    return null;
  }
  return {
    stage: entry.stage,
    fraction: entry.fraction,
    stalled: now - entry.at > STALLED_AFTER_MS,
  };
}

export function resetProgress() {
  progress.clear();
}

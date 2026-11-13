/// What to show while the server makes a session's download, from the
/// status it reports (see requestSyncedDownload in ../api/recordings.js).
export function downloadStatusText(status) {
  if (!status) return "Getting your download ready…";
  if (status.state === "failed") return status.error || "Couldn't make the download.";
  if (status.state === "ready") return "Ready. Downloading…";
  if (status.state === "queued" && status.waiting > 0) {
    return `Waiting for ${status.waiting} other download${status.waiting === 1 ? "" : "s"} to finish…`;
  }
  return `Lining up the videos… ${Math.floor((status.progress ?? 0) * 100)}%`;
}

/// What to show while the server makes a synced or grid download, from the
/// status it reports (see requestExport in ../api/recordings.js).
export function downloadStatusText(kind, status) {
  if (!status) return "Starting…";
  if (status.state === "failed") return status.error || "Couldn't make the download.";
  if (status.state === "ready") return "Ready. Downloading…";
  const making = kind === "grid" ? "Building the grid" : "Lining up the angles";
  const percent = Math.floor((status.progress ?? 0) * 100);
  if (status.state === "queued" && status.waiting > 0) {
    return `Waiting for ${status.waiting} other download${status.waiting === 1 ? "" : "s"} to finish…`;
  }
  const of = status.total > 1 ? ` (${status.ready} of ${status.total} recordings done)` : "";
  return `${making}… ${percent}%${of}`;
}

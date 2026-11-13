import { useEffect, useRef, useState } from "react";

import { requestSyncedDownload, sessionDownloadUrl } from "../api/recordings.js";
import { downloadStatusText } from "../recording/downloadStatus.js";

const POLL_MS = 2000;

// The download button in a session's title row. On the session's list of
// recordings, one click gets the whole session as a zip: one video per
// recording with every angle side by side, lined up like the player. On a
// recording (`startedAt`), just that recording's video. The server makes it
// first, which takes a minute or more the first time; meanwhile this asks every couple of
// seconds, shows how far along it is, and downloads it once it's ready.
export function DownloadButton({ sessionId, startedAt = null }) {
  // While a download is being made: the server's latest status (null
  // before the first answer) and which click it's for.
  const [making, setMaking] = useState(null);
  const attempt = making?.attempt;
  const timer = useRef(null);

  useEffect(() => {
    if (!attempt) return undefined;
    let stopped = false;
    const ask = async () => {
      let status;
      try {
        status = await requestSyncedDownload(sessionId, startedAt);
      } catch (err) {
        status = { state: "failed", error: err.message };
      }
      if (stopped) return;
      setMaking({ attempt, status });
      if (status.state === "ready") {
        save(sessionDownloadUrl(sessionId, startedAt));
        timer.current = setTimeout(() => { if (!stopped) setMaking(null); }, 4000);
      } else if (status.state === "failed") {
        timer.current = setTimeout(() => { if (!stopped) setMaking(null); }, 8000);
      } else {
        timer.current = setTimeout(ask, POLL_MS);
      }
    };
    ask();
    return () => {
      stopped = true;
      clearTimeout(timer.current);
    };
  }, [sessionId, startedAt, attempt]);

  // Another session or recording: start over.
  useEffect(() => setMaking(null), [sessionId, startedAt]);

  const state = making?.status?.state;
  const busy = Boolean(making) && state !== "ready" && state !== "failed";
  const percent = Math.floor((making?.status?.progress ?? 0) * 100);
  const label = making ? downloadStatusText(making.status)
    : startedAt ? "Download this recording, side by side" : "Download every recording, side by side";

  return (
    <div className="download-button">
      <style>{css}</style>
      <button type="button" aria-label={label} title={label} disabled={busy}
        onClick={() => setMaking({ attempt: Date.now(), status: null })}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {busy && <span className="download-button-badge">{percent}%</span>}
      </button>
      {making && (
        <p className={`download-button-status${state === "failed" ? " failed" : ""}`} role="status">
          {downloadStatusText(making.status)}
          {busy && (
            <span className="download-button-bar"><span style={{ width: `${percent}%` }} /></span>
          )}
        </p>
      )}
    </div>
  );
}

// Downloads a link with the login cookie; the server names the file.
function save(href) {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const css = `
  .download-button { position: relative; flex: 0 0 auto; }
  .download-button > button {
    position: relative; display: flex; align-items: center; justify-content: center;
    width: 38px; height: 38px; padding: 0; border: none; border-radius: 8px;
    background: none; color: var(--accent); cursor: pointer;
  }
  .download-button > button:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
  .download-button > button:disabled { cursor: default; }
  .download-button-badge {
    position: absolute; bottom: -4px; right: -6px; padding: 0 4px; border-radius: 6px;
    background: var(--accent); color: var(--accent-ink); font-size: 0.65rem; font-weight: 700; line-height: 1.4;
  }
  .download-button-status {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 20; margin: 0;
    width: max-content; max-width: min(280px, calc(100vw - 32px)); padding: 8px 10px; border-radius: 10px;
    background: #1c1c1c; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    color: #ddd; font-size: 0.85rem;
  }
  .download-button-status.failed { color: #e5484d; }
  .download-button-bar { display: block; height: 4px; margin-top: 6px; border-radius: 2px; background: rgba(255,255,255,0.12); overflow: hidden; }
  .download-button-bar span { display: block; height: 100%; background: var(--accent); transition: width 0.4s; }
`;

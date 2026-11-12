import { useEffect, useRef, useState } from "react";

import { requestExport, sessionDownloadUrl } from "../api/recordings.js";
import { downloadStatusText } from "../recording/downloadStatus.js";

const POLL_MS = 2000;

// The download button in a recording's title row, and its menu: synced
// videos (every angle trimmed to start and end together, like the player),
// one grid video of every angle, or the original files. Synced and grid are
// made on the server first, which takes a minute or more; this asks every
// couple of seconds, shows how far along it is, and downloads when ready.
//
// `startedAt` set: just that recording; null: the whole session.
export function DownloadMenu({ sessionId, startedAt = null, scopeName }) {
  const [open, setOpen] = useState(false);
  // { kind, status, attempt } while a synced or grid download is made.
  const [making, setMaking] = useState(null);
  const box = useRef(null);
  const one = startedAt != null;

  // Closes on a click outside or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!box.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Asks until it's made, then downloads it. Stops when the page closes (the
  // server carries on, so asking again later is quick).
  const kind = making?.kind;
  const attempt = making?.attempt;
  useEffect(() => {
    if (!kind) return undefined;
    let stopped = false;
    let timer;
    const ask = async () => {
      let status;
      try {
        status = await requestExport(sessionId, kind, startedAt);
      } catch (err) {
        status = { state: "failed", error: err.message };
      }
      if (stopped) return;
      setMaking({ kind, status, attempt });
      if (status.state === "ready") {
        save(sessionDownloadUrl(sessionId, { kind, startedAt }));
        timer = setTimeout(() => { if (!stopped) setMaking(null); }, 4000);
      } else if (status.state !== "failed") {
        timer = setTimeout(ask, POLL_MS);
      }
    };
    ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId, startedAt, kind, attempt]);

  // A different recording: start over.
  useEffect(() => setMaking(null), [sessionId, startedAt]);

  const choose = (choice) => {
    if (choice === "original") {
      save(sessionDownloadUrl(sessionId, { startedAt }));
      setOpen(false);
    } else {
      setMaking({ kind: choice, status: null, attempt: Date.now() });
    }
  };

  const busy = making && making.status?.state !== "failed" && making.status?.state !== "ready";
  const percent = Math.floor((making?.status?.progress ?? 0) * 100);

  return (
    <div className="download-menu" ref={box}>
      <style>{css}</style>
      <button type="button" className="download-menu-button" aria-haspopup="menu"
        aria-expanded={open} aria-label={`Download ${scopeName}`} title={`Download ${scopeName}`}
        onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {busy && <span className="download-menu-badge">{percent}%</span>}
        {making?.status?.state === "failed" && (
          <span className="download-menu-badge failed" aria-hidden="true">!</span>
        )}
      </button>
      {open && (
        <div className="download-menu-panel" role="menu">
          <p className="download-menu-scope">Download {scopeName}</p>
          <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => choose("synced")}>
            <strong>Synced videos</strong>
            <span>Every angle trimmed to start and end together (.zip)</span>
          </button>
          <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => choose("grid")}>
            <strong>Grid video</strong>
            <span>
              All angles side by side, lined up
              {one ? " (.mp4)" : ": one video per recording (.zip)"}
            </span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose("original")}>
            <strong>Original files</strong>
            <span>As each phone recorded them, not lined up (.zip)</span>
          </button>
          {making && (
            <p className={`download-menu-status${making.status?.state === "failed" ? " failed" : ""}`}
              role="status">
              {downloadStatusText(making.kind, making.status)}
              {busy && (
                <span className="download-menu-bar"><span style={{ width: `${percent}%` }} /></span>
              )}
            </p>
          )}
        </div>
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
  .download-menu { position: relative; flex: 0 0 auto; }
  .download-menu-button {
    position: relative; display: flex; align-items: center; justify-content: center;
    width: 38px; height: 38px; padding: 0; border: none; border-radius: 8px;
    background: none; color: var(--accent); cursor: pointer;
  }
  .download-menu-button:hover, .download-menu-button[aria-expanded="true"] { background: rgba(255,255,255,0.08); }
  .download-menu-badge {
    position: absolute; bottom: -4px; right: -6px; padding: 0 4px; border-radius: 6px;
    background: var(--accent); color: var(--accent-ink); font-size: 0.65rem; font-weight: 700; line-height: 1.4;
  }
  .download-menu-badge.failed { background: #e5484d; color: #fff; }
  .download-menu-panel {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 20;
    width: min(320px, calc(100vw - 32px)); padding: 6px; border-radius: 12px;
    background: #1c1c1c; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  }
  .download-menu-panel .download-menu-scope { margin: 4px 10px 6px; color: #999; font-size: 0.8rem; }
  .download-menu-panel button {
    display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 8px 10px; border: none;
    border-radius: 8px; background: none; color: inherit; text-align: left; cursor: pointer; font: inherit;
  }
  .download-menu-panel button:hover:not(:disabled) { background: rgba(255,255,255,0.07); }
  .download-menu-panel button:disabled { opacity: 0.45; cursor: default; }
  .download-menu-panel button strong { font-size: 0.95rem; }
  .download-menu-panel button span { color: #aaa; font-size: 0.8rem; }
  .download-menu-status { margin: 6px 10px 4px; font-size: 0.85rem; color: #ddd; }
  .download-menu-status.failed { color: #e5484d; }
  .download-menu-bar { display: block; height: 4px; margin-top: 6px; border-radius: 2px; background: rgba(255,255,255,0.12); overflow: hidden; }
  .download-menu-bar span { display: block; height: 100%; background: var(--accent); transition: width 0.4s; }
`;

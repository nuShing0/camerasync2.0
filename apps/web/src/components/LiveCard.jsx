import { useEffect, useRef, useState } from "react";

const timeLabel = (date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/// A session that's live or open to join: a LIVE tag, its group and when it
/// started, the name big, who's in it, and Join (or Enter, once joined).
export function LiveCard({ session, groupName, joining, onEnter, onJoin, children }) {
  const live = session.status === "active";
  const names = session.activeMemberNames ?? [];
  const shown = names.slice(0, 4);
  return (
    <section className="live-card" aria-label={live ? "Live now" : "Starting now"}>
      <div className="live-card-text">
        <span className="live-card-tag">
          <span className="live-card-pill"><span className="live-card-dot" />{live ? "LIVE" : "STARTING"}</span>
          <span className="live-card-meta">
            {groupName}
            {live && ` · started ${timeLabel(new Date(session.scheduledAt))}`}
          </span>
        </span>
        <strong className="live-card-name">{session.name}</strong>
        {live && (
          <span className="live-card-who">
            {shown.length > 0 && (
              <span className="live-card-faces" aria-hidden="true">
                {shown.map((name, i) => (
                  <span key={i} className="live-card-face" title={name}>{name.trim().charAt(0).toUpperCase()}</span>
                ))}
                {names.length > shown.length && (
                  <span className="live-card-face">+{names.length - shown.length}</span>
                )}
              </span>
            )}
            <span className="live-card-count">
              {session.activeMemberCount} {session.activeMemberCount === 1 ? "device" : "devices"}
              {session.recordingCount > 0 &&
                ` · ${session.recordingCount} ${session.recordingCount === 1 ? "recording" : "recordings"} so far`}
            </span>
          </span>
        )}
        {children && <span className="live-card-more">{children}</span>}
      </div>
      {live && session.isJoined ? (
        <button type="button" className="live-card-join" onClick={onEnter}>Enter</button>
      ) : (
        <button type="button" className="live-card-join" disabled={joining} onClick={onJoin}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
          {joining ? "Joining…" : "Join"}
        </button>
      )}
    </section>
  );
}

/// The live cards in one row: one fills it, two share it, and more slide
/// sideways (drag, scroll, or the arrows), snapping card by card.
export function NowRow({ count, children }) {
  const rowRef = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const update = () => {
    const row = rowRef.current;
    if (!row) return;
    setEdges({
      start: row.scrollLeft <= 2,
      end: row.scrollLeft + row.clientWidth >= row.scrollWidth - 2,
    });
  };
  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [count]);
  const slide = (direction) => {
    const row = rowRef.current;
    const bar = row?.firstElementChild;
    if (bar) row.scrollBy({ left: direction * (bar.clientWidth + 12), behavior: "smooth" });
  };
  return (
    <div className="live-row-wrap">
      <style>{css}</style>
      <div className={count > 2 ? "live-row live-row-many" : "live-row"} ref={rowRef} onScroll={update}>
        {children}
      </div>
      {!edges.start && (
        <button type="button" className="live-row-arrow live-row-arrow-left" aria-label="Earlier sessions"
          onClick={() => slide(-1)}>‹</button>
      )}
      {!edges.end && (
        <button type="button" className="live-row-arrow live-row-arrow-right" aria-label="More live sessions"
          onClick={() => slide(1)}>›</button>
      )}
    </div>
  );
}

const css = `
  /* Right now: one team-colored card per live or open session, side by
     side above the videos; a third or more slide sideways. */
  .live-row-wrap { position: relative; }
  .live-row {
    display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .live-row::-webkit-scrollbar { display: none; }
  .live-row > .live-card { flex: 1 1 0; min-width: 0; scroll-snap-align: start; }
  /* Three or more: two in view at a time, the rest a slide away. */
  .live-row-many > .live-card { flex: 0 0 calc(50% - 6px); }
  .live-row-arrow {
    position: absolute; top: 50%; transform: translateY(-50%); z-index: 1;
    width: 34px; height: 34px; padding: 0; border: 1px solid #333; border-radius: 50%;
    background: #111; color: #fff; font: inherit; font-size: 1.3rem; line-height: 1; cursor: pointer;
    box-shadow: 0 2px 10px rgba(0,0,0,0.5);
  }
  .live-row-arrow:hover { border-color: var(--accent); }
  .live-row-arrow-left { left: -42px; }
  .live-row-arrow-right { right: -42px; }
  .live-card {
    display: flex; flex-wrap: wrap; align-items: center; gap: 16px 20px; min-width: 0;
    box-sizing: border-box; padding: 22px 24px; border-radius: 22px;
    /* Same look as the phone's live card: the team color itself, black or
       white text on it, and a pill Join in the text color. */
    background: var(--brand); color: var(--brand-ink);
  }
  .live-card-text { display: flex; flex-direction: column; gap: 10px; flex: 1 1 260px; min-width: 0; }
  .live-card-tag { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 0.82rem; font-weight: 700; white-space: nowrap; }
  .live-card-pill {
    display: inline-flex; align-items: center; flex: 0 0 auto; padding: 4px 10px; border-radius: 999px;
    background: var(--brand-ink); color: var(--brand); letter-spacing: 0.4px;
  }
  .live-card-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .live-card-name {
    font-size: 1.6rem; font-weight: 800; letter-spacing: -0.4px; line-height: 1.15;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .live-card-who { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 0.9rem; font-weight: 600; }
  .live-card-faces { display: flex; flex: 0 0 auto; }
  .live-card-face {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 28px; height: 28px; box-sizing: border-box; padding: 0 4px; border-radius: 14px;
    border: 2px solid var(--brand); background: var(--brand-ink); color: var(--brand);
    font-size: 0.75rem; font-weight: 700;
  }
  .live-card-face + .live-card-face { margin-left: -8px; }
  .live-card-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-card-join {
    display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto;
    height: 50px; padding: 0 26px; border: none; border-radius: 25px;
    background: var(--brand-ink); color: var(--brand);
    font: inherit; font-size: 1rem; font-weight: 700; cursor: pointer;
  }
  .live-card-join:hover { opacity: 0.9; }
  .live-card-join:disabled { cursor: default; opacity: 0.6; }
  .live-card-dot { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #f0432e; }
  .live-card-more { display: flex; flex-wrap: wrap; gap: 14px; }
  .live-card-more button {
    padding: 0; border: none; background: none; color: inherit; font: inherit;
    font-size: 0.85rem; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
  }
  .live-card-more button:disabled { opacity: 0.6; cursor: default; }
  @media (max-width: 560px) {
    .live-row > .live-card, .live-row-many > .live-card { flex: 0 0 100%; }
    .live-card { padding: 16px; border-radius: 18px; }
    .live-card-tag { flex-wrap: wrap; white-space: normal; }
    .live-card-name { font-size: 1.25rem; white-space: normal; overflow-wrap: anywhere; }
    .live-card-who { flex-wrap: wrap; }
    .live-card-count { white-space: normal; }
    .live-card-join { width: 100%; height: 44px; justify-content: center; }
  }
`;

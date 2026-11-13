import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { SessionScheduler } from "./SessionScheduler.jsx";

// The + New session dialog, opened from the sidebar and from empty states:
// start a session now or schedule one. (Joining is from the session's
// card: every session is in a group, so there's no session code to type.)
const NewSessionContext = createContext(() => {});

/// Opens the dialog, on its menu or straight on one form ("create" or
/// "schedule").
export function useNewSession() {
  return useContext(NewSessionContext);
}

const CHOICES = [
  { panel: "create", title: "Start a session now", detail: "Go live and start recording with your team." },
  { panel: "schedule", title: "Schedule a session", detail: "Put one on the calendar for later." },
];

export function NewSessionProvider({ children }) {
  // null when closed, "menu", or the open form.
  const [panel, setPanel] = useState(null);
  const dialogRef = useRef(null);
  const { pathname } = useLocation();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (panel && !dialog.open) dialog.showModal();
    if (!panel && dialog.open) dialog.close();
  }, [panel]);

  // Starting or joining a session navigates to it: close behind it.
  useEffect(() => { setPanel(null); }, [pathname]);

  const open = (choice = "menu") => setPanel(choice);
  const title = CHOICES.find((choice) => choice.panel === panel)?.title ?? "New session";

  return (
    <NewSessionContext.Provider value={open}>
      {children}
      <dialog ref={dialogRef} className="new-session-dialog" aria-labelledby="new-session-title"
        onClose={() => setPanel(null)}
        onClick={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
        <style>{css}</style>
        <div className="new-session-body">
          <div className="new-session-head">
            {panel && panel !== "menu" && (
              <button type="button" className="new-session-icon" aria-label="Back to the choices"
                onClick={() => setPanel("menu")}>←</button>
            )}
            <h2 id="new-session-title">{title}</h2>
            <button type="button" className="new-session-icon" aria-label="Close"
              onClick={() => setPanel(null)}>×</button>
          </div>
          {panel === "menu" ? (
            <ul className="new-session-choices">
              {CHOICES.map((choice) => (
                <li key={choice.panel}>
                  <button type="button" onClick={() => setPanel(choice.panel)}>
                    <strong>{choice.title}</strong>
                    <span>{choice.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : panel ? (
            <SessionScheduler key={panel} panel={panel} showList={false}
              onDone={() => setPanel(null)} />
          ) : null}
        </div>
      </dialog>
    </NewSessionContext.Provider>
  );
}

const css = `
  /* The dialog sits outside the app shell, so it sets the app's font itself. */
  .new-session-dialog {
    width: min(520px, calc(100vw - 32px)); padding: 0; border: 1px solid #333;
    border-radius: 16px; background: #161616; color: #f0f0f0;
    font-family: system-ui, sans-serif;
  }
  .new-session-dialog input, .new-session-dialog select, .new-session-dialog button { font-family: inherit; }
  /* The forms bring their own panel from the old Record page; the dialog
     is the panel here. Two columns fit its width. */
  .new-session-dialog .session-schedule-form {
    margin: 0; padding: 0; border: none; background: none;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .new-session-dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
  .new-session-body { padding: 18px 20px 22px; }
  .new-session-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .new-session-head h2 { flex: 1; margin: 0; font-size: 1.2rem; }
  .new-session-icon {
    width: 32px; height: 32px; border: none; border-radius: 50%;
    background: transparent; color: #ccc; font-size: 1.3rem; cursor: pointer;
  }
  .new-session-icon:hover { background: #262626; color: #fff; }
  .new-session-choices { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .new-session-choices button {
    width: 100%; display: flex; flex-direction: column; gap: 3px; text-align: left;
    padding: 14px 16px; border: 1px solid #333; border-radius: 12px;
    background: #1f1f1f; color: #f0f0f0; font: inherit; cursor: pointer;
  }
  .new-session-choices button:hover, .new-session-choices button:focus-visible { border-color: var(--accent); }
  .new-session-choices strong { font-size: 1rem; }
  .new-session-choices span { color: #999; font-size: 0.88rem; }
`;

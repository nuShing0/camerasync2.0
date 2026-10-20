import { NavLink } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";
import { useNewSession } from "./NewSession.jsx";
import { useGroupTheme } from "../theme/GroupThemeContext.jsx"; // for appearance toggle

// Three-person "group" mark. Inline SVG rather than an emoji so it stays
// monochrome and inherits the nav item's color on hover/active.
function GroupsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="currentColor"
      aria-hidden="true"
    >
      {/* centre figure */}
      <circle cx="12" cy="7.2" r="3.2" />
      <path d="M12 11.8c-2.9 0-5.2 1.7-5.2 3.9V18h10.4v-2.3c0-2.2-2.3-3.9-5.2-3.9z" />
      {/* left figure */}
      <circle cx="4.7" cy="9.3" r="2.4" />
      <path d="M4.7 12.5c-2.1 0-3.9 1.3-3.9 2.9V18h4.3v-2.3c0-1.2.5-2.2 1.4-3-.6-.1-1.2-.2-1.8-.2z" />
      {/* right figure */}
      <circle cx="19.3" cy="9.3" r="2.4" />
      <path d="M19.3 12.5c-.6 0-1.2.1-1.8.2.9.8 1.4 1.8 1.4 3V18h4.3v-2.6c0-1.6-1.8-2.9-3.9-2.9z" />
    </svg>
  );
}

// Video camera mark for the recording section.
function HomeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 10.5 12 3.5l8.5 7v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function NewIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function SessionsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 2.8V6.6M16 2.8V6.6" strokeLinecap="round" />
    </svg>
  );
}

// An outline cog (the Lucide "settings" shape), to match the other icons.
export function GearIcon({ size = 28 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: "/", label: "Home", icon: <HomeIcon />, end: true },
  { to: "/groups", label: "Groups", icon: <GroupsIcon /> },
  { to: "/watch", label: "Sessions", icon: <SessionsIcon /> },
  { to: "/calendar", label: "Calendar", icon: <CalendarIcon /> },
  { to: "/settings", label: "Settings", icon: <GearIcon /> },
];

/// Yellow primary navigation. Sits fixed on the left; the app content scrolls
/// beside it. The active route gets a lighter-yellow tile, per the design.
export function Sidebar() {
  const { user, logout } = useAuth();
  const openNewSession = useNewSession();
  const { mode, toggleMode } = useGroupTheme(); // appearance toggle

  return (
    <nav style={styles.sidebar}>
      <style>{css}</style>

      <ul style={styles.list}>
        {/* Start, schedule or join a session: the + in the phone's bar. */}
        <li>
          <button type="button" className="kh-nav kh-new" onClick={() => openNewSession()}>
            <span style={styles.icon} aria-hidden="true">
              <NewIcon />
            </span>
            New session
          </button>
        </li>
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? "kh-nav kh-nav-active" : "kh-nav"
              }
            >
              <span style={styles.icon} aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>

      <div style={styles.footer}>
        {user && <div style={styles.user}>{user.name || user.email}</div>}
        {/* appearance toggle */}
        <button
          type="button"
          className="kh-logout"
          onClick={toggleMode}
          title="Switch light/dark appearance"
        >
          <span aria-hidden="true">{mode === "dark" ? "☀" : "☾"}</span>{" "}
          {mode === "dark" ? "Light" : "Dark"}
        </button>
        <br />
        <button
          type="button"
          className="kh-logout"
          onClick={logout}
          title="Log out"
        >
          <span aria-hidden="true">←</span> Log out
        </button>
      </div>
    </nav>
  );
}

// Slim, so the pages (and the angles in playback) get the width.
export const SIDEBAR_WIDTH = 116;

const styles = {
  sidebar: {
    position: "fixed",
    top: 0,
    left: 0,
    bottom: 0,
    width: SIDEBAR_WIDTH,
    background: "var(--brand)",
    color: "var(--brand-ink)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "system-ui, sans-serif",
    boxSizing: "border-box",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: "0.55rem 0.5rem 0",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    flex: 1,
  },
  icon: {
    display: "block",
    lineHeight: 1,
    marginBottom: 5,
  },
  footer: {
    padding: "0.75rem 0.4rem 1rem",
    fontSize: "0.74rem",
    textAlign: "center",
  },
  user: {
    fontWeight: 600,
    marginBottom: 8,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};

// Hover/active states can't be expressed inline.
const css = `
  .kh-nav {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.7rem 0.25rem;
    border-radius: 12px;
    color: var(--brand-ink);
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.2;
    text-align: center;
    transition: background 0.12s;
  }
  .kh-nav:hover { background: rgba(255,255,255,0.28); }
  .kh-nav svg { width: 26px; height: 26px; }
  .kh-nav-active,
  .kh-nav-active:hover {
    background: var(--brand-active);
    color: #000;
  }
  .kh-new { width: 100%; border: none; background: transparent; font-family: inherit; cursor: pointer; }
  .kh-logout {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-weight: 700;
    padding: 0.4rem 0.35rem;
    white-space: nowrap;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--brand-ink);
    cursor: pointer;
    transition: background 0.12s;
  }
  .kh-logout:hover { background: rgba(255,255,255,0.28); }
`;
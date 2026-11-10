import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";
import { getGroups } from "../api/groups.js";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { NotificationList } from "../components/NotificationList.jsx";
import { getNotifications, markNotificationsSeen } from "../api/notifications.js";
import { getSessions, joinSession } from "../api/recordings.js";
import { groupTile } from "../theme/groupTheme.js";
import { LiveCard, NowRow } from "../components/LiveCard.jsx";

const NOTIFICATIONS_ON_HOME = 4;
const WEEK_ON_HOME = 4;

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

// A scheduled session can be joined from its start time until this long
// after, when the server closes it if nobody came (the server's rule).
const JOIN_WINDOW_MS = 15 * 60 * 1000;

const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// "in 15 h", "in 40 min", "in 3 days".
function untilLabel(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

// "Today", "Tomorrow", or "Sat, Oct 24".
function dayLabel(date, now) {
  if (sameDay(date, now)) return "Today";
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(date, tomorrow)) return "Tomorrow";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// "2026-10-29", how the calendar takes a day.
const dayParam = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const timeLabel = (date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/// Home dashboard: a line of counts, a card for each session live or open to
/// join right now above recent sessions (a grid of video cards), and beside
/// them one column with this week (a day strip and what's scheduled) and the
/// newest notifications.
export function HomeScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState(null);
  const [error, setError] = useState("");
  const [notifications, setNotifications] = useState(null);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const firstName = (user?.name || user?.email || "").split(/[\s@]/)[0];

  useEffect(() => {
    Promise.all([getGroups(), getSessions()])
      .then(([loadedGroups, loadedSessions]) => {
        setGroups(loadedGroups);
        setSessions(
          loadedSessions.filter((session) => session.status !== "cancelled")
        );
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Keeps the live card and recent sessions current: a practice that starts
  // shows up within a few seconds, without a reload.
  useAutoRefresh(() => {
    getSessions()
      .then((loaded) => setSessions(loaded.filter((session) => session.status !== "cancelled")))
      .catch(() => {});
  }, 8000);

  // Notifications load on their own (a failure just leaves the panel empty)
  // and refresh every 30 seconds. Showing them here counts as seeing them;
  // they stay highlighted until the next load.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getNotifications(NOTIFICATIONS_ON_HOME)
        .then((data) => {
          if (cancelled) return;
          setNotifications(data.notifications);
          if (data.unreadCount > 0) markNotificationsSeen().catch(() => {});
        })
        .catch(() => {
          if (!cancelled) setNotifications((current) => current ?? []);
        });
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Completed sessions are the recordings; per the design, Home is the
  // primary way into them ("View all" opens the full list).
  // Takes across the user's sessions.
  const recordingCount = sessions.reduce((total, session) => total + (session.recordingCount ?? 0), 0);
  const recentRecordings = sessions
    .filter((session) => session.status === "complete" && session.recordingCount !== 0)
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt))
    .slice(0, 6);
  const groupName = (groupId) =>
    groupId == null
      ? "No group"
      : groups.find((group) => group.id === groupId)?.name || groupId;

  // joins a live session from the home page
  const joinLiveSession = async (id) => {
    setError("");
    setJoiningId(id);

    try {
      const joinedSession = await joinSession(id);
      setSessions((current) =>
        current.map((session) => (session.id === id ? joinedSession : session))
      );
      navigate(`/record/${joinedSession.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setJoiningId(null);
    }
  };

  const now = new Date();
  // A scheduled session whose start time has come.
  const joinable = (session) => session.status === "scheduled"
    && new Date(session.scheduledAt) <= now
    && now - new Date(session.scheduledAt) <= JOIN_WINDOW_MS;
  // What's happening right now: live, or open to join. The bars at the top.
  const nowSessions = sessions
    .filter((session) => session.status === "active" || joinable(session))
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  // Scheduled over the next 7 days, soonest first; the bars have the rest.
  const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
  const weekAll = sessions
    .filter((session) => session.status === "scheduled" && !joinable(session)
      && new Date(session.scheduledAt) > now
      && new Date(session.scheduledAt) < weekEnd)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  // A few, so Notifications stays in view; the calendar has the rest.
  const thisWeek = weekAll.slice(0, WEEK_ON_HOME);
  const tileOf = (session) => groupTile(groups.find((group) => group.id === session.groupId));

  return (
    <div className="home">
      <style>{css}</style>

      <div className="home-page">
        <header className="home-header">
          <div className="home-date">{today}</div>
          <h1 className="home-title">{greeting()}, {firstName}</h1>
          {/* The counts, small: each one a way into its page. */}
          <p className="home-counts">
            <Link to="/groups">{loading ? "…" : groups.length} {groups.length === 1 ? "group" : "groups"}</Link>
            <span aria-hidden="true">·</span>
            <Link to="/watch">{loading ? "…" : sessions.length} {sessions.length === 1 ? "session" : "sessions"}</Link>
            <span aria-hidden="true">·</span>
            <span>{loading ? "…" : recordingCount} {recordingCount === 1 ? "recording" : "recordings"}</span>
          </p>
        </header>

        {error && <p className="home-error">{error}</p>}

        <div className="home-columns">
          <div className="home-main">
          {/* Right now: a card per session that's live or open to join, in
              the team color, above the videos. Nothing upcoming here; that's
              This week. */}
          {nowSessions.length > 0 && (
            <NowRow count={nowSessions.length}>
              {nowSessions.map((session) => (
                <LiveCard key={session.id} session={session} groupName={groupName(session.groupId)}
                  joining={joiningId === session.id}
                  onEnter={() => navigate(`/record/${session.id}`)}
                  onJoin={() => joinLiveSession(session.id)} />
              ))}
            </NowRow>
          )}
          <section>
            <div className="home-section-row">
              <h2 className="home-section">Recent sessions</h2>
              {recentRecordings.length > 0 && (
                <button type="button" className="home-view-all" onClick={() => navigate("/watch")}>
                  View all
                </button>
              )}
            </div>
            {recentRecordings.length === 0 ? (
              <EmptyNote icon="video" title="No recordings yet">
                {groups.length > 0
                  ? "Recordings from your team's sessions show up here to watch."
                  : "Join a team first. Its sessions' recordings show up here."}
              </EmptyNote>
            ) : (
              <ul className="home-cards">
                {recentRecordings.map((session) => (
                  <li key={session.id}>
                    <button type="button" onClick={() => navigate(`/watch/${session.id}`)}>
                      <span className="home-card-thumb" aria-hidden="true">
                        {session.thumbnailUrl && <img src={session.thumbnailUrl} alt="" loading="lazy" />}
                        {session.recordingCount != null && (
                          <span className="home-card-takes">
                            {session.recordingCount} {session.recordingCount === 1 ? "recording" : "recordings"}
                          </span>
                        )}
                      </span>
                      <strong>{session.name}</strong>
                      <span className="home-card-meta">
                        {new Date(session.scheduledAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        {" · "}
                        {groupName(session.groupId)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          </div>

          {/* One column beside the videos: the week, then notifications. */}
          <aside className="home-side">
            <section>
              <div className="home-section-row">
                <h2 className="home-section">This week</h2>
                <button type="button" className="home-view-all" onClick={() => navigate("/calendar")}>
                  Calendar
                </button>
              </div>
              <WeekStrip sessions={sessions} now={now} tileOf={tileOf}
                onDay={(day) => navigate(`/calendar?day=${dayParam(day)}`)} />
              {thisWeek.length === 0 ? (
                <EmptyNote icon="calendar" title="Nothing else coming up this week">
                  Scheduled sessions show up here.
                </EmptyNote>
              ) : (
                <ul className="home-week">
                  {thisWeek.map((session) => {
                    const at = new Date(session.scheduledAt);
                    const tile = tileOf(session);
                    return (
                      <li key={session.id}>
                        <button type="button"
                          onClick={() => navigate(`/calendar?day=${dayParam(at)}`)}>
                          <span className="home-week-bar" style={{ background: tile?.fill ?? "#ead217" }} />
                          <span className="home-week-text">
                            {session === thisWeek[0] && (
                              <span className="home-week-next">Up next · {untilLabel(at - now)}</span>
                            )}
                            <strong>{session.name}</strong>
                            {/* Open to join: the time line in the accent color,
                                ending in Join. */}
                            <span>
                              {dayLabel(at, now)}, {timeLabel(at)} · {groupName(session.groupId)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {weekAll.length > thisWeek.length && (
                <button type="button" className="home-view-all home-week-more"
                  onClick={() => navigate("/calendar")}>
                  +{weekAll.length - thisWeek.length} more this week
                </button>
              )}
            </section>

            <section>
              <div className="home-section-row">
                <h2 className="home-section">Notifications</h2>
                {notifications?.length > 0 && (
                  <button type="button" className="home-view-all" onClick={() => navigate("/notifications")}>
                    View all
                  </button>
                )}
              </div>
              {notifications === null ? (
                <p className="home-quiet">Loading…</p>
              ) : notifications.length === 0 ? (
                <EmptyNote icon="bell" title="You're all caught up">
                  Comments, new teammates and sessions starting show up here.
                </EmptyNote>
              ) : (
                <NotificationGroups notifications={notifications} now={now} />
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

/// Monday to Sunday of this week: today in the accent color, and a dot in
/// the group's color for each session that day (up to three). A day opens
/// the calendar there.
function WeekStrip({ sessions, now, tileOf, onDay }) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
  return (
    <div className="home-strip">
      {days.map((day) => {
        const onDayOf = sessions.filter((session) => session.status !== "cancelled"
          && sameDay(new Date(session.scheduledAt), day));
        const label = day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
        return (
          <button type="button" key={day.getTime()} onClick={() => onDay(day)}
            className={sameDay(day, now) ? "home-strip-day home-strip-today" : "home-strip-day"}
            aria-label={`${label}, ${onDayOf.length} ${onDayOf.length === 1 ? "session" : "sessions"}`}>
            <span className="home-strip-letter">{day.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
            <span className="home-strip-num">{day.getDate()}</span>
            <span className="home-strip-dots">
              {onDayOf.slice(0, 3).map((session) => (
                <span key={session.id} style={{ background: tileOf(session)?.fill ?? "#ead217" }} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/// The newest notifications, under Today and Earlier.
function NotificationGroups({ notifications, now }) {
  const today = notifications.filter((n) => sameDay(new Date(n.at), now));
  const earlier = notifications.filter((n) => !sameDay(new Date(n.at), now));
  return (
    <>
      {today.length > 0 && (
        <>
          <h3 className="home-notif-when">Today</h3>
          <NotificationList notifications={today} />
        </>
      )}
      {earlier.length > 0 && (
        <>
          <h3 className="home-notif-when">Earlier</h3>
          <NotificationList notifications={earlier} />
        </>
      )}
    </>
  );
}

const EMPTY_ICONS = {
  video: <path d="M3 7h12v10H3zM15 10l6-3v10l-6-3" />,
  calendar: <path d="M4 6h16v14H4zM4 10h16M8 3v5M16 3v5" />,
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />,
};

/// An empty section: an icon, a short title and a helpful line.
function EmptyNote({ icon, title, children }) {
  return (
    <div className="home-empty-note">
      <span className="home-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{EMPTY_ICONS[icon]}</svg>
      </span>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

const css = `
  /* Centered and wide on a desktop, like the calendar. */
  .home-page { max-width: 1480px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }
  .home-header { display: flex; flex-direction: column; gap: 4px; }
  .home-date { color: #bbb; font-size: 0.95rem; }
  .home-title { margin: 0; font-size: 2.2rem; font-weight: 800; letter-spacing: -0.5px; }
  .home-counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 0; color: #8a8a8a; font-size: 0.95rem; }
  .home-counts a { color: #d0d0d0; text-decoration: none; }
  .home-counts a:hover { color: var(--accent); text-decoration: underline; }

  .home-main { display: flex; flex-direction: column; gap: 28px; min-width: 0; }

  /* Recent sessions beside this week and notifications. */
  .home-columns { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 36px; align-items: start; }
  .home-side { display: flex; flex-direction: column; gap: 32px; min-width: 0; }
  .home-side > section { min-width: 0; }
  .home-section-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .home-section { margin: 0; font-size: 1.15rem; font-weight: 700; }
  .home-view-all {
    padding: 0; border: none; background: none; color: var(--accent);
    font: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  }
  .home-view-all:hover { text-decoration: underline; }
  .home-quiet { margin: 0; color: #8a8a8a; font-size: 0.95rem; }
  /* Empty sections: icon, title and a line. No box. */
  .home-empty-note {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 14px 8px 4px; color: #8a8a8a; font-size: 0.9rem; line-height: 1.45;
    text-align: center;
  }
  .home-empty-note strong { color: #e8e8e8; font-size: 1rem; }
  .home-empty-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 56px; height: 56px; margin-bottom: 6px; border-radius: 50%;
    background: #161616; color: var(--accent);
  }

  /* Recent sessions as video cards. */
  .home-cards {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 22px 18px;
    margin: 0; padding: 0; list-style: none;
  }
  .home-cards button {
    display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 0;
    border: none; background: none; color: #f0f0f0; font: inherit; text-align: left; cursor: pointer;
  }
  .home-card-thumb {
    position: relative; display: block; aspect-ratio: 16 / 9; margin-bottom: 6px;
    border-radius: 12px; background: #161616; overflow: hidden;
  }
  /* A still from the session's first take, when the server has made one. */
  .home-card-thumb img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.2s; }
  .home-cards button:hover .home-card-thumb img { transform: scale(1.04); }
  .home-cards button:hover strong { color: var(--accent); }
  .home-card-takes {
    position: absolute; right: 8px; bottom: 8px; padding: 2px 8px; border-radius: 6px;
    background: rgba(0,0,0,0.75); color: #fff; font-size: 0.78rem; font-weight: 600;
  }
  /* Up to two lines, so longer names aren't cut short. */
  .home-cards strong {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; line-height: 1.3;
  }
  .home-card-meta { color: #8a8a8a; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* This week's days: letter, date, and a dot per session. */
  .home-strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-bottom: 8px; }
  .home-strip-day {
    display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 0;
    border: none; border-radius: 10px; background: none; color: #f0f0f0; font: inherit; cursor: pointer;
  }
  .home-strip-day:hover { background: #1e1e1e; }
  .home-strip-letter { color: #8a8a8a; font-size: 0.72rem; font-weight: 700; }
  .home-strip-num { font-size: 1.05rem; font-weight: 600; }
  .home-strip-today .home-strip-letter, .home-strip-today .home-strip-num { color: var(--accent); font-weight: 800; }
  .home-strip-dots { display: flex; gap: 3px; height: 6px; }
  .home-strip-dots span { width: 6px; height: 6px; border-radius: 50%; }
  .home-notif-when {
    margin: 4px 0 2px; color: #8a8a8a; font-size: 0.72rem; font-weight: 700;
    letter-spacing: 0.6px; text-transform: uppercase;
  }
  .home-notif-when ~ .home-notif-when { margin-top: 12px; }

  /* A plain list like Notifications: thin lines between rows, no boxes. */
  .home-week { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
  .home-week li + li { border-top: 1px solid #242424; }
  .home-week button {
    display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 10px 6px;
    border: none; border-radius: 10px; background: none; color: #f0f0f0;
    font: inherit; text-align: left; cursor: pointer;
  }
  .home-week button:hover { background: #1e1e1e; }
  /* The group's color as a dot, like each notification's. */
  .home-week-bar { flex: 0 0 10px; height: 10px; margin-top: 5px; border-radius: 50%; }
  /* Beside the name, below an "Up next" line. */
  .home-week button:has(.home-week-next) .home-week-bar { margin-top: 21px; }
  .home-week-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .home-week-text strong, .home-week-text span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-week-text > span { color: #8a8a8a; font-size: 0.85rem; }
  .home-week-more { margin-top: 8px; }
  .home-week-text > .home-week-next { color: var(--accent); font-size: 0.75rem; font-weight: 700; }
  .home-week-text > .home-week-open { color: var(--accent); font-weight: 600; }

  .home-error {
    margin: 0; padding: 10px 14px; border: 1px solid #5a2a2a; border-radius: 8px;
    background: #2a1a1a; color: #ff8a80;
  }

  @media (max-width: 1080px) {
    .home-columns { grid-template-columns: 1fr; }
  }
`;

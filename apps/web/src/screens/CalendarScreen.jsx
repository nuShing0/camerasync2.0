import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState.jsx";
import { useNewSession } from "../components/NewSession.jsx";

import { getGroups } from "../api/groups.js";
import { getSessions } from "../api/recordings.js";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { groupAccent } from "../theme/groupTheme.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// gives each date a simple lookup key
function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/// Builds the 6x7 grid for a month, padded with the neighbouring months' days
/// so every month renders at the same height and the columns stay aligned.
function buildMonthGrid(year, month) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysThisMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    // Day 1 of the month lands at index `firstWeekday`; everything else is an
    // offset from there, and the Date constructor rolls over month boundaries.
    const date = new Date(year, month, i - firstWeekday + 1);
    cells.push({
      date,
      inMonth: date.getMonth() === month && date.getFullYear() === year,
    });
  }
  return { cells, daysThisMonth };
}

export function CalendarScreen() {
  const openNewSession = useNewSession();
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  );
  const [selected, setSelected] = useState(null);
  const [groups, setGroups] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const { cells } = useMemo(() => buildMonthGrid(year, month), [year, month]);

  // loads visible sessions and their group colors
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

  // New and cancelled sessions show up without a reload.
  useAutoRefresh(() => {
    getSessions()
      .then((loaded) => setSessions(loaded.filter((session) => session.status !== "cancelled")))
      .catch(() => {});
  }, 30000);

  const groupsById = useMemo(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups]
  );

  // groups sessions by date and sorts each day by time
  const sessionsByDate = useMemo(() => {
    const grouped = new Map();

    sessions.forEach((session) => {
      const key = dateKey(new Date(session.scheduledAt));
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(session);
    });

    grouped.forEach((daySessions) =>
      daySessions.sort(
        (left, right) =>
          new Date(left.scheduledAt) - new Date(right.scheduledAt)
      )
    );

    return grouped;
  }, [sessions]);

  const selectedSessions = selected
    ? sessionsByDate.get(dateKey(selected)) || []
    : [];

  const monthLabel = cursor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const step = (delta) => setCursor(new Date(year, month + delta, 1));
  const goToday = () => {
    setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelected(today);
  };

  return (
    <div className="calendar-content">
      <style>{css}</style>

      <h1 style={styles.title}>Calendar</h1>
      <div style={styles.header}>
        <div style={styles.controls}>
          <span style={styles.monthLabel}>{monthLabel}</span>
          <button className="cal-nav" onClick={() => step(-1)} aria-label="Previous month">
            ‹
          </button>
          <button className="cal-nav" onClick={() => step(1)} aria-label="Next month">
            ›
          </button>
        </div>
        <button className="cal-today" onClick={goToday}>
          Today
        </button>
      </div>

      {error && <p className="cal-error">{error}</p>}

      <div style={styles.weekdayRow}>
        {WEEKDAYS.map((d) => (
          <div key={d} style={styles.weekday}>
            {d}
          </div>
        ))}
      </div>

      <div style={styles.grid}>

        {cells.map(({ date, inMonth }) => {
          const isToday = isSameDay(date, today);
          const isSelected = selected && isSameDay(date, selected);
          const daySessions = sessionsByDate.get(dateKey(date)) || [];
          const classes = [
            "cal-day",
            !inMonth && "cal-day-muted",
            isToday && "cal-day-today",
            isSelected && "cal-day-selected",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={date.toISOString()}
              className={classes}
              onClick={() => setSelected(date)}
              aria-current={isToday ? "date" : undefined}
            >
              <span className="cal-day-number">{date.getDate()}</span>
              <span className="cal-day-events">
                {daySessions.slice(0, 2).map((session) => {
                  const group = groupsById.get(session.groupId);
                  const color = groupAccent(group);
                  return (
                    <span
                      className="cal-day-event"
                      style={{
                        color,
                        background: `${color}22`,
                        borderLeft: `3px solid ${color}`,
                      }}
                      key={session.id}
                    >
                      {session.name}
                    </span>
                  );
                })}
                {daySessions.length > 2 && (
                  <span className="cal-day-more">
                    +{daySessions.length - 2} more
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <section className="cal-agenda">
          <h2>
            {selected.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </h2>

          {loading ? (
            <p>Loading sessions...</p>
          ) : selectedSessions.length === 0 ? (
            <EmptyState compact title="Nothing scheduled" action="Schedule a session"
              onAction={() => openNewSession("schedule")}>
              Pick another day, or schedule one.
            </EmptyState>
          ) : (
            <div className="cal-agenda-list">
              {selectedSessions.map((session) => {
                const group = groupsById.get(session.groupId);
                return (
                  <div className="cal-agenda-item" key={session.id}>
                    <time>
                      {new Date(session.scheduledAt).toLocaleTimeString(
                        undefined,
                        {
                          hour: "numeric",
                          minute: "2-digit",
                        }
                      )}
                    </time>
                    <span
                      style={{ color: groupAccent(group) }}
                    >
                      {session.name} - {group?.name || session.groupId}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

const styles = {
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    margin: "0.4rem 0 1.5rem",
  },
  title: {
    margin: 0,
    fontSize: "2.2rem",
    fontWeight: 800,
    letterSpacing: "-0.5px",
  },
  controls: { display: "flex", alignItems: "center", gap: 12 },
  monthLabel: {
    fontWeight: 600,
    fontSize: "1.45rem",
    marginRight: 12,
  },
  weekdayRow: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    width: "100%",
    maxWidth: 1200,
  },
  weekday: {
    fontSize: "0.75rem",
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--text-dim)",
    padding: "0 0 10px 10px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    gap: 1,
    width: "100%",
    maxWidth: 1200,
    background: "var(--field)",
    border: "1px solid var(--field)",
    borderRadius: 10,
    overflow: "hidden",
  },
};

const css = `
  .calendar-content {
    width: min(100%, 1200px);
  }
  .cal-nav {
    width: 38px;
    height: 38px;
    font-size: 1.15rem;
    line-height: 1;
    font-weight: 600;
    border-radius: 50%;
    border: none;
    background: var(--card-hover);
    color: var(--text-strong);
    cursor: pointer;
  }
  .cal-nav:hover { background: var(--raised); }
  .cal-today {
    font: inherit;
    font-weight: 700;
    padding: 0.6rem 1.4rem;
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink);
    cursor: pointer;
  }
  .cal-today:hover { background: var(--accent-hover); }

  .cal-day {
    font: inherit;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 8px;
    min-width: 0;
    min-height: 120px;
    padding: 10px;
    border: none;
    background: var(--surface);
    color: var(--page-ink);
    cursor: pointer;
    transition: background 0.12s;
  }
  .cal-day-number {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 28px;
    border-radius: 50%;
    line-height: 1;
    font-size: 0.95rem;
  }
  .cal-day-events {
    display: flex;
    width: 100%;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  }
  .cal-day-event {
    box-sizing: border-box;
    width: 100%;
    overflow: hidden;
    padding: 4px 7px;
    border-radius: 5px;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.25;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-day-more {
    width: 100%;
    overflow: hidden;
    padding-left: 7px;
    color: var(--text-dim);
    font-size: 0.72rem;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-day:hover { background: var(--card); }
  .cal-day-muted { color: var(--line-strong); }
  .cal-day-today .cal-day-number {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
  }
  .cal-day-selected {
    background: var(--card);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .cal-error {
    margin: 0 0 12px;
    color: var(--error-ink);
  }
  .cal-agenda {
    max-width: 940px;
    margin-top: 20px;
    padding: 18px;
    border: 1px solid var(--raised);
    border-radius: 9px;
    background: var(--card-hover);
  }
  .cal-agenda h2 {
    margin: 0 0 12px;
    font-size: 1.05rem;
  }
  .cal-agenda p {
    margin: 0;
    color: var(--text-muted);
  }
  .cal-agenda-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cal-agenda-item {
    display: grid;
    grid-template-columns: 95px minmax(0, 1fr);
    gap: 12px;
    align-items: baseline;
    padding-top: 8px;
    border-top: 1px solid #2f2f2f;
  }
  .cal-agenda-item:first-child {
    padding-top: 0;
    border-top: 0;
  }
  .cal-agenda-item time {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .cal-agenda-item span {
    font-weight: 600;
  }
  @media (max-width: 650px) {
    .cal-day {
      gap: 3px;
      padding: 5px;
    }
    .cal-day-event {
      font-size: 0;
    }
    .cal-day-event::before {
      content: "•";
      font-size: 0.9rem;
    }
  }
`;

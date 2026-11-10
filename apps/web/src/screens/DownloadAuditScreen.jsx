import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { EmptyState } from "../components/EmptyState.jsx";
import { downloadAuditCsv, getAuditTeam, getAuditTeams } from "../api/downloadAudit.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Sessions per page on a team's page.
const PAGE_SIZE = 5;

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

// The last 30 days, matching the server's default.
function defaultRange() {
  const now = new Date();
  return { from: utcDay(new Date(now.getTime() - 29 * DAY_MS)), to: utcDay(now) };
}

// Every time in the audit is shown in UTC, the way the server stores it.
function formatUtc(value) {
  const text = new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  return `${text} UTC`;
}

function formatDay(value) {
  return new Date(value).toLocaleDateString("en-GB", {
    timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
  });
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function initials(name) {
  return String(name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0].toUpperCase()).join("") || "?";
}

// The filters both views share. The search waits for a pause in typing before
// it reaches the server.
function useFilters() {
  const [range, setRange] = useState(defaultRange);
  const [userId, setUserId] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const reset = () => {
    setRange(defaultRange());
    setUserId("");
    setSearch("");
  };
  return { range, setRange, userId, setUserId, search, setSearch, query, reset };
}

function Filters({ filters, users, placeholder }) {
  const { range, setRange, userId, setUserId, search, setSearch } = filters;
  return (
    <div className="da-filters">
      <label className="da-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
        </svg>
        <input type="search" placeholder={placeholder} aria-label={placeholder}
          value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <label className="da-field">
        <span>From</span>
        <input type="date" value={range.from} max={range.to}
          onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} />
      </label>
      <label className="da-field">
        <span>To</span>
        <input type="date" value={range.to} min={range.from}
          onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} />
      </label>
      {users && (
        <label className="da-field">
          <span>User</span>
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">All users</option>
            {users.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>
      )}
      <span className="da-utc">Dates in UTC</span>
    </div>
  );
}

function Stat({ value, label }) {
  return (
    <div className="da-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TrailNote() {
  return (
    <aside className="da-note">
      <strong>A complete audit trail</strong>
      <p>
        Each row is one download. A take downloaded again creates a new event,
        even by the same user. All timestamps are shown in UTC.
      </p>
    </aside>
  );
}

// Runs an export, showing what went wrong.
function useExport(run) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = async () => {
    setError("");
    setBusy(true);
    try {
      await run();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, start };
}

/// Download audit: every group you administer, then one group's sessions,
/// takes and downloads. Admins and the owner only (the server checks too).
export function DownloadAuditScreen() {
  const { groupId } = useParams();
  return (
    <div className="da-page">
      <style>{css}</style>
      {groupId ? <TeamAudit key={groupId} groupId={groupId} /> : <Overview />}
    </div>
  );
}

function Overview() {
  const filters = useFilters();
  const { range } = filters;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const exporter = useExport(() => downloadAuditCsv(null, { from: range.from, to: range.to }));

  useEffect(() => {
    let cancelled = false;
    setError("");
    getAuditTeams({ from: range.from, to: range.to })
      .then((loaded) => { if (!cancelled) setData(loaded); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  const search = filters.search.trim().toLowerCase();
  const teams = (data?.teams ?? []).filter((team) => !search || team.name.toLowerCase().includes(search));

  return (
    <>
      <header className="da-header">
        <span>
          <h1>Download audit</h1>
          <span className="da-sub">Who downloaded each take, across the groups you administer.</span>
        </span>
        <button type="button" className="da-primary" disabled={exporter.busy || !data || data.teams.length === 0}
          onClick={exporter.start}>
          {exporter.busy ? "Preparing..." : "Export all logs"}
        </button>
      </header>
      {exporter.error && <p role="alert" className="da-error">{exporter.error}</p>}

      {data && (
        <div className="da-stats">
          <Stat value={data.totals.teams} label="Teams" />
          <Stat value={data.totals.downloads} label="Download events" />
          <Stat value={data.totals.users} label="Downloading users" />
        </div>
      )}

      <Filters filters={filters} placeholder="Search teams..." />

      {error ? (
        <p role="alert" className="da-error">{error}</p>
      ) : !data ? (
        <p className="da-quiet">Loading download audit...</p>
      ) : data.teams.length === 0 ? (
        <EmptyState title="No groups to audit" action="Find your group" to="/groups">
          Download audit is available to the owners and admins of a group.
        </EmptyState>
      ) : teams.length === 0 ? (
        <EmptyState title="No teams match" action="Clear search" onAction={() => filters.setSearch("")}>
          Try another name.
        </EmptyState>
      ) : (
        <ul className="da-teams">
          {teams.map((team) => (
            <li key={team.id}>
              <Link to={`/download-audit/${encodeURIComponent(team.id)}`} className="da-team">
                <span className="da-team-head">
                  <span className="da-badge" aria-hidden="true">{initials(team.name)}</span>
                  <strong>{team.name}</strong>
                </span>
                <span className="da-team-counts">
                  <span><b>{team.sessions}</b> Sessions</span>
                  <span><b>{team.takes}</b> Takes</span>
                  <span><b className="da-hot">{team.downloads}</b> Downloads</span>
                </span>
                <span className="da-team-last">
                  {team.lastDownloadAt
                    ? `${team.lastDownloadedBy ?? "Deleted user"} \u00b7 ${formatUtc(team.lastDownloadAt)}`
                    : "No downloads in this range"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <TrailNote />
    </>
  );
}

function TeamAudit({ groupId }) {
  const filters = useFilters();
  const { range, userId, query } = filters;
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState({});
  const exporter = useExport(() => downloadAuditCsv(groupId, {
    from: range.from, to: range.to, userId, q: query,
  }));

  // A new filter starts again from the first page.
  useEffect(() => { setPage(1); }, [range.from, range.to, userId, query]);

  useEffect(() => {
    if (range.from > range.to) {
      setError("The start date must not be after the end date.");
      return undefined;
    }
    let cancelled = false;
    setError("");
    getAuditTeam(groupId, {
      from: range.from, to: range.to, userId, q: query, page, pageSize: PAGE_SIZE,
    })
      .then((loaded) => { if (!cancelled) setData(loaded); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [groupId, range.from, range.to, userId, query, page]);

  // The first session starts open, as in the design.
  const isOpen = (id, index) => open[id] ?? index === 0;
  const toggle = (id, index) => setOpen((current) => ({ ...current, [id]: !isOpen(id, index) }));

  const filtered = Boolean(userId || query);
  const group = data?.group;

  return (
    <>
      <Link to="/download-audit" className="da-back">&larr; All teams</Link>
      <header className="da-header">
        <span className="da-title">
          <span className="da-badge da-badge-large" aria-hidden="true">{initials(group?.name ?? "")}</span>
          <span>
            <h1>{group?.name ?? "Download audit"}</h1>
            <span className="da-sub">Download audit / Recording sessions and take-level activity</span>
          </span>
        </span>
        <button type="button" className="da-primary" disabled={exporter.busy || !data}
          onClick={exporter.start}>
          {exporter.busy ? "Preparing..." : "Export team log"}
        </button>
      </header>
      {exporter.error && <p role="alert" className="da-error">{exporter.error}</p>}

      {data && (
        <div className="da-stats">
          <Stat value={data.totals.sessions} label="Recording sessions" />
          <Stat value={data.totals.takes} label="Takes" />
          <Stat value={data.totals.downloads} label="Download events" />
        </div>
      )}

      <Filters filters={filters} users={data?.users ?? []} placeholder="Search session, take or user..." />

      {error ? (
        <p role="alert" className="da-error">{error}</p>
      ) : !data ? (
        <p className="da-quiet">Loading download audit...</p>
      ) : data.sessions.length === 0 ? (
        <EmptyState
          title={filtered ? "No downloads match" : "No downloads in this range"}
          action="Reset filters"
          onAction={filters.reset}
        >
          {filtered ? "Try another search or user." : "Try a wider date range."}
        </EmptyState>
      ) : (
        <section>
          <h2 className="da-h2">Recording sessions <span>{data.totals.sessions}</span></h2>
          <ul className="da-sessions">
            {data.sessions.map((session, index) => {
              const expanded = isOpen(session.id, index);
              return (
                <li key={session.id} className="da-session">
                  <button type="button" className="da-session-head" aria-expanded={expanded}
                    onClick={() => toggle(session.id, index)}>
                    <span className="da-chevron" aria-hidden="true">{expanded ? "\u2304" : "\u203a"}</span>
                    <span className="da-session-name">
                      <strong>{session.name}</strong>
                      <span>
                        {session.scheduledAt ? formatUtc(session.scheduledAt) : "Unscheduled"}
                        {" \u00b7 "}Session {session.id}
                      </span>
                    </span>
                    <span className="da-session-counts">
                      <span>{plural(session.takeCount, "take")}</span>
                      <b className="da-hot">{plural(session.downloadCount, "download")}</b>
                    </span>
                  </button>

                  {expanded && (
                    <div className="da-session-body">
                      <p className="da-grouped">Takes / download events &middot; grouped by take, newest download first</p>
                      {session.takes.map((take) => (
                        <div key={take.id ?? "other"} className="da-take">
                          <h3>
                            <span>{take.name}{take.id && <code>{take.id}</code>}</span>
                            <b className="da-hot">{plural(take.downloads.length, "download")}</b>
                          </h3>
                          <ul>
                            {take.downloads.map((download) => (
                              <li key={download.id}>
                                <span className="da-when">{formatUtc(download.at)}</span>
                                <span className="da-who">
                                  <span className="da-avatar" aria-hidden="true">{initials(download.user.name)}</span>
                                  {download.user.name}
                                </span>
                                <span className="da-kind">{download.fileType ?? "file"}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <nav className="da-pager" aria-label="Sessions pages">
            <span>
              Showing {data.sessions.length} of {data.totals.sessions} sessions &middot;{" "}
              {formatDay(`${data.range.from}T00:00:00Z`)} &ndash; {formatDay(`${data.range.to}T00:00:00Z`)}
            </span>
            {data.pageCount > 1 && (
              <span className="da-pages">
                <button type="button" aria-label="Previous page" disabled={page <= 1}
                  onClick={() => setPage(page - 1)}>&lsaquo;</button>
                {Array.from({ length: data.pageCount }, (_, i) => i + 1)
                  .filter((n) => n === 1 || n === data.pageCount || Math.abs(n - page) <= 1)
                  .map((n, i, shown) => (
                    <span key={n} className="da-page-slot">
                      {i > 0 && n - shown[i - 1] > 1 && <span aria-hidden="true">&hellip;</span>}
                      <button type="button" aria-current={n === page ? "page" : undefined}
                        onClick={() => setPage(n)}>{n}</button>
                    </span>
                  ))}
                <button type="button" aria-label="Next page" disabled={page >= data.pageCount}
                  onClick={() => setPage(page + 1)}>&rsaquo;</button>
              </span>
            )}
          </nav>
        </section>
      )}
      <TrailNote />
    </>
  );
}

// Colors come from the theme variables, with the dark-mode values as
// fallbacks so the screen works on any branch.
const css = `
  .da-page { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .da-header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 14px 20px; }
  .da-header h1 { margin: 0; font-size: 2.2rem; font-weight: 800; letter-spacing: -0.5px; }
  .da-sub { display: block; margin-top: 4px; color: var(--text-dim, #8a8a8a); font-size: 0.95rem; }
  .da-title { display: flex; align-items: center; gap: 16px; }
  .da-back { align-self: flex-start; color: var(--accent); font-weight: 600; text-decoration: none; }
  .da-back:hover { text-decoration: underline; }
  .da-primary {
    height: 42px; padding: 0 20px; border: none; border-radius: 10px; font: inherit; font-weight: 700;
    background: var(--accent); color: var(--accent-ink); cursor: pointer;
  }
  .da-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .da-primary:disabled { opacity: 0.55; cursor: default; }
  .da-page .da-error { margin: 0; color: var(--error-ink, #ff8a80); }
  .da-quiet { margin: 0; color: var(--text-dim, #8a8a8a); }

  .da-badge {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 38px; height: 38px; border-radius: 10px; font-size: 0.85rem; font-weight: 800;
    background: var(--accent); color: var(--accent-ink);
  }
  .da-badge-large { width: 56px; height: 56px; font-size: 1.2rem; border-radius: 14px; }

  .da-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .da-stat { padding: 16px 20px; border-radius: 14px; background: var(--card, #161616); }
  .da-stat strong { display: block; font-size: 1.9rem; font-weight: 800; color: var(--text-strong, #f0f0f0); }
  .da-stat span { color: var(--text-dim, #8a8a8a); font-size: 0.9rem; }

  .da-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 12px; }
  .da-search {
    display: flex; align-items: center; gap: 8px; flex: 1 1 260px; height: 42px; padding: 0 14px;
    box-sizing: border-box; border-radius: 21px; background: var(--card, #161616); color: var(--text-dim, #8a8a90);
  }
  .da-search input { flex: 1; min-width: 0; border: none; outline: none; background: none; color: var(--text-strong, #f0f0f0); font: inherit; font-size: 0.9rem; }
  .da-search:focus-within { box-shadow: 0 0 0 2px var(--accent); }
  .da-field { display: flex; flex-direction: column; gap: 4px; color: var(--text-dim, #8a8a8a); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; }
  .da-field input, .da-field select {
    height: 42px; padding: 0 12px; box-sizing: border-box; border: 1px solid var(--line-strong, #444);
    border-radius: 10px; background: var(--field, #262626); color: var(--text-strong, #f0f0f0); font: inherit; font-size: 0.9rem;
  }
  .da-utc { align-self: center; color: var(--text-dim, #8a8a8a); font-size: 0.8rem; }

  .da-teams { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; margin: 0; padding: 0; list-style: none; }
  .da-team {
    display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: 14px;
    background: var(--card, #161616); color: var(--text-strong, #f0f0f0); text-decoration: none;
  }
  .da-team:hover { background: var(--card-hover, #1c1c1c); }
  .da-team-head { display: flex; align-items: center; gap: 12px; }
  .da-team-counts { display: flex; gap: 22px; color: var(--text-dim, #8a8a8a); font-size: 0.85rem; }
  .da-team-counts b { display: block; font-size: 1.3rem; color: var(--text-strong, #f0f0f0); }
  .da-team-counts b.da-hot { color: var(--accent); }
  .da-team-last { color: var(--text-dim, #8a8a8a); font-size: 0.82rem; }

  .da-h2 { margin: 0 0 12px; font-size: 1.15rem; font-weight: 700; }
  .da-h2 span { margin-left: 6px; color: var(--text-dim, #8a8a8a); font-size: 0.9rem; font-weight: 600; }
  .da-sessions { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
  .da-session { border-radius: 14px; background: var(--card, #161616); overflow: hidden; }
  .da-session-head {
    display: flex; align-items: center; gap: 14px; width: 100%; padding: 16px 18px; border: none;
    background: none; color: var(--text-strong, #f0f0f0); font: inherit; text-align: left; cursor: pointer;
  }
  .da-session-head:hover { background: var(--card-hover, #1c1c1c); }
  .da-chevron { width: 18px; color: var(--accent); font-size: 1.2rem; font-weight: 800; text-align: center; }
  .da-session-name { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .da-session-name span { color: var(--text-dim, #8a8a8a); font-size: 0.82rem; }
  .da-session-counts { display: flex; align-items: center; gap: 14px; color: var(--text-dim, #8a8a8a); font-size: 0.85rem; white-space: nowrap; }
  .da-hot { color: var(--accent); font-weight: 700; }
  .da-session-body { border-top: 1px solid var(--line, #242424); }
  .da-grouped { margin: 0; padding: 10px 18px; background: var(--raised, #292929); color: var(--text-muted, #a0a0a0); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; }
  .da-take { padding: 6px 18px 10px; }
  .da-take + .da-take { border-top: 1px solid var(--line, #242424); }
  .da-take h3 { display: flex; justify-content: space-between; gap: 12px; margin: 10px 0 6px; font-size: 0.95rem; }
  .da-take code { margin-left: 10px; color: var(--text-dim, #8a8a8a); font-size: 0.8rem; }
  .da-take ul { margin: 0; padding: 0; list-style: none; }
  .da-take li {
    display: grid; grid-template-columns: 1.2fr 1.5fr auto; align-items: center; gap: 12px;
    padding: 8px 0; border-top: 1px solid var(--line, #242424); font-size: 0.9rem;
  }
  .da-when { color: var(--text-muted, #a0a0a0); font-variant-numeric: tabular-nums; }
  .da-who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .da-avatar {
    display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px;
    border-radius: 50%; background: var(--raised, #292929); color: var(--text-strong, #f0f0f0); font-size: 0.7rem; font-weight: 700;
  }
  .da-kind { color: var(--text-dim, #8a8a8a); font-size: 0.8rem; text-transform: capitalize; }

  .da-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; color: var(--text-dim, #8a8a8a); font-size: 0.85rem; }
  .da-pages { display: flex; align-items: center; gap: 6px; }
  .da-page-slot { display: inline-flex; align-items: center; gap: 6px; }
  .da-pages button {
    min-width: 34px; height: 34px; padding: 0 8px; border: none; border-radius: 8px;
    background: var(--card, #161616); color: var(--text-strong, #f0f0f0); font: inherit; font-weight: 600; cursor: pointer;
  }
  .da-pages button[aria-current="page"] { background: var(--accent); color: var(--accent-ink); }
  .da-pages button:disabled { opacity: 0.45; cursor: default; }

  .da-note { padding: 16px 18px; border: 1px solid var(--line, #242424); border-radius: 14px; }
  .da-note strong { display: block; margin-bottom: 4px; }
  .da-note p { margin: 0; color: var(--text-dim, #8a8a8a); font-size: 0.9rem; line-height: 1.5; }

  @media (max-width: 640px) {
    .da-header h1 { font-size: 1.7rem; }
    .da-primary { width: 100%; }
    .da-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .da-stat { padding: 12px; }
    .da-stat strong { font-size: 1.4rem; }
    .da-session-head { flex-wrap: wrap; }
    .da-session-counts { width: 100%; justify-content: space-between; padding-left: 32px; }
    .da-take li { grid-template-columns: 1fr; gap: 4px; }
  }
`;

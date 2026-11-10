import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { EmptyState } from "../components/EmptyState.jsx";
import { downloadAuditCsv, getAuditTeam, getAuditTeams } from "../api/downloadAudit.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Sessions per page on a team's page.
const PAGE_SIZE = 5;

// --- Dates (everything in the audit is UTC, the way the server stores it) ---

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function lastDays(days) {
  const now = new Date();
  return { from: utcDay(new Date(now.getTime() - (days - 1) * DAY_MS)), to: utcDay(now) };
}

// The last 30 days, matching the server's default.
const defaultRange = () => lastDays(30);

const fmt = (value, options) =>
  new Date(value).toLocaleString("en-GB", { timeZone: "UTC", ...options });

// "05 Nov 2026"
const formatDate = (value) => fmt(value, { day: "2-digit", month: "short", year: "numeric" });
// "10:42:18 UTC"
const formatTime = (value) =>
  `${fmt(value, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} UTC`;
// "05 Nov 2026, 09:00 UTC"
const formatDateTime = (value) =>
  `${formatDate(value)}, ${fmt(value, { hour: "2-digit", minute: "2-digit", hour12: false })} UTC`;

// "07 Oct – 05 Nov 2026" (both years when they differ).
function formatRange({ from, to }) {
  const start = `${from}T00:00:00Z`;
  const end = `${to}T00:00:00Z`;
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const startText = sameYear ? fmt(start, { day: "2-digit", month: "short" }) : formatDate(start);
  return `${startText} – ${formatDate(end)}`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function initials(name) {
  return String(name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0].toUpperCase()).join("") || "?";
}

// --- Icons (outline, 24px grid, like the sidebar's) -------------------------

function Icon({ size = 18, children, ...rest }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}
const MicIcon = (p) => <Icon {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Icon>;
const TakesIcon = (p) => <Icon {...p}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>;
const DownloadIcon = (p) => <Icon {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Icon>;
const UsersIcon = (p) => <Icon {...p}><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-3.5-5.5" /></Icon>;
const TeamsIcon = (p) => <Icon {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></Icon>;
const SearchIcon = (p) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></Icon>;
const CalendarIcon = (p) => <Icon {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Icon>;
const ChevronDown = (p) => <Icon {...p}><path d="M6 9l6 6 6-6" /></Icon>;
const ChevronRight = (p) => <Icon {...p}><path d="M9 6l6 6-6 6" /></Icon>;
const ChevronLeft = (p) => <Icon {...p}><path d="M15 6l-6 6 6 6" /></Icon>;
const ArrowLeft = (p) => <Icon {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></Icon>;
const FileIcon = (p) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M10 12l4 2.5-4 2.5z" /></Icon>;
const ShieldIcon = (p) => <Icon {...p}><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></Icon>;
const SortIcon = (p) => <Icon {...p}><path d="M4 6h16M7 12h10M10 18h4" /></Icon>;

// --- Shared pieces ----------------------------------------------------------

function Stat({ icon, value, label }) {
  return (
    <div className="da-stat">
      <span className="da-stat-icon">{icon}</span>
      <span>
        <strong>{value}</strong>
        <span>{label}</span>
      </span>
    </div>
  );
}

function TrailNote() {
  return (
    <aside className="da-note">
      <span className="da-note-icon"><ShieldIcon size={20} /></span>
      <strong>A complete audit trail</strong>
      <p>
        Each row is one download. A take downloaded again creates a new event,
        even by the same user.
      </p>
      <p className="da-note-small">All timestamps shown in UTC.</p>
    </aside>
  );
}

function SearchField({ value, onChange, placeholder }) {
  return (
    <label className="da-search">
      <SearchIcon size={16} />
      <input type="search" placeholder={placeholder} aria-label={placeholder}
        value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

const PRESETS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

// The date range as one button; a small panel picks the days.
function RangePicker({ range, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="da-range" ref={root}>
      <button type="button" className="da-control" aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}>
        <CalendarIcon size={16} />
        <span>{formatRange(range)}</span>
      </button>
      {open && (
        <div className="da-popover" role="dialog" aria-label="Date range">
          <div className="da-presets">
            {PRESETS.map((preset) => {
              const value = lastDays(preset.days);
              const active = value.from === range.from && value.to === range.to;
              return (
                <button key={preset.days} type="button" aria-pressed={active}
                  onClick={() => { onChange(value); setOpen(false); }}>
                  {preset.label}
                </button>
              );
            })}
          </div>
          <label>
            <span>From</span>
            <input type="date" value={range.from} max={range.to}
              onChange={(event) => event.target.value && onChange({ ...range, from: event.target.value })} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={range.to} min={range.from}
              onChange={(event) => event.target.value && onChange({ ...range, to: event.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}

function UserPicker({ users, value, onChange }) {
  return (
    <label className="da-control da-select">
      <ChevronDown size={16} />
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="User">
        <option value="">All users</option>
        {users.map((person) => (
          <option key={person.id} value={person.id}>{person.name}</option>
        ))}
      </select>
    </label>
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

function ExportButton({ exporter, label, disabled }) {
  return (
    <button type="button" className="da-primary" disabled={disabled || exporter.busy}
      onClick={exporter.start}>
      <DownloadIcon size={17} />
      {exporter.busy ? "Preparing..." : label}
    </button>
  );
}

// Every group you administer, with counts for the range. Both views use it:
// the overview's cards and the team page's list.
function useTeams(range) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    getAuditTeams({ from: range.from, to: range.to })
      .then((loaded) => { if (!cancelled) setData(loaded); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [range.from, range.to]);
  return { data, error };
}

/// Download audit: every group you administer, then one group's sessions,
/// takes and downloads. Admins and the owner only (the server checks too).
export function DownloadAuditScreen() {
  const { groupId } = useParams();
  // The date range carries over between the overview and each team.
  const [range, setRange] = useState(defaultRange);
  const teams = useTeams(range);
  return (
    <div className="da-page">
      <style>{css}</style>
      {groupId
        ? <TeamAudit key={groupId} groupId={groupId} range={range} setRange={setRange} teams={teams} />
        : <Overview range={range} setRange={setRange} teams={teams} />}
    </div>
  );
}

function Breadcrumbs({ team }) {
  return (
    <nav className="da-crumbs" aria-label="Breadcrumb">
      {team ? <Link to="/download-audit">Download audit</Link> : <span aria-current="page">Download audit</span>}
      {team && (
        <>
          <ChevronRight size={14} />
          <Link to="/download-audit">Teams</Link>
          <ChevronRight size={14} />
          <span aria-current="page">{team}</span>
        </>
      )}
    </nav>
  );
}

// --- Overview ---------------------------------------------------------------

function Overview({ range, setRange, teams: { data, error } }) {
  const [search, setSearch] = useState("");
  const exporter = useExport(() => downloadAuditCsv(null, { from: range.from, to: range.to }));

  const needle = search.trim().toLowerCase();
  const teams = (data?.teams ?? []).filter((team) => !needle || team.name.toLowerCase().includes(needle));

  return (
    <>
      <Breadcrumbs />
      <header className="da-header">
        <span className="da-title">
          <span className="da-badge da-badge-large" aria-hidden="true"><DownloadIcon size={26} /></span>
          <span>
            <h1>Download audit</h1>
            <span className="da-sub">Who downloaded each take, across the groups you administer.</span>
          </span>
        </span>
        <ExportButton exporter={exporter} label="Export all logs" disabled={!data || data.teams.length === 0} />
      </header>
      {exporter.error && <p role="alert" className="da-error">{exporter.error}</p>}

      <div className="da-stats">
        <Stat icon={<TeamsIcon />} value={data?.totals.teams ?? "–"} label="Teams" />
        <Stat icon={<DownloadIcon />} value={data?.totals.downloads ?? "–"} label="Download events" />
        <Stat icon={<UsersIcon />} value={data?.totals.users ?? "–"} label="Downloading users" />
      </div>

      <div className="da-toolbar">
        <SearchField value={search} onChange={setSearch} placeholder="Find a team..." />
        <RangePicker range={range} onChange={setRange} />
        <span className="da-utc">UTC</span>
      </div>

      {error ? (
        <p role="alert" className="da-error">{error}</p>
      ) : !data ? (
        <p className="da-quiet">Loading download audit...</p>
      ) : data.teams.length === 0 ? (
        <EmptyState title="No groups to audit" action="Find your group" to="/groups">
          Download audit is available to the owners and admins of a group.
        </EmptyState>
      ) : teams.length === 0 ? (
        <EmptyState title="No teams match" action="Clear search" onAction={() => setSearch("")}>
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
                  <ChevronRight size={16} className="da-team-go" />
                </span>
                <span className="da-team-counts">
                  <span><b>{team.sessions}</b> Sessions</span>
                  <span><b>{team.takes}</b> Takes</span>
                  <span><b className="da-hot">{team.downloads}</b> Downloads</span>
                </span>
                <span className="da-team-last">
                  {team.lastDownloadAt
                    ? <>Last: {team.lastDownloadedBy ?? "Deleted user"} &middot; {formatDateTime(team.lastDownloadAt)}</>
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

// --- One team ---------------------------------------------------------------

// The other groups you administer, to switch between without going back.
function TeamsPanel({ data, currentId, range }) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const teams = (data?.teams ?? []).filter((team) => !needle || team.name.toLowerCase().includes(needle));
  return (
    <section className="da-panel" aria-label="Teams">
      <h2 className="da-panel-head">Teams <span>{data?.teams.length ?? ""}</span></h2>
      <SearchField value={search} onChange={setSearch} placeholder="Find a team..." />
      <ul className="da-team-list">
        {teams.map((team) => (
          <li key={team.id}>
            <Link to={`/download-audit/${encodeURIComponent(team.id)}`}
              aria-current={team.id === currentId ? "page" : undefined}>
              <span>{team.name}</span>
              <b>{team.downloads}</b>
            </Link>
          </li>
        ))}
        {data && teams.length === 0 && <li className="da-quiet da-team-none">No teams match.</li>}
      </ul>
      <p className="da-panel-foot">Download counts &middot; {formatRange(range)}</p>
    </section>
  );
}

function TeamAudit({ groupId, range, setRange, teams }) {
  const [userId, setUserId] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState({});
  const exporter = useExport(() => downloadAuditCsv(groupId, {
    from: range.from, to: range.to, userId, q: query,
  }));

  // The search waits for a pause in typing before it reaches the server.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // A new filter starts again from the first page.
  const filterKey = `${range.from}|${range.to}|${userId}|${query}`;
  const [pageKey, setPageKey] = useState(filterKey);
  if (pageKey !== filterKey) {
    setPageKey(filterKey);
    setPage(1);
  }

  useEffect(() => {
    let cancelled = false;
    setError("");
    setLoading(true);
    getAuditTeam(groupId, {
      from: range.from, to: range.to, userId, q: query, page, pageSize: PAGE_SIZE,
    })
      .then((loaded) => { if (!cancelled) setData(loaded); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupId, range.from, range.to, userId, query, page]);

  // The first session starts open.
  const isOpen = (id, index) => open[id] ?? index === 0;
  const toggle = (id, index) => setOpen((current) => ({ ...current, [id]: !isOpen(id, index) }));

  const reset = () => {
    setRange(defaultRange());
    setUserId("");
    setSearch("");
  };

  const filtered = Boolean(userId || query);
  // The team's name is known from the list before its own page loads.
  const group = data?.group ?? teams.data?.teams.find((team) => team.id === groupId);

  return (
    <>
      <Breadcrumbs team={group?.name ?? "…"} />
      <Link to="/download-audit" className="da-back"><ArrowLeft size={15} /> All teams</Link>
      <header className="da-header">
        <span className="da-title">
          <span className="da-badge da-badge-large" aria-hidden="true">{initials(group?.name ?? "")}</span>
          <span>
            <h1>{group?.name ?? "Download audit"}</h1>
            <span className="da-sub">Download audit / Recording sessions and take-level activity</span>
          </span>
        </span>
        <ExportButton exporter={exporter} label="Export team log" disabled={!data} />
      </header>
      {exporter.error && <p role="alert" className="da-error">{exporter.error}</p>}

      <div className="da-layout">
        <div className="da-side">
          <TeamsPanel data={teams.data} currentId={groupId} range={range} />
          <TrailNote />
        </div>

        <div className="da-main">
          <div className="da-stats">
            <Stat icon={<MicIcon />} value={data?.totals.sessions ?? "–"} label="Recording sessions" />
            <Stat icon={<TakesIcon />} value={data?.totals.takes ?? "–"} label="Takes" />
            <Stat icon={<DownloadIcon />} value={data?.totals.downloads ?? "–"} label="Download events" />
          </div>

          <div className="da-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="Search session, take name or user..." />
            <RangePicker range={range} onChange={setRange} />
            <UserPicker users={data?.users ?? []} value={userId} onChange={setUserId} />
            <span className="da-utc">UTC</span>
          </div>

          {error ? (
            <p role="alert" className="da-error">{error}</p>
          ) : !data ? (
            <p className="da-quiet">Loading download audit...</p>
          ) : data.sessions.length === 0 ? (
            <EmptyState
              title={filtered ? "No downloads match" : "No downloads in this range"}
              action="Reset filters"
              onAction={reset}
            >
              {filtered ? "Try another search or user." : "Try a wider date range."}
            </EmptyState>
          ) : (
            <section className={loading ? "da-busy" : undefined} aria-busy={loading}>
              <div className="da-list-head">
                <h2>Recording sessions <span>{data.totals.sessions}</span></h2>
                <span className="da-sort"><SortIcon size={14} /> Latest download first</span>
              </div>
              <ul className="da-sessions">
                {data.sessions.map((session, index) => (
                  <SessionCard key={session.id} session={session} groupName={group?.name ?? ""}
                    expanded={isOpen(session.id, index)} onToggle={() => toggle(session.id, index)} />
                ))}
              </ul>

              <Pager data={data} page={page} setPage={setPage} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}

// "Recovery runs, Back line + 2 more"
function takePreview(takes) {
  const names = takes.map((take) => take.name);
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
}

function SessionCard({ session, groupName, expanded, onToggle }) {
  const users = new Set(session.takes.flatMap((take) => take.downloads.map((d) => d.user.id ?? d.user.name)));
  const bodyId = `da-session-${session.id}`;
  return (
    <li className={expanded ? "da-session da-session-open" : "da-session"}>
      <button type="button" className="da-session-head" aria-expanded={expanded} aria-controls={bodyId}
        onClick={onToggle}>
        <span className="da-chevron">{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
        <span className="da-session-icon"><MicIcon size={18} /></span>
        <span className="da-session-name">
          <strong>{session.name}</strong>
          <span>
            {session.scheduledAt ? formatDateTime(session.scheduledAt) : "Unscheduled"}
            {" · "}Session {session.id}
          </span>
        </span>
        {expanded ? (
          <span className="da-session-counts">
            <span className="da-pill">{plural(session.takeCount, "take")}</span>
            <b className="da-hot">{plural(session.downloadCount, "download")}</b>
          </span>
        ) : (
          <span className="da-session-counts">
            <span className="da-session-takes">
              <span>{plural(session.takeCount, "take")}</span>
              <small>{takePreview(session.takes)}</small>
            </span>
            <span className="da-session-downloads">{plural(session.downloadCount, "download")}</span>
          </span>
        )}
      </button>

      {expanded && (
        <div className="da-session-body" id={bodyId}>
          <div className="da-band">
            <span>Takes / download events</span>
            <span>Grouped by take &middot; newest download first</span>
          </div>
          <table className="da-table">
            <thead>
              <tr>
                <th scope="col">Take name</th>
                <th scope="col">Take ID</th>
                <th scope="col">Team / group</th>
                <th scope="col">Downloaded at</th>
                <th scope="col">Downloaded by</th>
              </tr>
            </thead>
            <tbody>
              {session.takes.flatMap((take) => take.downloads.map((download, i) => (
                <tr key={download.id} className={i === 0 ? "da-take-first" : undefined}>
                  <td>
                    <span className="da-take-name">
                      <span className={i === 0 ? "da-file da-file-latest" : "da-file"}><FileIcon size={16} /></span>
                      <strong>{take.name}</strong>
                    </span>
                  </td>
                  <td className="da-mono" data-label="Take ID">{take.id ?? "—"}</td>
                  <td data-label="Team">{groupName}</td>
                  <td className="da-when" data-label="Downloaded">
                    <span className="da-when-value">
                      <span>{formatDate(download.at)}</span>
                      <span className="da-mono">{formatTime(download.at)}</span>
                    </span>
                  </td>
                  <td data-label="By">
                    <span className="da-who">
                      <span className="da-avatar" aria-hidden="true">{initials(download.user.name)}</span>
                      {download.user.name}
                    </span>
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
          <div className="da-session-foot">
            <span>
              {plural(session.downloadCount, "event")} across {plural(session.takeCount, "take")}
              {" · "}{plural(users.size, "user")}
            </span>
            <span>All download events shown</span>
          </div>
        </div>
      )}
    </li>
  );
}

function Pager({ data, page, setPage }) {
  return (
    <nav className="da-pager" aria-label="Sessions pages">
      <span>
        Showing {data.sessions.length} of {plural(data.totals.sessions, "session")} &middot; {formatRange(data.range)}
      </span>
      {data.pageCount > 1 && (
        <span className="da-pages">
          <button type="button" className="da-page-arrow" aria-label="Previous page" disabled={page <= 1}
            onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
          {Array.from({ length: data.pageCount }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === data.pageCount || Math.abs(n - page) <= 1)
            .map((n, i, shown) => (
              <span key={n} className="da-page-slot">
                {i > 0 && n - shown[i - 1] > 1 && <span aria-hidden="true">&hellip;</span>}
                <button type="button" aria-current={n === page ? "page" : undefined}
                  onClick={() => setPage(n)}>{n}</button>
              </span>
            ))}
          <button type="button" className="da-page-arrow" aria-label="Next page" disabled={page >= data.pageCount}
            onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
        </span>
      )}
    </nav>
  );
}

// Colors come from the theme variables, with the dark-mode values as
// fallbacks so the screen works on any branch. --accent is the team color.
const css = `
  .da-page {
    --da-card: var(--card, #161616);
    --da-card-hover: var(--card-hover, #1c1c1c);
    --da-raised: var(--raised, #232326);
    --da-line: var(--line, #26262a);
    --da-line-strong: var(--line-strong, #3a3a40);
    --da-strong: var(--text-strong, #f0f0f0);
    --da-muted: var(--text-muted, #a6a6ad);
    --da-dim: var(--text-dim, #85858c);
    --da-tint: color-mix(in srgb, var(--accent) 14%, transparent);
    max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px;
    color: var(--da-strong);
  }
  .da-page h1, .da-page h2 { margin: 0; }

  .da-crumbs { display: flex; align-items: center; gap: 8px; color: var(--da-dim); font-size: 0.85rem; }
  .da-crumbs a { color: var(--da-dim); text-decoration: none; }
  .da-crumbs a:hover { color: var(--da-strong); }
  .da-crumbs [aria-current] { color: var(--da-strong); font-weight: 600; }

  .da-back { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; margin-bottom: -6px;
    color: var(--accent); font-size: 0.88rem; font-weight: 700; text-decoration: none; }
  .da-back:hover { text-decoration: underline; }

  .da-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px 20px; }
  .da-title { display: flex; align-items: center; gap: 16px; min-width: 0; }
  .da-header h1 { font-size: 2.2rem; font-weight: 800; letter-spacing: -0.6px; line-height: 1.1; }
  .da-sub { display: block; margin-top: 6px; color: var(--da-dim); font-size: 0.95rem; }

  .da-primary {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    height: 44px; padding: 0 22px; border: none; border-radius: 999px; font: inherit; font-weight: 700;
    background: var(--accent); color: var(--accent-ink); cursor: pointer; transition: background 0.12s;
  }
  .da-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .da-primary:disabled { opacity: 0.55; cursor: default; }
  .da-page .da-error { margin: 0; color: var(--error-ink, #ff8a80); }
  .da-quiet { margin: 0; color: var(--da-dim); }

  .da-badge {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 40px; height: 40px; border-radius: 12px; font-size: 0.85rem; font-weight: 800;
    background: var(--accent); color: var(--accent-ink);
  }
  .da-badge-large { width: 60px; height: 60px; font-size: 1.3rem; border-radius: 16px; }

  /* Two columns: the team list beside the team's sessions. */
  .da-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; align-items: start; }
  .da-side, .da-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .da-side { position: sticky; top: 16px; }

  .da-panel { display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 16px; background: var(--da-card); }
  .da-panel-head { display: flex; justify-content: space-between; font-size: 1rem; font-weight: 700; }
  .da-panel-head span { color: var(--da-dim); font-size: 0.85rem; font-weight: 600; }
  .da-team-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .da-team-list a {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px;
    border-radius: 12px; color: var(--da-muted); font-size: 0.92rem; text-decoration: none;
    box-shadow: inset 3px 0 0 transparent; transition: background 0.12s;
  }
  .da-team-list a span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .da-team-list a b { color: var(--da-dim); font-size: 0.82rem; font-weight: 600; }
  .da-team-list a:hover { background: var(--da-raised); color: var(--da-strong); }
  .da-team-list a[aria-current="page"] { background: var(--da-tint); color: var(--accent); font-weight: 700; box-shadow: inset 3px 0 0 var(--accent); }
  .da-team-list a[aria-current="page"] b { color: var(--accent); }
  .da-team-none { padding: 6px 12px; font-size: 0.85rem; }
  .da-panel-foot { margin: 0; color: var(--da-dim); font-size: 0.75rem; }

  .da-note { display: flex; flex-direction: column; gap: 6px; padding: 16px; border: 1px solid var(--da-line); border-radius: 16px; }
  .da-note-icon { color: var(--accent); }
  .da-note strong { font-size: 0.92rem; }
  .da-note p { margin: 0; color: var(--da-dim); font-size: 0.85rem; line-height: 1.55; }
  .da-note .da-note-small { font-size: 0.75rem; }

  .da-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .da-stat { display: flex; align-items: center; gap: 14px; padding: 18px 20px; border-radius: 16px; background: var(--da-card); }
  .da-stat-icon {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 42px; height: 42px; border-radius: 12px; background: var(--da-tint); color: var(--accent);
  }
  .da-stat strong { display: block; font-size: 1.75rem; font-weight: 800; line-height: 1.1; color: var(--da-strong); }
  .da-stat > span > span { color: var(--da-dim); font-size: 0.85rem; }

  .da-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .da-search {
    display: flex; align-items: center; gap: 8px; flex: 1 1 240px; height: 42px; padding: 0 14px;
    box-sizing: border-box; border-radius: 21px; background: var(--da-raised); color: var(--da-dim);
  }
  .da-panel .da-search { flex: none; }
  .da-search input { flex: 1; min-width: 0; border: none; outline: none; background: none; color: var(--da-strong); font: inherit; font-size: 0.9rem; }
  .da-search:focus-within { box-shadow: 0 0 0 2px var(--accent); }

  .da-control {
    position: relative; display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 16px;
    box-sizing: border-box; border: 1px solid var(--da-line-strong); border-radius: 21px; background: var(--da-card);
    color: var(--da-strong); font: inherit; font-size: 0.9rem; font-weight: 600; white-space: nowrap; cursor: pointer;
  }
  .da-control:hover { background: var(--da-card-hover); }
  .da-control:focus-within, .da-control:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent); }
  .da-control svg { color: var(--da-dim); flex: none; }
  .da-select { padding: 0; }
  .da-select svg { position: absolute; left: 14px; pointer-events: none; }
  .da-select select {
    height: 100%; padding: 0 16px 0 38px; border: none; border-radius: 21px; background: none;
    color: inherit; font: inherit; appearance: none; -webkit-appearance: none; cursor: pointer; outline: none;
  }
  .da-select option { background: var(--da-card); color: var(--da-strong); }
  .da-utc { color: var(--da-dim); font-size: 0.78rem; font-weight: 600; letter-spacing: 0.5px; }

  .da-range { position: relative; }
  .da-popover {
    position: absolute; z-index: 20; top: calc(100% + 8px); right: 0; display: flex; flex-direction: column; gap: 12px;
    width: 250px; padding: 14px; box-sizing: border-box; border: 1px solid var(--da-line-strong); border-radius: 16px;
    background: var(--da-card); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  }
  .da-presets { display: flex; flex-wrap: wrap; gap: 6px; }
  .da-presets button {
    padding: 6px 12px; border: none; border-radius: 999px; background: var(--da-raised); color: var(--da-muted);
    font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer;
  }
  .da-presets button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
  .da-popover label { display: flex; flex-direction: column; gap: 4px; color: var(--da-dim); font-size: 0.72rem; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; }
  .da-popover input {
    height: 40px; padding: 0 12px; box-sizing: border-box; border: 1px solid var(--da-line-strong); border-radius: 12px;
    background: var(--da-raised); color: var(--da-strong); font: inherit; font-size: 0.9rem; color-scheme: dark;
  }

  .da-list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 12px; }
  .da-list-head h2 { font-size: 1.15rem; font-weight: 700; }
  .da-list-head h2 span { margin-left: 6px; color: var(--da-dim); font-size: 0.9rem; font-weight: 600; }
  .da-sort { display: inline-flex; align-items: center; gap: 6px; color: var(--da-dim); font-size: 0.8rem; }
  .da-busy { opacity: 0.6; transition: opacity 0.15s; }

  .da-sessions { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
  .da-session { border: 1px solid transparent; border-radius: 16px; background: var(--da-card); overflow: hidden; }
  .da-session-open { border-color: var(--da-line-strong); }
  .da-session-head {
    display: flex; align-items: center; gap: 14px; width: 100%; padding: 16px 20px; border: none;
    background: none; color: var(--da-strong); font: inherit; text-align: left; cursor: pointer;
  }
  .da-session-head:hover { background: var(--da-card-hover); }
  .da-session-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 16px; }
  .da-chevron { display: inline-flex; color: var(--da-dim); }
  .da-session-open .da-chevron { color: var(--accent); }
  .da-session-icon {
    display: inline-flex; align-items: center; justify-content: center; flex: none; width: 38px; height: 38px;
    border-radius: 12px; background: var(--da-raised); color: var(--da-dim);
  }
  .da-session-open .da-session-icon { background: var(--da-tint); color: var(--accent); }
  .da-session-name { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .da-session-name strong { font-size: 1rem; }
  .da-session-name span { color: var(--da-dim); font-size: 0.8rem; }
  .da-session-counts { display: flex; align-items: center; gap: 28px; color: var(--da-dim); font-size: 0.85rem; white-space: nowrap; }
  .da-session-takes { display: flex; flex-direction: column; gap: 2px; min-width: 150px; color: var(--da-muted); }
  .da-session-takes small { max-width: 280px; overflow: hidden; text-overflow: ellipsis; color: var(--da-dim); font-size: 0.75rem; }
  .da-session-downloads { min-width: 92px; text-align: right; }
  .da-pill { padding: 4px 10px; border-radius: 999px; background: var(--da-raised); color: var(--da-muted); font-size: 0.78rem; }
  .da-hot { color: var(--accent); font-weight: 700; }

  .da-band {
    display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; padding: 10px 20px;
    background: var(--da-tint); font-size: 0.72rem; letter-spacing: 0.4px;
  }
  .da-band span:first-child { color: var(--accent); font-weight: 800; text-transform: uppercase; }
  .da-band span:last-child { color: var(--da-muted); }

  .da-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .da-table th {
    padding: 12px 12px 10px; color: var(--da-dim); font-size: 0.68rem; font-weight: 700; letter-spacing: 0.5px;
    text-align: left; text-transform: uppercase; border-bottom: 1px solid var(--da-line);
  }
  .da-table td { padding: 10px 12px; border-bottom: 1px solid var(--da-line); vertical-align: middle; color: var(--da-muted); }
  .da-table th:first-child, .da-table td:first-child { padding-left: 20px; }
  .da-table th:last-child, .da-table td:last-child { padding-right: 20px; }
  .da-table tbody tr:hover td { background: var(--da-card-hover); }
  .da-take-first:not(:first-child) td { border-top: 1px solid var(--da-line-strong); }
  .da-take-name { display: flex; align-items: center; gap: 10px; }
  .da-take-name strong { color: var(--da-strong); font-weight: 600; }
  .da-file { display: inline-flex; color: var(--da-dim); }
  .da-file-latest { color: var(--accent); }
  .da-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; letter-spacing: 0.2px; }
  .da-when { white-space: nowrap; }
  .da-when-value > span { display: block; }
  .da-when-value > span:first-child { color: var(--da-strong); }
  .da-when-value > .da-mono { margin-top: 2px; color: var(--da-dim); font-size: 0.75rem; }
  .da-who { display: flex; align-items: center; gap: 10px; color: var(--da-strong); }
  .da-avatar {
    display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px;
    border-radius: 50%; background: var(--da-raised); color: var(--da-muted); font-size: 0.66rem; font-weight: 700;
  }
  .da-session-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; padding: 12px 20px; color: var(--da-dim); font-size: 0.78rem; }

  .da-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; color: var(--da-dim); font-size: 0.85rem; }
  .da-pages { display: flex; align-items: center; gap: 6px; }
  .da-page-slot { display: inline-flex; align-items: center; gap: 6px; }
  .da-pages button {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 34px; height: 34px; padding: 0 8px; border: none; border-radius: 999px;
    background: var(--da-card); color: var(--da-strong); font: inherit; font-weight: 700; cursor: pointer;
  }
  .da-pages button:hover:not(:disabled) { background: var(--da-raised); }
  .da-pages .da-page-arrow { background: none; color: var(--accent); }
  .da-pages button[aria-current="page"] { background: var(--accent); color: var(--accent-ink); }
  .da-pages button:disabled { opacity: 0.35; cursor: default; }

  /* Overview cards. */
  .da-teams { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; margin: 0; padding: 0; list-style: none; }
  .da-team {
    display: flex; flex-direction: column; gap: 16px; padding: 18px 20px; border: 1px solid transparent; border-radius: 16px;
    background: var(--da-card); color: var(--da-strong); text-decoration: none; transition: border-color 0.12s, background 0.12s;
  }
  .da-team:hover { background: var(--da-card-hover); border-color: var(--da-line-strong); }
  .da-team-head { display: flex; align-items: center; gap: 12px; }
  .da-team-head strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .da-team-go { color: var(--da-dim); }
  .da-team:hover .da-team-go { color: var(--accent); }
  .da-team-counts { display: flex; gap: 24px; color: var(--da-dim); font-size: 0.82rem; }
  .da-team-counts b { display: block; font-size: 1.35rem; color: var(--da-strong); }
  .da-team-counts b.da-hot { color: var(--accent); }
  .da-team-last { color: var(--da-dim); font-size: 0.8rem; }

  @media (max-width: 1020px) {
    .da-layout { grid-template-columns: minmax(0, 1fr); }
    .da-side { position: static; order: 2; }
    .da-session-takes small { display: none; }
    .da-session-takes { min-width: 0; }
  }

  @media (max-width: 720px) {
    .da-header h1 { font-size: 1.7rem; }
    .da-primary { width: 100%; }
    .da-stats { gap: 8px; }
    .da-stat { flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px; }
    .da-stat-icon { width: 34px; height: 34px; border-radius: 10px; }
    .da-stat strong { font-size: 1.35rem; }
    .da-control, .da-range { flex: 1 1 auto; }
    .da-range .da-control { width: 100%; }
    .da-popover { left: 0; right: auto; }
    .da-session-head { flex-wrap: wrap; padding: 14px 16px; }
    .da-session-counts { width: 100%; justify-content: space-between; padding-left: 70px; gap: 12px; }
    .da-session-downloads { min-width: 0; }
    /* The table becomes one card per download. */
    .da-table thead { display: none; }
    .da-table, .da-table tbody, .da-table tr, .da-table td { display: block; }
    .da-table tr { padding: 10px 16px; border-bottom: 1px solid var(--da-line); }
    .da-table td, .da-table td:first-child, .da-table td:last-child { padding: 3px 0; border: none; }
    .da-take-first:not(:first-child) td { border-top: none; }
    .da-table td[data-label] { display: flex; justify-content: space-between; gap: 12px; }
    .da-table td[data-label]::before {
      content: attr(data-label); color: var(--da-dim); font-family: system-ui, sans-serif; font-size: 0.75rem; letter-spacing: 0;
    }
    .da-when-value { text-align: right; }
    .da-when-value > span { display: inline; }
    .da-when-value > .da-mono { margin: 0 0 0 6px; }
    .da-band, .da-session-foot { padding-left: 16px; padding-right: 16px; }
  }
`;

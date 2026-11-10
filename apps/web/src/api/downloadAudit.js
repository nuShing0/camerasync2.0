//backend URL used by the web app
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

//send a request with the user's login cookie
async function request(path) {
  const res = await fetch(`${SERVER_URL}${path}`, { credentials: "include" });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

// ?a=1&b=2 from an object, leaving out empty values.
function query(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

// Every group you administer, with counts for the date range.
// filters: { from, to } as YYYY-MM-DD (UTC).
export async function getAuditTeams(filters) {
  return request(`/api/download-audit/teams${query(filters)}`);
}

// One group: totals, the users who downloaded, and a page of sessions with
// their takes and downloads. filters: { from, to, userId, q, page, pageSize }.
export async function getAuditTeam(groupId, filters) {
  return request(`/api/download-audit/teams/${encodeURIComponent(groupId)}${query(filters)}`);
}

// Saves the log as a spreadsheet. Pass a group id for one team, or null for
// every group you administer.
export async function downloadAuditCsv(groupId, filters) {
  const path = groupId
    ? `/api/download-audit/teams/${encodeURIComponent(groupId)}/export.csv`
    : "/api/download-audit/export.csv";
  const res = await fetch(`${SERVER_URL}${path}${query(filters)}`, { credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Unable to export the log.");
  }

  // The file name comes from the server when its CORS settings expose the
  // header; otherwise this fallback is used.
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "download-audit.csv";

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

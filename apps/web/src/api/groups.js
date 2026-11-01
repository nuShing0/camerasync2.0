//backend URL used by the web app
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

//send a request with the user's login cookie
async function request(path, options = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    credentials: "include",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

//get the groups the current user belongs to
export async function getGroups() {
  const data = await request("/api/groups");
  return data.groups;
}

//get the roster for one of your groups
export async function getGroupMembers(id) {
  const data = await request(`/api/groups/${encodeURIComponent(id)}/members`);
  return data.members;
}

//create a new group
export async function createGroup(group) {
  const data = await request("/api/groups", {
    method: "POST",
    body: JSON.stringify(group),
  });
  return data.group;
}

// Rename the group (owner only).
export async function updateGroupDetails(id, { name }) {
  const data = await request(`/api/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  return data.group;
}

// The invite code in what someone typed or pasted: a bare code (ABC-DEF, any
// case) or a link ending in /join/<code>. "" when there's nothing to try.
export function inviteCodeFrom(text) {
  const trimmed = String(text ?? "").trim();
  const fromLink = trimmed.match(/\/join\/([A-Za-z0-9-]+)/);
  return (fromLink ? fromLink[1] : trimmed).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// ABCDEF as ABC-DEF, how codes are shown and read out.
export function formatInviteCode(code) {
  return code && code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code ?? "";
}

// What an invite shows before joining: the group's name, color and size, and
// whether you're in it.
export async function getInvite(code) {
  const data = await request(`/api/groups/invites/${encodeURIComponent(code)}`);
  return data.group;
}

// Join a group with its invite code.
export async function joinWithInvite(code) {
  const data = await request(`/api/groups/invites/${encodeURIComponent(code)}/join`, { method: "POST" });
  return data.group;
}

// A new invite for the group (admins); the old code, link and QR stop working.
export async function resetInvite(id) {
  const data = await request(`/api/groups/${encodeURIComponent(id)}/invite/reset`, { method: "POST" });
  return data.group;
}

// Ask to join a group by its exact ID. Resolves {status: "requested" |
// "member", group: {id, name}}.
export async function requestToJoin(groupId) {
  return request("/api/groups/requests", {
    method: "POST",
    body: JSON.stringify({ groupId }),
  });
}

// The group's waiting requests to join (admins).
export async function getJoinRequests(id) {
  const data = await request(`/api/groups/${encodeURIComponent(id)}/requests`);
  return data.requests;
}

export async function approveJoinRequest(id, userId) {
  await request(`/api/groups/${encodeURIComponent(id)}/requests/${userId}/approve`, { method: "POST" });
}

export async function declineJoinRequest(id, userId) {
  await request(`/api/groups/${encodeURIComponent(id)}/requests/${userId}`, { method: "DELETE" });
}

// Leave a group. The owner has to hand it to someone else first.
export async function leaveGroup(id) {
  await request(`/api/groups/${encodeURIComponent(id)}/leave`, { method: "POST" });
}

// Make another member the owner (owner only); the old owner stays an admin.
export async function transferGroup(id, userId) {
  const data = await request(`/api/groups/${encodeURIComponent(id)}/transfer`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  return data.group;
}

// Delete the group with all its sessions and recordings (owner only).
export async function deleteGroup(id) {
  await request(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

//change a group's team color (admins and the owner only)
export async function updateGroupColor(id, primaryColor) {
  const data = await request(`/api/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ primaryColor }),
  });
  return data.group;
}

export async function changeGroupMemberRole(groupId, memberId, role) {
  await request(`/api/groups/${encodeURIComponent(groupId)}/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function removeGroupMember(groupId, memberId) {
  await request(`/api/groups/${encodeURIComponent(groupId)}/members/${memberId}`, {
    method: "DELETE",
  });
}

// The user's primary group, whose color the app takes: the one saved on the
// account (Settings or a group's page), or else the first group they joined.
export function getPrimaryGroupId(user, groups) {
  const saved = user?.primaryGroupId;
  if (saved && groups.some((group) => group.id === saved)) return saved;
  let firstGroup = null;
  for (const group of groups) {
    if (!firstGroup || new Date(group.joinedAt || group.createdAt) <
        new Date(firstGroup.joinedAt || firstGroup.createdAt)) {
      firstGroup = group;
    }
  }
  return firstGroup?.id || "";
}

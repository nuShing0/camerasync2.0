import { pool } from "../db/pool.js";

// Group roles, weakest to strongest. Permission checks compare ranks
// ("at least a member") instead of listing role names at every call site.
// "owner" is not a stored role — the group owner keeps an admin row and the
// lookups below map them to it so they outrank the other admins.
export const ROLE_RANK = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export function atLeast(role, minRole) {
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK[minRole];
}

/// The user's effective role in a group, or null when they are not a member.
export async function getGroupRole(groupId, userId) {
  const { rows } = await pool.query(
    `SELECT gm.role, g.owner_id
       FROM group_members gm
       JOIN groups g ON g.group_id = gm.group_id
      WHERE gm.group_id = $1
        AND gm.user_id = $2`,
    [groupId, userId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].owner_id) === Number(userId) ? "owner" : rows[0].role;
}

/// The user's role in a recording session: their role in its group, or for
/// a session without a group, "owner" for whoever started it and "member"
/// for anyone who joined it with its code. Null when they can't see it.
export async function getSessionRole(sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT rs.group_id, rs.created_by, gm.role, g.owner_id,
            EXISTS (
              SELECT 1 FROM recording_session_participants p
               WHERE p.session_id = rs.id AND p.user_id = $2
            ) OR EXISTS (
              SELECT 1 FROM recording_session_members m
               WHERE m.session_id = rs.id AND m.user_id = $2
            ) AS joined
       FROM recording_sessions rs
       LEFT JOIN groups g ON g.group_id = rs.group_id
       LEFT JOIN group_members gm
         ON gm.group_id = rs.group_id AND gm.user_id = $2
      WHERE rs.id = $1`,
    [sessionId, userId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.group_id == null) {
    if (Number(row.created_by) === Number(userId)) return "owner";
    return row.joined ? "member" : null;
  }
  if (!row.role) return null;
  return Number(row.owner_id) === Number(userId) ? "owner" : row.role;
}

/// SQL that is true when `user` (a query parameter like "$2") can see the
/// session aliased `rs`: they're in its group, or it has no group and they
/// started or joined it. Mirrors getSessionRole for queries over many rows.
export function sessionVisibleSql(rs, user) {
  return `(
    EXISTS (SELECT 1 FROM group_members gm_v
             WHERE gm_v.group_id = ${rs}.group_id AND gm_v.user_id = ${user})
    OR (${rs}.group_id IS NULL AND (
      ${rs}.created_by = ${user}
      OR EXISTS (SELECT 1 FROM recording_session_participants p_v
                  WHERE p_v.session_id = ${rs}.id AND p_v.user_id = ${user})
      OR EXISTS (SELECT 1 FROM recording_session_members m_v
                  WHERE m_v.session_id = ${rs}.id AND m_v.user_id = ${user})
    ))
  )`;
}

/// Returns the group that a session belongs to, or null if sessionId is
///  invalid or refers to a standalone session
export function getGroupIdFromSessionId(sessionId) {
  const { rows } = pool.query(
    `SELECT group_id
     FROM recording_sessions
     WHERE id = $1`,
    [sessionId]
  );

  return rows[0]?.group_id ?? null;
}
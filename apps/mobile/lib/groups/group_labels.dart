import '../api/groups_api.dart';

const _shortMonths = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// The user's role in [group] as its badge says it: Owner, Admin, Member
/// or Viewer. The owner's role is also 'admin', so the owner is checked
/// first.
String groupRoleName(Group group, int? userId) {
  if (group.owner != null && group.owner == userId) return 'Owner';
  return switch (group.role) {
    'admin' => 'Admin',
    'viewer' => 'Viewer',
    _ => 'Member',
  };
}

/// "Oct 7": a session's day on group cards and tiles.
String shortDate(DateTime at) => '${_shortMonths[at.month - 1]} ${at.day}';

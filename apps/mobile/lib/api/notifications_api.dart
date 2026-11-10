import 'api_client.dart';

/// Something that happened in one of the user's groups, as shaped by the
/// server's `publicNotification` (apps/server/src/routes/notifications.js):
/// a comment on a recording, someone joining or asking to join, or a
/// session starting.
class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.at,
    required this.unread,
    required this.actorName,
    required this.groupId,
    required this.groupName,
    this.groupColor,
    this.sessionId,
    this.sessionName,
    this.sessionStatus,
    this.commentBody,
  });

  final String id;

  /// 'comment', 'join', 'request' (someone asked to join; only the group's
  /// admins get these) or 'session'.
  final String type;
  final DateTime at;

  /// It came after the user last looked at their notifications.
  final bool unread;
  final String actorName;
  final String groupId;
  final String groupName;
  final String? groupColor;
  final String? sessionId;
  final String? sessionName;
  final String? sessionStatus;
  final String? commentBody;

  bool get isLivePractice => type == 'session' && sessionStatus == 'active';

  factory AppNotification.fromJson(Map<String, dynamic> json) {
    final actor = Map<String, dynamic>.from(json['actor'] as Map);
    final group = Map<String, dynamic>.from(json['group'] as Map);
    final session =
        json['session'] == null ? null : Map<String, dynamic>.from(json['session'] as Map);
    final comment =
        json['comment'] == null ? null : Map<String, dynamic>.from(json['comment'] as Map);
    return AppNotification(
      id: json['id'].toString(),
      type: json['type'].toString(),
      at: DateTime.parse(json['at'].toString()).toLocal(),
      unread: json['unread'] == true,
      actorName: (actor['name'] ?? 'Someone').toString(),
      groupId: group['id'].toString(),
      groupName: (group['name'] ?? '').toString(),
      groupColor: group['primaryColor']?.toString(),
      sessionId: session?['id']?.toString(),
      sessionName: session?['name']?.toString(),
      sessionStatus: session?['status']?.toString(),
      commentBody: comment?['body']?.toString(),
    );
  }
}

class NotificationsApi {
  NotificationsApi(this._api);

  final ApiClient _api;

  /// The newest [limit] notifications, newest first.
  Future<List<AppNotification>> getNotifications({int limit = 20}) async {
    final data = await _api.get('/api/notifications?limit=$limit');
    final items = (data as Map)['notifications'] as List;
    return items
        .map((n) => AppNotification.fromJson(Map<String, dynamic>.from(n)))
        .toList();
  }

  /// Marks everything up to now as read.
  Future<void> markSeen() => _api.post('/api/notifications/seen');
}

/// "just now", "5m", "3h", "2d", then a short date, like the web app.
String timeAgo(DateTime at, {DateTime? now}) {
  final seconds = (now ?? DateTime.now()).difference(at).inSeconds;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return '${seconds ~/ 60}m';
  if (seconds < 86400) return '${seconds ~/ 3600}h';
  if (seconds < 7 * 86400) return '${seconds ~/ 86400}d';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return '${months[at.month - 1]} ${at.day}';
}

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../api/notifications_api.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../theme.dart';
import 'group_settings_screen.dart';
import 'watch_screen.dart';

/// Every notification from the last 30 days, newest first, like the web
/// app's Notifications page. Opening it marks them read; the ones that were
/// new stay highlighted while it's open.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen(
      {super.key, required this.auth, required this.onOpenRecord});

  final AuthService auth;

  /// Shows the Record tab, where a live practice can be joined.
  final VoidCallback onOpenRecord;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  late final NotificationsApi _api = NotificationsApi(widget.auth.api);
  List<AppNotification>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final items = await _api.getNotifications(limit: 50);
      if (!mounted) return;
      setState(() => _items = items);
      if (items.any((n) => n.unread)) _api.markSeen().catchError((_) {});
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: kBackground,
      appBar: AppBar(
        backgroundColor: kBackground,
        title: const Text('Notifications'),
      ),
      body: _error != null
          ? _Message(_error!)
          : items == null
              ? const Center(child: CircularProgressIndicator())
              : items.isEmpty
                  ? const _Message('Nothing yet.')
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                      itemCount: items.length,
                      separatorBuilder: (_, __) =>
                          const Divider(height: 1, color: kSurfaceLight),
                      itemBuilder: (context, i) => NotificationTile(
                        notification: items[i],
                        showComment: true,
                        onTap: () => openNotification(
                          context,
                          widget.auth,
                          items[i],
                          onOpenRecord: () {
                            Navigator.of(context).pop();
                            widget.onOpenRecord();
                          },
                        ),
                      ),
                    ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(text,
              textAlign: TextAlign.center,
              style: const TextStyle(color: kMuted)),
        ),
      );
}

/// One notification: the group's color dot, what happened, how long ago.
/// Unread ones are brighter. Used on Home and the full list.
class NotificationTile extends StatelessWidget {
  const NotificationTile({
    super.key,
    required this.notification,
    required this.onTap,
    this.showComment = false,
  });

  final AppNotification notification;
  final VoidCallback onTap;

  /// The full list has room to quote the comment and wrap onto two lines;
  /// Home keeps each one to a single line so the section fits on screen.
  final bool showComment;

  @override
  Widget build(BuildContext context) {
    final n = notification;
    final color = n.unread ? Colors.white : const Color(0xFFA0A0A0);
    final bold = TextStyle(
        fontWeight: n.unread ? FontWeight.w700 : FontWeight.w600);
    final (verb, subject) = switch (n.type) {
      'comment' => (' commented on ', n.sessionName ?? 'a recording'),
      'join' => (' joined ', n.groupName),
      'request' => (' asked to join ', n.groupName),
      _ => (' started ', n.sessionName ?? 'a session'),
    };

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: CircleAvatar(
                radius: 5,
                backgroundColor: parseHexColor(n.groupColor) ?? kGold,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text.rich(
                    TextSpan(children: [
                      TextSpan(text: n.actorName, style: bold),
                      TextSpan(text: verb),
                      TextSpan(text: subject, style: bold),
                      if (n.isLivePractice)
                        TextSpan(
                          text: ' · Live now',
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                    ]),
                    maxLines: showComment ? 2 : 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: color, fontSize: 14, height: 1.3),
                  ),
                  if (showComment && n.commentBody != null) ...[
                    const SizedBox(height: 3),
                    Text(
                      '"${n.commentBody}"',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: kMuted, fontSize: 13),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 10),
            Text(timeAgo(n.at),
                style: const TextStyle(color: kMuted, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}

/// Opens what a notification is about: the recording for a comment, the
/// group page for a join or a request to join (to approve it there), and for
/// a session the Record tab while it's live (to join it) or its recording
/// once it's over. Same rules as the web app.
Future<void> openNotification(
  BuildContext context,
  AuthService auth,
  AppNotification n, {
  required VoidCallback onOpenRecord,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);
  void gone(String what) => messenger
      .showSnackBar(SnackBar(content: Text('That $what is no longer available.')));

  if (n.isLivePractice) {
    onOpenRecord();
    return;
  }
  try {
    if (n.type == 'join' || n.type == 'request') {
      final groups = await GroupsApi(auth.api).getMyGroups();
      final group = groups.where((g) => g.id == n.groupId).firstOrNull;
      if (group == null) return gone('group');
      await navigator.push(MaterialPageRoute(
          builder: (_) => GroupSettingsScreen(auth: auth, group: group)));
      return;
    }
    final sessions = await RecordingsApi(auth.api).getSessions();
    final session = sessions.where((s) => s.id == n.sessionId).firstOrNull;
    if (session == null) return gone('recording');
    await navigator.push(MaterialPageRoute(
        builder: (_) => WatchScreen(auth: auth, session: session)));
  } on ApiException catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  }
}

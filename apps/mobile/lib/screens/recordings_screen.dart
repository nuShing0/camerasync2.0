import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/auto_refresh.dart';
import '../widgets/empty_state.dart';
import 'watch_screen.dart';

const _monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/// Finished sessions with something to watch, newest first.
List<RecordingSession> pastSessionsOf(Iterable<RecordingSession> sessions) =>
    sessions
        .where((s) => s.isComplete)
        // Nothing to watch: a session that ended without recording.
        .where((s) => s.recordingCount != 0)
        .toList()
      ..sort((a, b) {
        final at = a.scheduledAt?.millisecondsSinceEpoch ?? 0;
        final bt = b.scheduledAt?.millisecondsSinceEpoch ?? 0;
        return bt.compareTo(at);
      });

/// Asks before deleting [session] and its videos.
Future<bool> confirmDeleteSession(
    BuildContext context, RecordingSession session) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(
          "Delete ${session.name} and all its videos? This can't be undone."),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          style: FilledButton.styleFrom(backgroundColor: kLiveRed),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
  return ok == true;
}

/// A group's finished sessions (or everyone's), on their own page: the
/// Groups pages' "View all". The Sessions tab shows the same grid under its
/// live sessions.
class RecordingsScreen extends StatefulWidget {
  const RecordingsScreen({
    super.key,
    required this.auth,
    this.groupId,
    this.title,
  });

  final AuthService auth;
  final String? groupId;
  final String? title;

  @override
  State<RecordingsScreen> createState() => _RecordingsScreenState();
}

class _RecordingsScreenState extends State<RecordingsScreen> {
  late final RecordingsApi _recordings = RecordingsApi(widget.auth.api);
  late final GroupsApi _groups = GroupsApi(widget.auth.api);

  List<RecordingSession> _sessions = [];
  Map<String, String> _groupNames = {};

  /// Groups where this user is an admin (or the owner): they can delete
  /// those groups' sessions.
  Set<String> _adminGroups = {};
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    // A session that just ended (or a new upload) appears on its own.
    _refresher = AutoRefresher(const Duration(seconds: 20), _load);
  }

  late final AutoRefresher _refresher;

  @override
  void dispose() {
    _refresher.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      // A spinner only the first time; refreshes keep the list on screen.
      _loading = _sessions.isEmpty;
      _error = null;
    });
    try {
      final results = await Future.wait([
        _recordings.getSessions(),
        _groups.getMyGroups().catchError((_) => <Group>[]),
      ]);
      final sessions = pastSessionsOf((results[0] as List<RecordingSession>)
          .where((s) => widget.groupId == null || s.groupId == widget.groupId));
      if (!mounted) return;
      setState(() {
        _sessions = sessions;
        _groupNames = {
          for (final g in results[1] as List<Group>) g.id: g.name,
        };
        _adminGroups = {
          for (final g in results[1] as List<Group>)
            if (g.role == 'admin') g.id,
        };
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _delete(RecordingSession session) async {
    if (!await confirmDeleteSession(context, session) || !mounted) return;
    try {
      await _recordings.deleteSession(session.id);
      if (mounted) {
        setState(() => _sessions = [
              for (final s in _sessions)
                if (s.id != session.id) s,
            ]);
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  void _open(RecordingSession session) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => WatchScreen(auth: widget.auth, session: session),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kBackground,
      appBar: AppBar(
        backgroundColor: kBackground,
        foregroundColor: Colors.white,
        title: Text(
          widget.title ?? 'Sessions',
          style: TextStyle(
            color: TeamAccent.of(context).accent,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.3,
          ),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
                children: [
                  if (_error != null)
                    EmptyState(
                      title: "Couldn't load sessions",
                      message: _error!,
                      actionLabel: 'Retry',
                      onAction: _load,
                    )
                  else if (_sessions.isEmpty)
                    EmptyState(
                      title: 'No sessions to watch yet',
                      message: widget.groupId == null
                          ? 'Finished sessions from your groups show up here '
                              'once their recordings upload.'
                          : 'This group has no finished sessions yet.',
                    )
                  else
                    PastSessionsGrid(
                      sessions: _sessions,
                      groupNameOf: (s) => _groupNames[s.groupId],
                      thumbnailOf: _recordings.thumbnailOf,
                      onOpen: _open,
                      onDelete: (s) => _adminGroups.contains(s.groupId)
                          ? () => _delete(s)
                          : null,
                    ),
                ],
              ),
      ),
    );
  }
}

/// Finished sessions two to a row, under month headings (THIS MONTH,
/// OCTOBER, ...). Not scrollable itself: it goes in the page's list.
class PastSessionsGrid extends StatelessWidget {
  const PastSessionsGrid({
    super.key,
    required this.sessions,
    required this.groupNameOf,
    required this.thumbnailOf,
    required this.onOpen,
    required this.onDelete,
  });

  /// Newest first.
  final List<RecordingSession> sessions;
  final String? Function(RecordingSession) groupNameOf;
  final ImageProvider? Function(RecordingSession) thumbnailOf;
  final void Function(RecordingSession) onOpen;

  /// The Delete in a session's ··· menu; null for those who can't.
  final VoidCallback? Function(RecordingSession) onDelete;

  static String _monthOf(DateTime? at) {
    if (at == null) return 'EARLIER';
    final now = DateTime.now();
    if (at.year == now.year && at.month == now.month) return 'THIS MONTH';
    final month = _monthNames[at.month - 1].toUpperCase();
    return at.year == now.year ? month : '$month ${at.year}';
  }

  @override
  Widget build(BuildContext context) {
    // Consecutive runs of the same month, in the list's order.
    final months = <(String, List<RecordingSession>)>[];
    for (final s in sessions) {
      final label = _monthOf(s.scheduledAt);
      if (months.isEmpty || months.last.$1 != label) months.add((label, []));
      months.last.$2.add(s);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (label, items) in months) ...[
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              label,
              style: const TextStyle(
                color: kMuted,
                fontSize: 11,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6,
              ),
            ),
          ),
          for (var i = 0; i < items.length; i += 2)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (var j = i; j < i + 2; j++) ...[
                    if (j > i) const SizedBox(width: 12),
                    Expanded(
                      child: j < items.length
                          ? SessionVideoCard(
                              session: items[j],
                              groupName: groupNameOf(items[j]),
                              thumbnail: thumbnailOf(items[j]),
                              onTap: () => onOpen(items[j]),
                              onDelete: onDelete(items[j]),
                            )
                          : const SizedBox(),
                    ),
                  ],
                ],
              ),
            ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

/// One finished session: a 16:9 still with its number of recordings on it,
/// the name and "Oct 29 · group" underneath. Home's recent row and the
/// Sessions grid both use it.
class SessionVideoCard extends StatelessWidget {
  const SessionVideoCard({
    super.key,
    required this.session,
    required this.onTap,
    this.groupName,
    this.thumbnail,
    this.onDelete,
  });

  final RecordingSession session;
  final String? groupName;
  final VoidCallback onTap;

  /// A still from the session; a play mark on gray until there is one.
  final ImageProvider? thumbnail;

  /// Shown as Delete in a ··· menu on the still, for group admins and the
  /// owner.
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final at = session.scheduledAt;
    final takes = session.recordingCount;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: AspectRatio(
              aspectRatio: 16 / 9,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Container(
                    color: kSurface,
                    alignment: Alignment.center,
                    child: Icon(Icons.play_circle_fill,
                        color: team.accent, size: 34),
                  ),
                  if (thumbnail != null)
                    Image(
                      image: thumbnail!,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => const SizedBox(),
                    ),
                  if (takes != null)
                    Positioned(
                      right: 6,
                      bottom: 6,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.72),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                            '$takes ${takes == 1 ? 'recording' : 'recordings'}',
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 10,
                                fontWeight: FontWeight.w700)),
                      ),
                    ),
                  if (onDelete != null)
                    Positioned(
                      right: 0,
                      top: 0,
                      child: PopupMenuButton<String>(
                        tooltip: 'Options for ${session.name}',
                        color: const Color(0xFF1C1C1C),
                        onSelected: (_) => onDelete!(),
                        itemBuilder: (_) => const [
                          PopupMenuItem(
                            value: 'delete',
                            child: Text('Delete',
                                style: TextStyle(color: kLiveRed)),
                          ),
                        ],
                        // A small dark tab on the still, in a bigger target.
                        child: Padding(
                          padding: const EdgeInsets.all(6),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.7),
                              borderRadius: BorderRadius.circular(7),
                            ),
                            child: const Text('···',
                                style: TextStyle(
                                    color: Colors.white,
                                    fontSize: 12,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 1)),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(session.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 14,
                  fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(
            [
              if (at != null)
                '${_monthNames[at.month - 1].substring(0, 3)} ${at.day}',
              if (groupName != null) groupName!,
            ].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: kMuted, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

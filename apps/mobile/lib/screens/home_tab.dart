import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../api/notifications_api.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../config.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/auto_refresh.dart';
import 'calendar_tab.dart';
import 'notifications_screen.dart';
import 'session_screen.dart';
import 'watch_screen.dart';

/// Home dashboard, like the web's: the greeting with a line of counts,
/// what's next (live and upcoming sessions, swipeable), recent sessions as
/// big video cards, this week's sessions and the newest notifications.
class HomeTab extends StatefulWidget {
  const HomeTab({
    super.key,
    required this.auth,
    required this.onOpenSessions,
    required this.onOpenSettings,
    required this.onOpenGroups,
    required this.onOpenCalendar,
  });

  final AuthService auth;

  /// Lets the quick-action buttons jump to another tab in the shell.
  /// Opens the Sessions tab, on Live & upcoming or on Past.
  final void Function({required bool upcoming}) onOpenSessions;

  final VoidCallback onOpenSettings;

  /// Switches to the Groups tab.
  final VoidCallback onOpenGroups;

  /// Switches to the Calendar tab.
  final VoidCallback onOpenCalendar;

  @override
  State<HomeTab> createState() => _HomeTabState();
}

class _HomeTabState extends State<HomeTab> {
  late final RecordingsApi _recordings = RecordingsApi(widget.auth.api);
  late final GroupsApi _groups = GroupsApi(widget.auth.api);
  late final NotificationsApi _notificationsApi =
      NotificationsApi(widget.auth.api);

  List<RecordingSession> _sessions = [];
  List<Group>? _myGroups;
  int? get _groupCount => _myGroups?.length;
  String? _joiningId;
  int _page = 0;
  List<AppNotification>? _notifications;

  /// Home shows the newest few; View all has the rest.
  static const _notificationsOnHome = 3;

  @override
  void initState() {
    super.initState();
    _load();
    // A practice that starts shows up in the banner within seconds.
    _refresher = AutoRefresher(const Duration(seconds: 10), _load);
  }

  late final AutoRefresher _refresher;

  @override
  void dispose() {
    _refresher.dispose();
    super.dispose();
  }

  /// Showing them here counts as seeing them; they stay highlighted until the
  /// next load, like the web dashboard.
  Future<void> _loadNotifications() async {
    try {
      final items =
          await _notificationsApi.getNotifications(limit: _notificationsOnHome);
      if (!mounted) return;
      setState(() => _notifications = items);
      if (items.any((n) => n.unread)) {
        _notificationsApi.markSeen().catchError((_) {});
      }
    } catch (_) {
      if (mounted) setState(() => _notifications ??= const []);
    }
  }

  void _openNotifications() {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => NotificationsScreen(
          auth: widget.auth,
          onOpenRecord: () => widget.onOpenSessions(upcoming: true),
        ),
      ),
    );
  }

  /// The dashboard renders fine with whatever loads; a dead server just
  /// leaves the counts and carousel empty.
  Future<void> _load() async {
    await Future.wait([
      () async {
        try {
          _sessions = await _recordings.getSessions();
        } catch (_) {}
      }(),
      () async {
        try {
          _myGroups = await _groups.getMyGroups();
        } catch (_) {}
      }(),
      _loadNotifications(),
    ]);
    if (mounted) setState(() {});
  }

  /// Takes across the user's sessions.
  int get _recordingCount =>
      _sessions.fold(0, (n, s) => n + (s.recordingCount ?? 0));

  String get _greeting {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  String get _firstName {
    final name = widget.auth.user?.displayName ?? '';
    return name.split(RegExp(r'[\s@]')).first;
  }

  /// Newest completed sessions, for the Recent Recordings panel.
  List<RecordingSession> get _recentRecordings {
    // Finished sessions with something to watch.
    final done =
        _sessions.where((s) => s.isComplete && s.recordingCount != 0).toList()
          ..sort((a, b) {
            final at = a.scheduledAt?.millisecondsSinceEpoch ?? 0;
            final bt = b.scheduledAt?.millisecondsSinceEpoch ?? 0;
            return bt.compareTo(at);
          });
    return done.take(10).toList();
  }

  String? _groupName(String? id) {
    for (final g in _myGroups ?? const <Group>[]) {
      if (g.id == id) return g.name;
    }
    return null;
  }

  void _watch(RecordingSession session) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => WatchScreen(auth: widget.auth, session: session),
      ),
    );
  }

  /// Right now: sessions live or open to join. Swiped between when there
  /// are several; upcoming ones are in This Week (and the calendar).
  List<RecordingSession> get _bannerSessions => [
        ..._sessions.where((s) => s.isActive),
        ..._sessions.where(_bannerJoinable),
      ];

  /// Live, and scheduled over the next 7 days, soonest first.
  List<RecordingSession> get _thisWeek {
    final now = DateTime.now();
    final end = DateTime(now.year, now.month, now.day + 7);
    return (_sessions
            .where((s) =>
                s.isScheduled &&
                !_bannerJoinable(s) &&
                s.scheduledAt != null &&
                s.scheduledAt!.isAfter(now) &&
                s.scheduledAt!.isBefore(end))
            .toList()
          ..sort((a, b) => (a.scheduledAt ?? DateTime(0))
              .compareTo(b.scheduledAt ?? DateTime(0))))
        .toList();
  }

  /// A few, so Notifications fits on the first screen; the calendar has
  /// the rest.
  static const _weekOnHome = 3;

  Color _groupColor(String? id) {
    for (final g in _myGroups ?? const <Group>[]) {
      if (g.id == id) {
        return parseHexColor(g.primaryColor) ?? TeamAccent.of(context).fill;
      }
    }
    return TeamAccent.of(context).fill;
  }

  Future<void> _join(RecordingSession session) async {
    if (_joiningId != null) return;
    setState(() => _joiningId = session.id);

    try {
      // REST join first: it records membership (and activates a scheduled
      // session), which the socket room checks before letting us in.
      final joined = await _recordings.joinSession(session.id);
      if (!mounted) return;

      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => SessionScreen(
            serverUrl: kServerUrl,
            auth: widget.auth,
            sessionId: joined.id,
            sessionName: joined.name,
          ),
        ),
      );

      if (mounted) _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _joiningId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final banners = _bannerSessions;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 110),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '$_greeting, $_firstName',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 26,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              IconButton(
                onPressed: widget.onOpenSettings,
                tooltip: 'Settings',
                color: Colors.white,
                icon: const Icon(Icons.settings_outlined, size: 26),
              ),
            ],
          ),
          const SizedBox(height: 6),
          // The counts, small: each a way into its page.
          DefaultTextStyle(
            style: const TextStyle(color: kMuted, fontSize: 14),
            child: Wrap(
              spacing: 6,
              children: [
                _CountLink(
                  label:
                      '${_groupCount ?? '—'} ${_groupCount == 1 ? 'group' : 'groups'}',
                  onTap: widget.onOpenGroups,
                ),
                const Text('·'),
                _CountLink(
                  label:
                      '${_sessions.length} ${_sessions.length == 1 ? 'session' : 'sessions'}',
                  onTap: () => widget.onOpenSessions(upcoming: false),
                ),
                const Text('·'),
                Text(
                    '$_recordingCount ${_recordingCount == 1 ? 'recording' : 'recordings'}'),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Right now: swipe between sessions live or open to join. Nothing
          // here otherwise; upcoming ones are in This Week.
          if (banners.isNotEmpty) ...[
            SizedBox(
              height: 112,
              child: PageView.builder(
                itemCount: banners.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (context, i) => _SessionBanner(
                  session: banners[i],
                  groupName: _groupName(banners[i].groupId),
                  joining: _joiningId == banners[i].id,
                  onJoin: () => _join(banners[i]),
                ),
              ),
            ),
            if (banners.length > 1) ...[
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var i = 0; i < banners.length; i++)
                    Container(
                      width: 6,
                      height: 6,
                      margin: const EdgeInsets.symmetric(horizontal: 3),
                      decoration: BoxDecoration(
                        color: i == _page
                            ? TeamAccent.of(context).accent
                            : const Color(0xFF3A3A3A),
                        shape: BoxShape.circle,
                      ),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 22),
          ] else
            const SizedBox(height: 8),

          _HeaderRow(
            title: 'Recent Sessions',
            onViewAll: _recentRecordings.isEmpty
                ? null
                : () => widget.onOpenSessions(upcoming: false),
          ),
          const SizedBox(height: 10),
          if (_recentRecordings.isEmpty)
            _EmptyNote(
              icon: Icons.videocam_outlined,
              title: 'No recordings yet',
              message: _groupCount == 0
                  ? "Join a team first. Its sessions' recordings show up here."
                  : "Recordings from your team's sessions show up here to watch.",
            )
          else
            // Big video cards, swiped sideways; the next one peeks in at the
            // edge, which shows the row scrolls.
            LayoutBuilder(builder: (context, constraints) {
              // Two side by side with a third peeking in.
              final cardWidth = constraints.maxWidth * 0.44;
              return SizedBox(
                height: cardWidth * 9 / 16 + 48,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  clipBehavior: Clip.none,
                  itemCount: _recentRecordings.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 14),
                  itemBuilder: (context, i) {
                    final s = _recentRecordings[i];
                    return _RecordingTile(
                      width: cardWidth,
                      session: s,
                      groupName: _groupName(s.groupId),
                      thumbnail: _recordings.thumbnailOf(s),
                      onTap: () => _watch(s),
                    );
                  },
                ),
              );
            }),
          const SizedBox(height: 22),

          _HeaderRow(
            title: 'This Week',
            // The rest of the week is on the calendar.
            linkLabel: _thisWeek.length > _weekOnHome
                ? '+${_thisWeek.length - _weekOnHome} more'
                : 'Calendar',
            onViewAll: widget.onOpenCalendar,
          ),
          const SizedBox(height: 10),
          if (_thisWeek.isEmpty)
            const _EmptyNote(
              icon: Icons.calendar_today_outlined,
              title: 'Nothing scheduled this week',
              message: 'Scheduled sessions show up here.',
            )
          else ...[
            for (final s in _thisWeek.take(_weekOnHome))
              _WeekRow(
                session: s,
                upNext: s == _thisWeek.first,
                color: _groupColor(s.groupId),
                groupName: _groupName(s.groupId),
                joining: _joiningId == s.id,
                onTap: _bannerJoinable(s)
                    ? () => _join(s)
                    : () => openCalendarDay(
                        context, widget.auth, s.scheduledAt ?? DateTime.now()),
              ),
          ],
          const SizedBox(height: 22),

          _HeaderRow(
            title: 'Notifications',
            onViewAll:
                (_notifications?.isEmpty ?? true) ? null : _openNotifications,
          ),
          const SizedBox(height: 8),
          // A plain list, no box around it.
          Container(
            child: (_notifications?.isEmpty ?? true)
                ? _notifications == null
                    ? const Text('Loading…',
                        style: TextStyle(color: kMuted, fontSize: 14))
                    : const _EmptyNote(
                        icon: Icons.notifications_none,
                        title: "You're all caught up",
                        message: 'Comments, new teammates and sessions '
                            'starting show up here.',
                      )
                : Column(
                    children: [
                      for (final n in _notifications!)
                        NotificationTile(
                          notification: n,
                          onTap: () => openNotification(
                            context,
                            widget.auth,
                            n,
                            onOpenRecord: () =>
                                widget.onOpenSessions(upcoming: true),
                          ),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: const TextStyle(
        // White: the team color is kept for what you act on.
        color: Colors.white,
        fontSize: 18,
        fontWeight: FontWeight.w700,
      ),
    );
  }
}

/// A section title with an optional link ("View all") on the right.
class _HeaderRow extends StatelessWidget {
  const _HeaderRow(
      {required this.title, this.onViewAll, this.linkLabel = 'View all'});

  final String title;
  final VoidCallback? onViewAll;
  final String linkLabel;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(child: _SectionHeader(title)),
        if (onViewAll != null)
          TextButton(
            onPressed: onViewAll,
            style: TextButton.styleFrom(
              foregroundColor: TeamAccent.of(context).accent,
              padding: EdgeInsets.zero,
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(linkLabel),
          ),
      ],
    );
  }
}

/// A scheduled session whose start time has come: it can be joined from
/// then until 15 minutes after (the server's rule).
bool _bannerJoinable(RecordingSession s) {
  final at = s.scheduledAt;
  if (!s.isScheduled || at == null) return false;
  final since = DateTime.now().difference(at);
  return !since.isNegative && since <= const Duration(minutes: 15);
}

/// "in 15 h", "in 40 min", "in 3 days".
String _until(DateTime at) {
  final minutes = at.difference(DateTime.now()).inMinutes;
  if (minutes < 1) return 'now';
  if (minutes < 60) return 'in $minutes min';
  final hours = (minutes / 60).round();
  if (hours < 48) return 'in $hours h';
  return 'in ${(hours / 24).round()} days';
}

String _clock(DateTime at) {
  final time = TimeOfDay.fromDateTime(at);
  return '${time.hourOfPeriod == 0 ? 12 : time.hourOfPeriod}:'
      '${time.minute.toString().padLeft(2, '0')} '
      '${time.period == DayPeriod.am ? 'AM' : 'PM'}';
}

/// "Today", "Tomorrow", or "Sat 10/24".
String _dayLabel(DateTime at) {
  final now = DateTime.now();
  bool same(DateTime d) =>
      d.year == at.year && d.month == at.month && d.day == at.day;
  if (same(now)) return 'Today';
  if (same(DateTime(now.year, now.month, now.day + 1))) return 'Tomorrow';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return '${days[at.weekday - 1]} ${at.month}/${at.day}';
}

/// One count under the greeting, tappable.
class _CountLink extends StatelessWidget {
  const _CountLink({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Text(label, style: const TextStyle(color: Color(0xFFD0D0D0))),
      );
}

/// A session happening right now (live, or its start time has come), in
/// the team color with Join: the one thing to do now.
class _SessionBanner extends StatelessWidget {
  const _SessionBanner({
    required this.session,
    required this.groupName,
    required this.joining,
    required this.onJoin,
  });

  final RecordingSession session;
  final String? groupName;
  final bool joining;
  final VoidCallback onJoin;

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final ink = team.ink;
    final faint = team.ink.withValues(alpha: 0.65);
    final at = session.scheduledAt;
    final devices = session.activeMemberCount;

    final tag = session.isActive ? 'Live now' : 'Starting now';
    final detail = [
      if (groupName != null) groupName!,
      if (session.isActive)
        '$devices ${devices == 1 ? 'device' : 'devices'}'
      else if (at != null)
        '${_dayLabel(at)}, ${_clock(at)}',
    ].join(' · ');

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 2),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      decoration: BoxDecoration(
        color: team.fill,
        borderRadius: BorderRadius.circular(24),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Row(
                  children: [
                    if (session.isActive) ...[
                      Container(
                        width: 8,
                        height: 8,
                        decoration: const BoxDecoration(
                            color: kLiveRed, shape: BoxShape.circle),
                      ),
                      const SizedBox(width: 6),
                    ],
                    Text(
                      tag,
                      style: TextStyle(
                        color: ink.withValues(alpha: 0.87),
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  session.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      color: ink, fontSize: 20, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 4),
                Text(detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: faint, fontSize: 14)),
              ],
            ),
          ),
          const SizedBox(width: 12),
          FilledButton(
            onPressed: joining ? null : onJoin,
            style: FilledButton.styleFrom(
              backgroundColor: team.ink,
              foregroundColor: team.fill,
              shape: const StadiumBorder(),
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
            ),
            child: joining
                ? SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: team.fill),
                  )
                // Enter when already in it, as on the web.
                : Text(session.isJoined && session.isActive ? 'Enter' : 'Join',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
          )
        ],
      ),
    );
  }
}

/// One recent session: a big 16:9 still with its number of takes on it,
/// the name and date underneath.
class _RecordingTile extends StatelessWidget {
  const _RecordingTile({
    required this.session,
    required this.onTap,
    required this.width,
    this.groupName,
    this.thumbnail,
  });

  final RecordingSession session;
  final String? groupName;
  final VoidCallback onTap;
  final double width;

  /// A still from the session; a play mark on gray until there is one.
  final ImageProvider? thumbnail;

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final at = session.scheduledAt;
    final takes = session.recordingCount;
    return SizedBox(
      width: width,
      child: GestureDetector(
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
                      color: const Color(0xFF161616),
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
                        right: 8,
                        bottom: 8,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: Colors.black.withValues(alpha: 0.75),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                              '$takes ${takes == 1 ? 'recording' : 'recordings'}',
                              style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 11,
                                  fontWeight: FontWeight.w600)),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(session.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 15,
                    fontWeight: FontWeight.w700)),
            Text(
              [
                if (at != null) '${at.month}/${at.day}',
                if (groupName != null) groupName!,
              ].join(' · '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: kMuted, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}

/// One of this week's sessions: a plain row with a dot in its group's
/// color. Live ones get the red dot; one open to join shows its time in the
/// accent color, ending in Join.
class _WeekRow extends StatelessWidget {
  const _WeekRow({
    required this.session,
    required this.color,
    required this.groupName,
    required this.joining,
    required this.onTap,
    this.upNext = false,
  });

  final RecordingSession session;

  /// The soonest one: marked "Up next" with a countdown.
  final bool upNext;
  final Color color;
  final String? groupName;
  final bool joining;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final at = session.scheduledAt;
    final open = _bannerJoinable(session);
    final when = session.isActive
        ? 'Live now'
        : at == null
            ? ''
            : '${_dayLabel(at)}, ${_clock(at)}';
    // A plain row like the notifications below: a thin line under it, no
    // box.
    return DecoratedBox(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFF242424))),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: joining ? null : onTap,
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // The group's color as a dot, like each notification's,
                // beside the session's name.
                Padding(
                  padding: EdgeInsets.fromLTRB(4, upNext ? 31 : 16, 12, 0),
                  child: CircleAvatar(radius: 5, backgroundColor: color),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(0, 10, 12, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (upNext && at != null)
                          Text(
                            'Up next · ${_until(at)}',
                            style: TextStyle(
                              color: TeamAccent.of(context).accent,
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        Row(children: [
                          if (session.isActive) ...[
                            Container(
                              width: 8,
                              height: 8,
                              decoration: const BoxDecoration(
                                  color: kLiveRed, shape: BoxShape.circle),
                            ),
                            const SizedBox(width: 6),
                          ],
                          Expanded(
                            child: Text(session.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w700)),
                          ),
                        ]),
                        const SizedBox(height: 2),
                        Text(
                          [
                            when,
                            if (groupName != null) groupName!,
                            if (open) joining ? 'Joining…' : 'Join',
                          ].where((p) => p.isNotEmpty).join(' · '),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color:
                                open ? TeamAccent.of(context).accent : kMuted,
                            fontSize: 13,
                            fontWeight:
                                open ? FontWeight.w600 : FontWeight.normal,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// An empty section, like the web's: an icon in the team color, a short
/// title and a helpful line.
class _EmptyNote extends StatelessWidget {
  const _EmptyNote(
      {required this.icon, required this.title, required this.message});

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: const BoxDecoration(
                color: Color(0xFF161616), shape: BoxShape.circle),
            child: Icon(icon, size: 20, color: TeamAccent.of(context).accent),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 2),
                Text(title,
                    style: const TextStyle(
                        color: Color(0xFFE8E8E8),
                        fontSize: 15,
                        fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(message,
                    style: const TextStyle(color: kMuted, fontSize: 13)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

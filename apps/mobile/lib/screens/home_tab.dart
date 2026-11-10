import 'package:flutter/material.dart';

import '../api/groups_api.dart';
import '../api/notifications_api.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/auto_refresh.dart';
import '../widgets/live_card.dart';
import 'calendar_tab.dart';
import 'notifications_screen.dart';
import 'recordings_screen.dart';
import 'watch_screen.dart';

const _weekdayNames = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

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

bool _sameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

/// Home: the date and greeting, then one card for what's happening (the
/// live card while a session is live, else the next scheduled one, else
/// nothing), this week as a strip of days with its sessions, recent
/// sessions as big video cards and the newest notifications.
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

  /// Switches to the Sessions tab.
  final VoidCallback onOpenSessions;

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
  String? _joiningId;
  List<AppNotification>? _notifications;

  /// Home shows the newest few; View all has the rest.
  static const _notificationsOnHome = 3;

  @override
  void initState() {
    super.initState();
    _load();
    // A session that starts shows up in the live card within seconds.
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
          onOpenRecord: widget.onOpenSessions,
        ),
      ),
    );
  }

  /// The dashboard renders fine with whatever loads; a dead server just
  /// leaves the sections empty.
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

  /// Newest completed sessions, for the Recent sessions row.
  List<RecordingSession> get _recentRecordings =>
      pastSessionsOf(_sessions).take(10).toList();

  Group? _groupOf(String? id) {
    for (final g in _myGroups ?? const <Group>[]) {
      if (g.id == id) return g;
    }
    return null;
  }

  String? _groupName(String? id) => _groupOf(id)?.name;

  /// The session's group color, readable on black (for dots and labels);
  /// the team color for a session without one.
  Color _groupColor(String? id) => legibleOnDark(
      parseHexColor(_groupOf(id)?.primaryColor) ?? TeamAccent.of(context).fill);

  void _watch(RecordingSession session) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => WatchScreen(auth: widget.auth, session: session),
      ),
    );
  }

  /// The soonest scheduled session still ahead, for the Next up card when
  /// nothing's live.
  RecordingSession? get _nextUp {
    final now = DateTime.now();
    RecordingSession? next;
    for (final s in _sessions) {
      final at = s.scheduledAt;
      if (!s.isScheduled || at == null || !at.isAfter(now)) continue;
      if (next == null || at.isBefore(next.scheduledAt!)) next = s;
    }
    return next;
  }

  /// Monday of this week.
  DateTime get _weekStart {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day - (now.weekday - 1));
  }

  /// This week's sessions still to come (live, open to join, or scheduled
  /// ahead), soonest first. Live ones are listed even if they started
  /// before Monday.
  List<RecordingSession> get _thisWeek {
    final now = DateTime.now();
    final start = _weekStart;
    final end = DateTime(start.year, start.month, start.day + 7);
    bool inWeek(DateTime? at) =>
        at != null && !at.isBefore(start) && at.isBefore(end);
    return _sessions
        .where((s) =>
            s.isActive ||
            (isOpenToJoin(s) && inWeek(s.scheduledAt)) ||
            (s.isScheduled &&
                inWeek(s.scheduledAt) &&
                s.scheduledAt!.isAfter(now)))
        .toList()
      ..sort((a, b) => (a.scheduledAt ?? DateTime(0))
          .compareTo(b.scheduledAt ?? DateTime(0)));
  }

  Future<void> _join(RecordingSession session) async {
    if (_joiningId != null) return;
    setState(() => _joiningId = session.id);
    try {
      await enterSession(context, widget.auth, session);
    } finally {
      if (mounted) setState(() => _joiningId = null);
    }
    if (mounted) _load();
  }

  void _openDay(DateTime day) => openCalendarDay(context, widget.auth, day);

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final live = liveNow(_sessions);
    final nextUp = live.isEmpty ? _nextUp : null;
    final week = _thisWeek;
    // The Next up card already shows that one.
    final weekList = [
      for (final s in week)
        if (s.id != nextUp?.id) s,
    ];

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 110),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${_weekdayNames[now.weekday - 1]}, '
                  '${_monthNames[now.month - 1]} ${now.day}',
                  style: const TextStyle(color: kMuted, fontSize: 13),
                ),
              ),
              IconButton(
                onPressed: widget.onOpenSettings,
                tooltip: 'Settings',
                color: Colors.white,
                icon: const Icon(Icons.settings_outlined, size: 24),
              ),
            ],
          ),
          Text(
            '$_greeting, $_firstName',
            style: const TextStyle(
              color: Colors.white,
              fontSize: 28,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 20),

          // The one card for what's happening: live (swipe between several),
          // else what's next, else nothing.
          if (live.isNotEmpty) ...[
            LiveCardPager(cards: [
              for (final s in live)
                LiveCard(
                  session: s,
                  groupName: _groupName(s.groupId),
                  joining: _joiningId == s.id,
                  // Viewers watch but don't record.
                  onJoin: _groupOf(s.groupId)?.role == 'viewer'
                      ? null
                      : () => _join(s),
                ),
            ]),
            const SizedBox(height: 24),
          ] else if (nextUp != null) ...[
            _NextUpCard(
              session: nextUp,
              groupName: _groupName(nextUp.groupId),
              color: _groupColor(nextUp.groupId),
              onSeeInCalendar: () => _openDay(nextUp.scheduledAt!),
            ),
            const SizedBox(height: 24),
          ],

          _HeaderRow(
            title: 'This week',
            linkLabel: 'Calendar',
            onViewAll: widget.onOpenCalendar,
          ),
          const SizedBox(height: 10),
          _WeekStrip(
            start: _weekStart,
            sessions: week,
            colorOf: (s) => _groupColor(s.groupId),
            onDay: _openDay,
          ),
          const SizedBox(height: 6),
          if (weekList.isEmpty)
            Container(
              padding: const EdgeInsets.only(top: 12),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: _rule)),
              ),
              child: Text(
                week.isEmpty
                    ? 'Nothing scheduled this week.'
                    : 'Nothing else scheduled this week.',
                style: const TextStyle(color: kMuted, fontSize: 14),
              ),
            )
          else
            for (final s in weekList)
              _WeekRow(
                session: s,
                color: _groupColor(s.groupId),
                groupName: _groupName(s.groupId),
                joining: _joiningId == s.id,
                onTap: s.isActive || isOpenToJoin(s)
                    ? () => _join(s)
                    : () => _openDay(s.scheduledAt ?? DateTime.now()),
              ),
          const SizedBox(height: 24),

          _HeaderRow(
            title: 'Recent sessions',
            onViewAll: _recentRecordings.isEmpty ? null : widget.onOpenSessions,
          ),
          const SizedBox(height: 10),
          if (_recentRecordings.isEmpty)
            _EmptyNote(
              icon: Icons.videocam_outlined,
              title: 'No recordings yet',
              message: _myGroups?.isEmpty ?? false
                  ? "Join a team first. Its sessions' recordings show up here."
                  : "Recordings from your team's sessions show up here to watch.",
              // With no team yet, this is the way to one.
              onTap: _myGroups?.isEmpty ?? false ? widget.onOpenGroups : null,
            )
          else
            // Big video cards, swiped sideways; the next one peeks in at the
            // edge, which shows the row scrolls.
            LayoutBuilder(builder: (context, constraints) {
              // Two side by side with a third peeking in.
              final cardWidth = constraints.maxWidth * 0.48;
              return SizedBox(
                height: cardWidth * 9 / 16 + 50,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  clipBehavior: Clip.none,
                  itemCount: _recentRecordings.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 12),
                  itemBuilder: (context, i) {
                    final s = _recentRecordings[i];
                    return SizedBox(
                      width: cardWidth,
                      child: SessionVideoCard(
                        session: s,
                        groupName: _groupName(s.groupId),
                        thumbnail: _recordings.thumbnailOf(s),
                        onTap: () => _watch(s),
                      ),
                    );
                  },
                ),
              );
            }),
          const SizedBox(height: 24),

          _HeaderRow(
            title: 'Notifications',
            onViewAll:
                (_notifications?.isEmpty ?? true) ? null : _openNotifications,
          ),
          const SizedBox(height: 8),
          // A plain list, no box around it.
          if (_notifications == null)
            const Text('Loading…',
                style: TextStyle(color: kMuted, fontSize: 14))
          else if (_notifications!.isEmpty)
            const _EmptyNote(
              icon: Icons.notifications_none,
              title: "You're all caught up",
              message: 'Comments, new teammates and sessions '
                  'starting show up here.',
            )
          else
            for (final n in _notifications!)
              NotificationTile(
                notification: n,
                onTap: () => openNotification(
                  context,
                  widget.auth,
                  n,
                  onOpenRecord: widget.onOpenSessions,
                ),
              ),
        ],
      ),
    );
  }

  /// The thin line between This week's rows.
  static const _rule = Color(0xFF1E1E21);
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
        Expanded(
          child: Text(
            title,
            style: const TextStyle(
              // White: the team color is kept for what you act on.
              color: Colors.white,
              fontSize: 19,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        if (onViewAll != null)
          TextButton(
            onPressed: onViewAll,
            style: TextButton.styleFrom(
              foregroundColor: TeamAccent.of(context).accent,
              padding: EdgeInsets.zero,
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              textStyle:
                  const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            child: Text(linkLabel),
          ),
      ],
    );
  }
}

/// "in 3 h", "tomorrow", "in 2 days": how far off [at] is, by calendar day
/// once it's not today.
String _until(DateTime at) {
  final now = DateTime.now();
  final days = DateTime(at.year, at.month, at.day)
      .difference(DateTime(now.year, now.month, now.day))
      .inDays;
  if (days >= 2) return 'in $days days';
  if (days == 1) return 'tomorrow';
  final minutes = at.difference(now).inMinutes;
  if (minutes < 60) return 'in ${minutes < 1 ? 1 : minutes} min';
  return 'in ${(minutes / 60).round()} h';
}

/// "Thu 6:00 PM".
String _weekdayTime(DateTime at) =>
    '${_weekdayNames[at.weekday - 1].substring(0, 3)} ${clockLabel(at)}';

/// The next scheduled session when nothing's live: a dark card (the live
/// card is the colored one) with when it is and a way to the calendar.
class _NextUpCard extends StatelessWidget {
  const _NextUpCard({
    required this.session,
    required this.groupName,
    required this.color,
    required this.onSeeInCalendar,
  });

  final RecordingSession session;
  final String? groupName;

  /// The group's color, readable on the dark card.
  final Color color;
  final VoidCallback onSeeInCalendar;

  @override
  Widget build(BuildContext context) {
    final at = session.scheduledAt!;
    final when = [
      '${_weekdayNames[at.weekday - 1]}, '
          '${_monthNames[at.month - 1].substring(0, 3)} ${at.day}',
      clockLabel(at),
      if (groupName != null) groupName!,
    ].join(' · ');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: const Color(0xFF111113),
        borderRadius: BorderRadius.circular(24),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'NEXT UP · ${_until(at).toUpperCase()}',
            style: TextStyle(
              color: color,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.4,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            session.name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
                color: Colors.white, fontSize: 24, fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 4),
          Text(when,
              style: const TextStyle(color: Color(0xFFC9C9CF), fontSize: 14)),
          const SizedBox(height: 12),
          const Text(
            "You'll get a notification when it starts, and Join shows up "
            'here.',
            style: TextStyle(color: kMuted, fontSize: 13),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            height: 46,
            child: FilledButton(
              onPressed: onSeeInCalendar,
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFF1B1B1E),
                foregroundColor: Colors.white,
                shape: const StadiumBorder(),
                textStyle:
                    const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
              ),
              child: const Text('See in calendar'),
            ),
          ),
        ],
      ),
    );
  }
}

/// Monday to Sunday: each day's letter and date (today in the team color)
/// with a dot per session that day in its group's color. A day opens on the
/// calendar.
class _WeekStrip extends StatelessWidget {
  const _WeekStrip({
    required this.start,
    required this.sessions,
    required this.colorOf,
    required this.onDay,
  });

  final DateTime start;
  final List<RecordingSession> sessions;
  final Color Function(RecordingSession) colorOf;
  final ValueChanged<DateTime> onDay;

  static const _letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  @override
  Widget build(BuildContext context) {
    final accent = TeamAccent.of(context).accent;
    final now = DateTime.now();
    return Row(
      children: [
        for (var i = 0; i < 7; i++)
          Builder(builder: (context) {
            final day = DateTime(start.year, start.month, start.day + i);
            final today = _sameDay(day, now);
            final dots = [
              for (final s in sessions)
                if (s.scheduledAt != null && _sameDay(s.scheduledAt!, day))
                  colorOf(s),
            ];
            return Expanded(
              child: Semantics(
                button: true,
                label: '${_weekdayNames[day.weekday - 1]} ${day.day}, '
                    '${dots.length} ${dots.length == 1 ? 'session' : 'sessions'}',
                excludeSemantics: true,
                child: InkWell(
                  onTap: () => onDay(day),
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Column(
                      children: [
                        Text(
                          _letters[i],
                          style: TextStyle(
                            color: today ? accent : kMuted,
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${day.day}',
                          style: TextStyle(
                            color: today ? accent : Colors.white,
                            fontSize: 17,
                            fontWeight:
                                today ? FontWeight.w900 : FontWeight.w500,
                          ),
                        ),
                        const SizedBox(height: 3),
                        SizedBox(
                          height: 6,
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              for (final color in dots.take(3))
                                Container(
                                  width: 6,
                                  height: 6,
                                  margin:
                                      const EdgeInsets.symmetric(horizontal: 1),
                                  decoration: BoxDecoration(
                                    color: color,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            );
          }),
      ],
    );
  }
}

/// One of this week's sessions: its group's color as a dot, the name and
/// group, and its time on the right (NOW while it's live or open to join,
/// when tapping it joins).
class _WeekRow extends StatelessWidget {
  const _WeekRow({
    required this.session,
    required this.color,
    required this.groupName,
    required this.joining,
    required this.onTap,
  });

  final RecordingSession session;
  final Color color;
  final String? groupName;
  final bool joining;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final at = session.scheduledAt;
    final now = session.isActive || isOpenToJoin(session);
    final accent = TeamAccent.of(context).accent;
    return Material(
      type: MaterialType.transparency,
      child: InkWell(
        onTap: joining ? null : onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: _HomeTabState._rule)),
          ),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(left: 2, right: 12),
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(session.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 15,
                            fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(
                      [
                        if (groupName != null) groupName!,
                        if (session.isActive) 'live',
                      ].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: Color(0xFF9A9AA0), fontSize: 12),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              if (joining)
                SizedBox.square(
                  dimension: 14,
                  child:
                      CircularProgressIndicator(strokeWidth: 2, color: accent),
                )
              else
                Text(
                  now
                      ? 'NOW'
                      : at == null
                          ? ''
                          : _weekdayTime(at),
                  style: TextStyle(
                    color: now ? accent : const Color(0xFFC9C9CF),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// An empty section, like the web's: an icon in the team color, a short
/// title and a helpful line. Tappable when there's somewhere to go.
class _EmptyNote extends StatelessWidget {
  const _EmptyNote({
    required this.icon,
    required this.title,
    required this.message,
    this.onTap,
  });

  final IconData icon;
  final String title;
  final String message;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration:
                  const BoxDecoration(color: kSurface, shape: BoxShape.circle),
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
      ),
    );
  }
}

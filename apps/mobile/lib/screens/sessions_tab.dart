import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/auto_refresh.dart';
import '../widgets/empty_state.dart';
import '../widgets/live_card.dart';
import 'recordings_screen.dart';
import 'watch_screen.dart';

/// The Sessions tab: what's live (to join, watch so far or end) and the
/// finished sessions to watch, searchable and filtered by group. A session
/// holds recordings (takes); a recording holds angles (one per phone).
/// Upcoming sessions are on the Calendar.
class SessionsTab extends StatefulWidget {
  const SessionsTab({super.key, required this.auth, this.refresh});

  final AuthService auth;

  /// Fires when the + menu starts or schedules a session.
  final Listenable? refresh;

  @override
  State<SessionsTab> createState() => _SessionsTabState();
}

class _SessionsTabState extends State<SessionsTab> {
  late final RecordingsApi _recordings = RecordingsApi(widget.auth.api);
  late final GroupsApi _groupsApi = GroupsApi(widget.auth.api);

  List<RecordingSession> _sessions = [];
  List<Group> _groups = [];
  bool _loading = true;
  String? _error;

  /// The session being joined or ended.
  String? _busyId;

  final _search = TextEditingController();

  /// The group chip picked: null for All, [_noGroup] for sessions without
  /// one.
  String? _filter;
  static const _noGroup = '';

  @override
  void initState() {
    super.initState();
    widget.refresh?.addListener(_load);
    _search.addListener(() => setState(() {}));
    _load();
    // Live sessions appear (and ended ones go) without pulling down.
    _refresher = AutoRefresher(const Duration(seconds: 10), _load);
  }

  late final AutoRefresher _refresher;

  @override
  void dispose() {
    _refresher.dispose();
    widget.refresh?.removeListener(_load);
    _search.dispose();
    super.dispose();
  }

  /// A spinner only the first time; refreshes keep the list on screen.
  Future<void> _load() async {
    try {
      final results = await Future.wait([
        _recordings.getSessions(),
        _groupsApi.getMyGroups().catchError((_) => <Group>[]),
      ]);
      if (!mounted) return;
      setState(() {
        _sessions = results[0] as List<RecordingSession>;
        _groups = results[1] as List<Group>;
        _loading = false;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Group? _groupOf(RecordingSession s) {
    for (final g in _groups) {
      if (g.id == s.groupId) return g;
    }
    return null;
  }

  /// The session's host and the group's admins can end it.
  bool _canManage(RecordingSession s) =>
      s.createdBy == widget.auth.user?.id || _groupOf(s)?.role == 'admin';

  /// Viewers watch but don't record.
  bool _canJoin(RecordingSession s) => _groupOf(s)?.role != 'viewer';

  /// Group admins (and the owner) can delete a finished session.
  bool _canDelete(RecordingSession s) => _groupOf(s)?.role == 'admin';

  bool _matches(RecordingSession s) {
    final filter = _filter;
    if (filter != null && (s.groupId ?? _noGroup) != filter) return false;
    final query = _search.text.trim().toLowerCase();
    if (query.isEmpty) return true;
    return s.name.toLowerCase().contains(query) ||
        (_groupOf(s)?.name.toLowerCase().contains(query) ?? false);
  }

  void _toast(String message) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(message)));

  Future<void> _join(RecordingSession s) async {
    if (_busyId != null) return;
    setState(() => _busyId = s.id);
    try {
      await enterSession(context, widget.auth, s);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
    if (mounted) _load();
  }

  void _watch(RecordingSession s) => Navigator.of(context).push(
        MaterialPageRoute(
            builder: (_) => WatchScreen(auth: widget.auth, session: s)),
      );

  Future<void> _end(RecordingSession s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text('End ${s.name} for everyone?'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Keep it')),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(backgroundColor: kLiveRed),
            child: const Text('End session'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busyId = s.id);
    try {
      await _recordings.endSession(s.id);
      await _load();
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _delete(RecordingSession s) async {
    if (!await confirmDeleteSession(context, s) || !mounted) return;
    try {
      await _recordings.deleteSession(s.id);
      if (mounted) {
        setState(() => _sessions = [
              for (final other in _sessions)
                if (other.id != s.id) other,
            ]);
      }
    } on ApiException catch (e) {
      if (mounted) _toast(e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final live = liveNow(_sessions);
    final past = pastSessionsOf(_sessions);
    final shownLive = live.where(_matches).toList();
    final shownPast = past.where(_matches).toList();
    final total = live.length + past.length;
    final takes =
        [...live, ...past].fold<int>(0, (n, s) => n + (s.recordingCount ?? 0));
    final anyWithoutGroup = [...live, ...past].any((s) => s.groupId == null);

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 110),
        children: [
          const Text(
            'Sessions',
            style: TextStyle(
              color: Colors.white,
              fontSize: 30,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '$total ${total == 1 ? 'session' : 'sessions'} · '
            '$takes ${takes == 1 ? 'recording' : 'recordings'}',
            style: const TextStyle(color: kMuted, fontSize: 14),
          ),
          const SizedBox(height: 16),
          _SearchBox(controller: _search),
          const SizedBox(height: 16),
          SizedBox(
            height: 34,
            // A handful of chips: all built, scrolled sideways when they
            // don't fit.
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              clipBehavior: Clip.none,
              child: Row(
                children: [
                  _chip('All', null),
                  for (final g in _groups) _chip(g.name, g.id),
                  if (anyWithoutGroup) _chip('No group', _noGroup),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),
          if (_loading)
            const Padding(
              padding: EdgeInsets.only(top: 24),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_error != null && _sessions.isEmpty)
            EmptyState(
              title: "Couldn't load sessions",
              message: _error!,
              actionLabel: 'Retry',
              onAction: _load,
            )
          else if (total == 0)
            const EmptyState(
              title: 'No sessions yet',
              message: 'Tap + to start or schedule a session. When one is '
                  'live it shows up here to join, and once it ends, here to '
                  'watch.',
            )
          else ...[
            for (final s in shownLive) ...[
              LiveCard(
                session: s,
                groupName: _groupOf(s)?.name ??
                    // A session without a group shows its code, to share.
                    (s.groupId == null ? 'Code ${s.id}' : null),
                joining: _busyId == s.id,
                onJoin: _canJoin(s) ? () => _join(s) : null,
                // Takes already recorded can be watched while it's live.
                onWatch: (s.recordingCount ?? 0) > 0 ? () => _watch(s) : null,
                onEnd: s.isActive && _canManage(s) && _busyId == null
                    ? () => _end(s)
                    : null,
              ),
              const SizedBox(height: 12),
            ],
            if (shownLive.isNotEmpty) const SizedBox(height: 12),
            const Text(
              'Past',
              style: TextStyle(
                color: Colors.white,
                fontSize: 19,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 12),
            if (shownPast.isEmpty)
              Text(
                past.isEmpty
                    ? 'Finished sessions show up here once their recordings '
                        'upload.'
                    : 'No finished sessions match.',
                style: const TextStyle(color: kMuted, fontSize: 14),
              )
            else
              PastSessionsGrid(
                sessions: shownPast,
                groupNameOf: (s) =>
                    s.groupId == null ? 'No group' : _groupOf(s)?.name,
                thumbnailOf: _recordings.thumbnailOf,
                onOpen: _watch,
                onDelete: (s) => _canDelete(s) ? () => _delete(s) : null,
              ),
          ],
        ],
      ),
    );
  }

  /// One group filter; the picked one is filled with the team color.
  Widget _chip(String label, String? value) {
    final team = TeamAccent.of(context);
    final selected = _filter == value;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Material(
        color: selected ? team.fill : const Color(0xFF1B1B1E),
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => setState(() => _filter = value),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  color: selected ? team.ink : Colors.white,
                  fontSize: 14,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Filters by session or group name as you type.
class _SearchBox extends StatelessWidget {
  const _SearchBox({required this.controller});

  final TextEditingController controller;

  @override
  Widget build(BuildContext context) {
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(22),
      borderSide: BorderSide.none,
    );
    return SizedBox(
      height: 44,
      child: TextField(
        controller: controller,
        textInputAction: TextInputAction.search,
        style: const TextStyle(color: Colors.white, fontSize: 15),
        decoration: InputDecoration(
          hintText: 'Search sessions',
          hintStyle: const TextStyle(color: kMuted, fontSize: 15),
          prefixIcon: const Icon(Icons.search, color: kMuted, size: 20),
          suffixIcon: controller.text.isEmpty
              ? null
              : IconButton(
                  tooltip: 'Clear search',
                  icon: const Icon(Icons.close, color: kMuted, size: 18),
                  onPressed: controller.clear,
                ),
          filled: true,
          fillColor: const Color(0xFF1B1B1E),
          contentPadding: EdgeInsets.zero,
          border: border,
          enabledBorder: border,
          focusedBorder: border,
        ),
      ),
    );
  }
}

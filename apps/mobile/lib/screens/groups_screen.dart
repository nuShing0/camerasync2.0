import 'dart:async';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/groups_api.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../groups/group_labels.dart';
import '../groups/invite_code.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/auto_refresh.dart';
import '../widgets/create_group_dialog.dart';
import '../widgets/empty_state.dart';
import '../widgets/group_badge.dart';
import '../widgets/invite_panel.dart';
import '../widgets/invite_preview.dart';
import 'group_settings_screen.dart';
import 'join_group_screen.dart';

/// Lists the user's groups as big cards in their team colors, each opening
/// the group's page. Join group (an invite, or asking with the group's ID)
/// and Create group sit at the top.
class GroupsScreen extends StatefulWidget {
  const GroupsScreen({super.key, required this.auth, this.refresh});

  final AuthService auth;

  /// Ticks when a group was joined somewhere else, like from an invite
  /// link, so the list reloads.
  final Listenable? refresh;

  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  late final GroupsApi _groupsApi = GroupsApi(widget.auth.api);
  late final RecordingsApi _recordingsApi = RecordingsApi(widget.auth.api);

  List<Group> _groups = [];
  bool _loading = true;
  String? _error;

  /// Every session the user can see, for each card's live session or count.
  /// Null until loaded, and left null if that fails: the cards just go
  /// without.
  List<RecordingSession>? _sessions;

  /// Keeps the live dots current while the tab is open.
  late final AutoRefresher _refresher;

  @override
  void initState() {
    super.initState();
    _loadGroups();
    widget.refresh?.addListener(_loadGroups);
    _refresher = AutoRefresher(const Duration(seconds: 20), _loadSessions);
  }

  @override
  void dispose() {
    widget.refresh?.removeListener(_loadGroups);
    _refresher.dispose();
    super.dispose();
  }

  Future<void> _loadGroups() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    unawaited(_loadSessions());

    try {
      final groups = await _groupsApi.getMyGroups();
      if (!mounted) return;
      setState(() {
        _groups = groups;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException ? e.message : 'Unable to load groups.';
        _loading = false;
      });
    }
  }

  Future<void> _loadSessions() async {
    try {
      final sessions = await _recordingsApi.getSessions();
      if (mounted) setState(() => _sessions = sessions);
    } on ApiException {
      // The cards show no session line; the next refresh tries again.
    }
  }

  Future<void> _join() async {
    final result = await showJoinGroupSheet(context, _groupsApi);
    if (result == null || !mounted) return;
    final joined = result.joined;
    if (joined == null) return _openGroupById(result.id);

    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('Joined ${joined.name}')));
    await _loadGroups();
    if (!mounted) return;
    // A first group becomes the primary group, which colors the app.
    TeamAccent.of(context).refresh();
    await _openGroup(joined);
  }

  Future<void> _openGroupById(String id) async {
    Group? find() => _groups.where((g) => g.id == id).firstOrNull;
    // Joined somewhere the list hasn't caught up with yet.
    if (find() == null) await _loadGroups();
    final group = find();
    if (group == null || !mounted) return;
    await _openGroup(group);
  }

  Future<void> _createGroup() async {
    final created = await showDialog<Group>(
      context: context,
      builder: (_) => CreateGroupDialog(groupsApi: _groupsApi),
    );
    if (created == null || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Created ${created.name}')),
    );
    unawaited(_loadGroups());
    TeamAccent.of(context).refresh();
    await showInviteTeamSheet(context, created);
  }

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final count = _groups.length;
    const pill = StadiumBorder();

    return RefreshIndicator(
      onRefresh: _loadGroups,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 110),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Text(
            'Groups',
            style: TextStyle(
              color: Colors.white,
              fontSize: 30,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.5,
            ),
          ),
          if (count > 0) ...[
            const SizedBox(height: 4),
            Text(
              [
                '$count ${count == 1 ? 'group' : 'groups'}',
                if (count > 1) 'hold to reorder',
              ].join(' · '),
              style: const TextStyle(color: kMuted, fontSize: 14),
            ),
          ],
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _join,
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF1C1C1C),
                    foregroundColor: Colors.white,
                    minimumSize: const Size.fromHeight(48),
                    shape: pill,
                    textStyle: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                  child: const Text('Join group'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton.icon(
                  onPressed: _createGroup,
                  style: FilledButton.styleFrom(
                    backgroundColor: team.fill,
                    foregroundColor: team.ink,
                    minimumSize: const Size.fromHeight(48),
                    shape: pill,
                    textStyle: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                  icon: const Icon(Icons.add, size: 20),
                  label: const Text('Create group'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          if (_loading && _groups.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 48),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_error != null)
            _Notice(
                message: _error!, actionLabel: 'Retry', onAction: _loadGroups)
          else if (_groups.isEmpty)
            EmptyState(
              title: 'No groups yet',
              message: "Tap Join group to enter your team's invite, or "
                  'create a new one for your team.',
              actionLabel: 'Create a group',
              onAction: _createGroup,
            )
          else
            // Long-press a group (or grab its grip) and drag it to change
            // the order; the order is saved on the account, like on the web.
            ReorderableListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              buildDefaultDragHandles: false,
              itemCount: _groups.length,
              onReorderItem: _reorder,
              // A buzz when it lifts, so you know it's picked up.
              onReorderStart: (_) => HapticFeedback.mediumImpact(),
              // The picked-up card grows, tilts a little and casts a shadow
              // while it's carried.
              proxyDecorator: (child, _, animation) => AnimatedBuilder(
                animation: animation,
                builder: (context, child) {
                  final t = Curves.easeOut.transform(animation.value);
                  return Transform.rotate(
                    angle: -0.02 * t,
                    child: Transform.scale(
                      scale: 1 + 0.04 * t,
                      child: Material(
                        color: Colors.transparent,
                        elevation: 16 * t,
                        shadowColor: Colors.black,
                        borderRadius: BorderRadius.circular(20),
                        child: child,
                      ),
                    ),
                  );
                },
                child: child,
              ),
              itemBuilder: (context, i) {
                final g = _groups[i];
                return ReorderableDelayedDragStartListener(
                  key: ValueKey(g.id),
                  index: i,
                  child: _GroupCard(
                    group: g,
                    index: i,
                    role: groupRoleName(g, widget.auth.user?.id),
                    isPrimary: g.id == team.primaryGroup?.id,
                    sessions:
                        _sessions?.where((s) => s.groupId == g.id).toList(),
                    onOpen: () => _openGroup(g),
                  ),
                );
              },
            ),
        ],
      ),
    );
  }

  /// Moves a dragged group and saves the new order to the account.
  Future<void> _reorder(int from, int to) async {
    setState(() {
      final group = _groups.removeAt(from);
      _groups.insert(to, group);
    });
    try {
      await widget.auth
          .updateProfile(groupOrder: [for (final g in _groups) g.id]);
    } on ApiException catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text("Couldn't save the new order. Try again.")));
      }
    }
  }

  /// The group's page: its live session or starting one, its sessions,
  /// members and settings.
  Future<void> _openGroup(Group g) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
          builder: (_) => GroupSettingsScreen(auth: widget.auth, group: g)),
    );
    // The color or roster may have changed there.
    if (mounted) _loadGroups();
  }
}

/// An invite link opened the app: the invite's preview over whatever is
/// showing, to join from (or open the group, if the user is in it already).
/// [onJoined] hears about a join, so the Groups tab can reload.
Future<void> showInvitePreviewSheet(
  BuildContext context,
  AuthService auth,
  String code, {
  VoidCallback? onJoined,
}) {
  final api = GroupsApi(auth.api);
  final navigator = Navigator.of(context);
  final messenger = ScaffoldMessenger.of(context);
  final team = TeamAccent.of(context);

  Future<void> open(Group group) => navigator.push(MaterialPageRoute(
      builder: (_) => GroupSettingsScreen(auth: auth, group: group)));

  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: kBackground,
    showDragHandle: true,
    builder: (sheet) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              "You're invited",
              style: TextStyle(
                color: team.accent,
                fontSize: 20,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 4),
            Text('Invite code ${formatInviteCode(code)}',
                style: const TextStyle(color: kMuted)),
            const SizedBox(height: 14),
            InvitePreviewCard(
              api: api,
              code: code,
              onJoined: (group) {
                Navigator.of(sheet).pop();
                messenger.showSnackBar(
                    SnackBar(content: Text('Joined ${group.name}')));
                onJoined?.call();
                // A first group becomes the primary group.
                team.refresh();
                open(group);
              },
              onOpen: (id) async {
                Navigator.of(sheet).pop();
                try {
                  final groups = await api.getMyGroups();
                  final group = groups.where((g) => g.id == id).firstOrNull;
                  if (group != null) await open(group);
                } on ApiException catch (e) {
                  messenger.showSnackBar(SnackBar(content: Text(e.message)));
                }
              },
            ),
          ],
        ),
      ),
    ),
  );
}

/// One group: a big card in its team color with the user's role, its name
/// and ID, and a footer with its live session or how many it's had. Tapping
/// opens the group's page; the grip (or a long press anywhere) drags it.
class _GroupCard extends StatelessWidget {
  const _GroupCard({
    required this.group,
    required this.index,
    required this.role,
    required this.isPrimary,
    required this.sessions,
    required this.onOpen,
  });

  final Group group;

  /// Its place in the list, for the grip's drag.
  final int index;
  final String role;
  final bool isPrimary;

  /// The group's sessions, or null while they load.
  final List<RecordingSession>? sessions;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final fill = parseHexColor(group.primaryColor);
    final ink = fill == null ? Colors.white : inkOn(fill);
    final soft = ink.withValues(alpha: 0.72);

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: fill ?? const Color(0xFF1C1C1C),
        borderRadius: BorderRadius.circular(20),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onOpen,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 8, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          GroupBadge(label: role, ink: ink),
                          if (isPrimary) GroupBadge(label: 'Primary', ink: ink),
                        ],
                      ),
                    ),
                    // Shows the cards can be moved, and drags straight away.
                    ReorderableDragStartListener(
                      index: index,
                      child: Padding(
                        padding: const EdgeInsets.all(6),
                        child: Icon(Icons.drag_indicator,
                            semanticLabel: 'Drag to reorder',
                            color: ink.withValues(alpha: 0.55)),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Text(
                    group.name,
                    style: TextStyle(
                      color: ink,
                      fontSize: 26,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -0.4,
                      height: 1.15,
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Divider(
                      height: 1,
                      thickness: 1,
                      color: ink.withValues(alpha: 0.18)),
                ),
                Row(
                  children: [
                    Expanded(child: _footer(ink, soft)),
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Icon(Icons.chevron_right,
                          color: ink.withValues(alpha: 0.8)),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The live session if there is one, else how many sessions and when the
  /// last was.
  Widget _footer(Color ink, Color soft) {
    final sessions = this.sessions;
    if (sessions == null) return const SizedBox.shrink();
    final live = sessions.where((s) => s.isActive).firstOrNull;
    if (live != null) {
      return Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: kLiveRed,
              shape: BoxShape.circle,
              // A ring in the ink, so the dot shows on red team colors too.
              border: Border.all(color: ink.withValues(alpha: 0.7), width: 1.5),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'Live · ${live.name}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  color: ink, fontSize: 14, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      );
    }
    final done = sessions.where((s) => s.isComplete).toList();
    DateTime? last;
    for (final s in done) {
      final at = s.scheduledAt;
      if (at != null && (last == null || at.isAfter(last))) last = at;
    }
    return Text(
      done.isEmpty
          ? 'No sessions yet'
          : [
              '${done.length} ${done.length == 1 ? 'session' : 'sessions'}',
              if (last != null) 'last ${shortDate(last)}',
            ].join(' · '),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(color: soft, fontSize: 14, fontWeight: FontWeight.w600),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.message, this.actionLabel, this.onAction});

  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 32),
      child: Column(
        children: [
          Text(message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: kMuted, height: 1.5)),
          if (actionLabel != null) ...[
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onAction, child: Text(actionLabel!)),
          ]
        ],
      ),
    );
  }
}

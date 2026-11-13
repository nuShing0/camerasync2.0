import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../api/notifications_api.dart' show timeAgo;
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../config.dart';
import '../groups/group_labels.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/group_badge.dart';
import '../widgets/invite_panel.dart';
import 'recordings_screen.dart';
import 'session_screen.dart';
import 'watch_screen.dart';

const _roleLabel = {
  'admin': 'an admin',
  'member': 'a member',
  'viewer': 'a viewer'
};

/// How many members the group page shows before See all.
const _membersShown = 4;

/// One group's page, opened by tapping its card (the web app's group page):
/// a banner in the team color, its live session to join or starting one,
/// its finished sessions, requests to join (admins), the first few members,
/// and rows opening the invite, team color and group details. Leaving (or,
/// for the owner, deleting) the group is at the bottom.
class GroupSettingsScreen extends StatefulWidget {
  const GroupSettingsScreen(
      {super.key, required this.auth, required this.group});

  final AuthService auth;
  final Group group;

  @override
  State<GroupSettingsScreen> createState() => _GroupSettingsScreenState();
}

class _GroupSettingsScreenState extends State<GroupSettingsScreen> {
  late final GroupsApi _api = GroupsApi(widget.auth.api);
  late Group _group = widget.group;

  /// The roster, shared with the full Members list.
  late final _roster = _Roster(
    api: _api,
    group: () => _group,
    userId: _userId,
    onTransferred: _changed,
  );

  int? get _userId => widget.auth.user?.id;
  bool get _isOwner => _group.owner != null && _group.owner == _userId;

  @override
  void initState() {
    super.initState();
    _roster.load();
  }

  @override
  void dispose() {
    _roster.dispose();
    super.dispose();
  }

  /// The group came back changed (color, name, invite, owner): show it, and
  /// recolor the app in case it's the primary group.
  void _changed(Group updated) {
    if (!mounted) return;
    setState(() => _group = updated);
    TeamAccent.of(context).refresh();
  }

  /// After leaving or deleting the group: recolor the app if it was the
  /// primary group, and go back to the list.
  void _goneFromGroup() {
    TeamAccent.of(context).refresh();
    Navigator.of(context).pop();
  }

  void _push(Widget page) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final canManage = _group.canManage(_userId);
    final color = parseHexColor(_group.primaryColor);
    final colorName = kTeamColors
        .where((c) => c.$2 == _group.primaryColor?.toLowerCase())
        .firstOrNull
        ?.$1;

    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: _roster,
          builder: (context, _) => ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: _BackPill(
                    label: 'Groups',
                    onTap: () => Navigator.of(context).maybePop()),
              ),
              const SizedBox(height: 14),
              _Banner(
                group: _group,
                role: groupRoleName(_group, _userId),
                yourRole: _isOwner
                    ? 'the owner'
                    : _roleLabel[_group.role] ?? 'a member',
                memberCount: _roster.members?.length,
                isPrimary: team.primaryGroup?.id == _group.id,
              ),
              const SizedBox(height: 14),
              _GroupSessions(
                auth: widget.auth,
                group: _group,
                // Admins and the owner, whom the server lets create sessions.
                canStart: canManage,
              ),
              if (canManage)
                _RequestsSection(
                  group: _group,
                  api: _api,
                  onApproved: _roster.load,
                ),
              _SectionHeader(
                title: _roster.members == null
                    ? 'Members'
                    : 'Members (${_roster.members!.length})',
                action: _roster.members == null ? null : 'See all',
                onAction: () => _push(
                    _MembersPage(roster: _roster, groupName: _group.name)),
              ),
              _MembersPreview(roster: _roster),
              const _SectionHeader(title: 'Group'),
              _Rows(
                children: [
                  if (_group.inviteCode != null && _group.inviteUrl != null)
                    _NavRow(
                      icon: Icons.person_add_alt_1_outlined,
                      title: 'Invite people',
                      subtitle: 'Code, link and QR',
                      onTap: () => _push(_InvitePage(
                        group: _group,
                        api: _api,
                        canReset: canManage,
                        onChanged: _changed,
                      )),
                    ),
                  // Admins and the owner. Everyone else never sees this,
                  // and the server refuses their changes anyway.
                  if (canManage)
                    _NavRow(
                      icon: Icons.palette_outlined,
                      title: 'Team color',
                      subtitle: colorName ?? 'Shown across the app',
                      trailing: color == null
                          ? null
                          : Container(
                              width: 18,
                              height: 18,
                              decoration: BoxDecoration(
                                  color: color, shape: BoxShape.circle),
                            ),
                      onTap: () => _push(_ColorPage(
                        group: _group,
                        api: _api,
                        onSaved: _changed,
                      )),
                    ),
                  _NavRow(
                    icon: Icons.info_outline,
                    title: 'Group details',
                    subtitle: _isOwner ? 'Name, owner and group ID' : 'Owner and group ID',
                    onTap: () => _push(_DetailsPage(
                      group: _group,
                      api: _api,
                      roster: _roster,
                      canRename: _isOwner,
                      onSaved: _changed,
                    )),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              _LeaveOrDelete(
                group: _group,
                api: _api,
                isOwner: _isOwner,
                onGone: _goneFromGroup,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "← Groups": back to where the page was opened from.
class _BackPill extends StatelessWidget {
  const _BackPill({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: kSurface,
      shape: const StadiumBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 7, 14, 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.arrow_back, color: Colors.white, size: 18),
              const SizedBox(width: 6),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 220),
                child: Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 14,
                        fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The group's name in its team color, with the user's role, the ID and how
/// many are in it. The primary group (picked in Settings) says so.
class _Banner extends StatelessWidget {
  const _Banner({
    required this.group,
    required this.role,
    required this.yourRole,
    required this.memberCount,
    required this.isPrimary,
  });

  final Group group;

  /// The badge: Owner, Admin, Member or Viewer.
  final String role;

  /// The same, for "You're the owner".
  final String yourRole;

  /// Null while the roster loads.
  final int? memberCount;
  final bool isPrimary;

  @override
  Widget build(BuildContext context) {
    final fill = parseHexColor(group.primaryColor) ?? kSurfaceLight;
    final ink = inkOn(fill);
    final count = memberCount;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      decoration:
          BoxDecoration(color: fill, borderRadius: BorderRadius.circular(20)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              GroupBadge(label: role, ink: ink),
              if (isPrimary) GroupBadge(label: 'Your primary group', ink: ink),
            ],
          ),
          const SizedBox(height: 12),
          Text(group.name,
              style: TextStyle(
                  color: ink,
                  fontSize: 30,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.5,
                  height: 1.1)),
          const SizedBox(height: 6),
          Text(
            [
              "You're $yourRole",
              if (count != null) '$count ${count == 1 ? 'member' : 'members'}',
            ].join(' · '),
            style: TextStyle(color: ink.withValues(alpha: 0.75), fontSize: 13),
          ),
        ],
      ),
    );
  }
}

/// A heading between the page's parts, with an optional link at the right
/// like "View all".
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, this.action, this.onAction});

  final String title;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 22, 2, 10),
      child: Row(
        children: [
          Expanded(
            child: Text(title,
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 20,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.3)),
          ),
          if (action != null)
            TextButton(
              onPressed: onAction,
              style: TextButton.styleFrom(
                foregroundColor: TeamAccent.of(context).accent,
                padding: EdgeInsets.zero,
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                textStyle:
                    const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
              ),
              child: Text(action!),
            ),
        ],
      ),
    );
  }
}

/// A rounded dark card. Material rather than a colored box, so tap ripples
/// inside show.
class _Card extends StatelessWidget {
  const _Card({required this.child, this.padding = const EdgeInsets.all(16)});

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: kSurface,
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: Padding(padding: padding, child: child),
    );
  }
}

/// A list of [_NavRow]s in one card, with thin lines between them.
class _Rows extends StatelessWidget {
  const _Rows({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return _Card(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0)
              const Divider(
                  height: 1, thickness: 1, indent: 56, color: kSurfaceLight),
            children[i],
          ],
        ],
      ),
    );
  }
}

/// A row in the Group card that opens its own screen.
class _NavRow extends StatelessWidget {
  const _NavRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 13, 10, 13),
        child: Row(
          children: [
            Icon(icon, color: Colors.white, size: 24),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 16,
                          fontWeight: FontWeight.w600)),
                  const SizedBox(height: 1),
                  Text(subtitle,
                      style: const TextStyle(color: kMuted, fontSize: 13)),
                ],
              ),
            ),
            if (trailing != null) ...[trailing!, const SizedBox(width: 6)],
            const Icon(Icons.chevron_right, color: kMuted),
          ],
        ),
      ),
    );
  }
}

/// A screen opened from the group page: back to the group, a big title,
/// then its contents.
class _SubPage extends StatelessWidget {
  const _SubPage({
    required this.groupName,
    required this.title,
    required this.children,
  });

  final String groupName;
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: _BackPill(
                  label: groupName,
                  onTap: () => Navigator.of(context).maybePop()),
            ),
            const SizedBox(height: 16),
            Text(title,
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 28,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.5)),
            const SizedBox(height: 14),
            ...children,
          ],
        ),
      ),
    );
  }
}

/// A full-width pill in the team color, like Start and Join.
ButtonStyle _accentButton(TeamAccent team) => FilledButton.styleFrom(
      backgroundColor: team.fill,
      foregroundColor: team.ink,
      minimumSize: const Size.fromHeight(48),
      shape: const StadiumBorder(),
      textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
    );

const _fieldBorder = OutlineInputBorder(
  borderRadius: BorderRadius.all(Radius.circular(14)),
  borderSide: BorderSide.none,
);

/// The group's live session to join, or starting one (admins and the
/// owner), then its finished sessions as a grid of stills, newest first.
/// Like the web group page.
class _GroupSessions extends StatefulWidget {
  const _GroupSessions({
    required this.auth,
    required this.group,
    required this.canStart,
  });

  final AuthService auth;
  final Group group;
  final bool canStart;

  @override
  State<_GroupSessions> createState() => _GroupSessionsState();
}

class _GroupSessionsState extends State<_GroupSessions> {
  late final RecordingsApi _api = RecordingsApi(widget.auth.api);
  final _name = TextEditingController();
  List<RecordingSession>? _sessions;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final all = await _api.getSessions();
      if (!mounted) return;
      setState(() {
        _sessions = all.where((s) => s.groupId == widget.group.id).toList();
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _openSession(RecordingSession session) async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => SessionScreen(
        serverUrl: kServerUrl,
        auth: widget.auth,
        sessionId: session.id,
        sessionName: session.name,
      ),
    ));
    if (mounted) _load();
  }

  Future<void> _run(Future<RecordingSession> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final session = await action();
      if (!mounted) return;
      setState(() => _busy = false);
      await _openSession(session);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.message;
        });
      }
    }
  }

  void _start() => _run(() => _api.createLiveSession(
        groupId: widget.group.id,
        name: _name.text.trim().isEmpty
            ? '${widget.group.name} session'
            : _name.text.trim(),
      ));

  void _join(RecordingSession s) =>
      _run(() async => s.isJoined ? s : await _api.joinSession(s.id));

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final sessions = _sessions ?? const <RecordingSession>[];
    final live = sessions.where((s) => s.isActive).toList();
    final done = sessions.where((s) => s.isComplete).toList()
      ..sort((a, b) => (b.scheduledAt ?? DateTime(0))
          .compareTo(a.scheduledAt ?? DateTime(0)));
    final error = _error == null
        ? null
        : Padding(
            padding: const EdgeInsets.only(top: 10),
            child:
                Text(_error!, style: const TextStyle(color: Color(0xFFFF8A80))),
          );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final s in live)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: _Card(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Row(
                    children: [
                      CircleAvatar(radius: 4, backgroundColor: kLiveRed),
                      SizedBox(width: 8),
                      Text('Live now',
                          style: TextStyle(
                              color: kLiveRed,
                              fontSize: 13,
                              fontWeight: FontWeight.w700)),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(s.name,
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 20,
                          fontWeight: FontWeight.w800)),
                  const SizedBox(height: 2),
                  Text(
                    '${s.activeMemberCount} '
                    '${s.activeMemberCount == 1 ? 'device' : 'devices'} '
                    'connected',
                    style: const TextStyle(color: kMuted, fontSize: 13),
                  ),
                  const SizedBox(height: 14),
                  FilledButton(
                    onPressed: _busy ? null : () => _join(s),
                    style: _accentButton(team),
                    child: Text(s.isJoined ? 'Enter' : 'Join'),
                  ),
                ],
              ),
            ),
          ),
        if (live.isEmpty && widget.canStart)
          _Card(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Start a session',
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 20,
                        fontWeight: FontWeight.w800)),
                const SizedBox(height: 4),
                Text(
                  'Everyone in ${widget.group.name} can join with their phone.',
                  style: const TextStyle(color: kMuted, height: 1.4),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _name,
                  maxLength: 100,
                  style: const TextStyle(color: Colors.white),
                  decoration: const InputDecoration(
                    hintText: 'Session name',
                    counterText: '',
                    filled: true,
                    fillColor: Color(0xFF0A0A0A),
                    border: _fieldBorder,
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _busy ? null : _start,
                  style: _accentButton(team),
                  child: Text(_busy ? 'Starting…' : 'Start'),
                ),
                if (error != null) error,
              ],
            ),
          )
        else if (live.isEmpty)
          _Card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Nothing live right now. An admin starts sessions for this group.',
                  style: TextStyle(color: kMuted, height: 1.4),
                ),
                if (error != null) error,
              ],
            ),
          )
        else if (error != null)
          error,
        _SectionHeader(
          title: 'Sessions',
          // The newest few here; View all opens the group's full list.
          action: done.isEmpty ? null : 'View all',
          onAction: () => Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => RecordingsScreen(
                auth: widget.auth,
                groupId: widget.group.id,
                title: widget.group.name),
          )),
        ),
        if (_sessions == null && _error == null)
          const Text('Loading…', style: TextStyle(color: kMuted))
        else if (done.isEmpty)
          const Text('No sessions yet. Finished sessions show up here.',
              style: TextStyle(color: kMuted, height: 1.4))
        else
          LayoutBuilder(
            builder: (context, box) {
              final width = (box.maxWidth - 12) / 2;
              return Wrap(
                spacing: 12,
                runSpacing: 16,
                children: [
                  for (final s in done.take(4))
                    _SessionTile(
                      session: s,
                      width: width,
                      thumbnail: _api.thumbnailOf(s),
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) =>
                              WatchScreen(auth: widget.auth, session: s),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
      ],
    );
  }
}

/// One finished session in the grid: a 16:9 still with its number of
/// recordings on it, then the name, and the day and how many cameras.
class _SessionTile extends StatelessWidget {
  const _SessionTile({
    required this.session,
    required this.width,
    required this.onTap,
    this.thumbnail,
  });

  final RecordingSession session;
  final double width;
  final VoidCallback onTap;

  /// A still from the session; a play mark on gray until there is one.
  final ImageProvider? thumbnail;

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final at = session.scheduledAt;
    final takes = session.recordingCount;
    final cameras = session.memberCount;
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
                      color: kSurface,
                      alignment: Alignment.center,
                      child: Icon(Icons.play_circle_fill,
                          color: team.accent, size: 30),
                    ),
                    if (thumbnail != null)
                      Image(
                        image: thumbnail!,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => const SizedBox(),
                      ),
                    if (takes != null)
                      Positioned(
                        left: 8,
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
                if (at != null) shortDate(at),
                if (cameras != null)
                  '$cameras ${cameras == 1 ? 'camera' : 'cameras'}',
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

/// The group's roster and what can be done to it, shared by the group page
/// and the full Members list so a change on one shows on both.
class _Roster extends ChangeNotifier {
  _Roster({
    required this.api,
    required this.group,
    required this.userId,
    required this.onTransferred,
  });

  final GroupsApi api;

  /// The group as it is now; the owner can change on a hand-over.
  final Group Function() group;
  final int? userId;

  /// After the owner hands the group to someone, with the updated group.
  final ValueChanged<Group> onTransferred;

  List<GroupMember>? members;
  String? error;
  bool saving = false;
  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    try {
      members = await api.getMembers(group().id);
      error = null;
    } on ApiException catch (e) {
      error = e.message;
    }
    _notify();
  }

  bool get isOwner => group().owner != null && group().owner == userId;
  bool get _isAdmin => isOwner || group().role == 'admin';

  /// Same rule as the web roster: the owner can manage anyone else; admins
  /// can manage members and viewers.
  bool canManage(GroupMember member) =>
      member.id != group().owner &&
      member.id != userId &&
      (isOwner ||
          (_isAdmin && (member.role == 'member' || member.role == 'viewer')));

  String roleName(GroupMember member) => member.id == group().owner
      ? 'Owner'
      : switch (member.role) {
          'admin' => 'Admin',
          'viewer' => 'Viewer',
          _ => 'Member'
        };

  /// A role change saves straight away (it's easy to undo); removing
  /// someone asks first. A [role] of 'owner' hands the group over, and null
  /// removes them.
  Future<void> update(
      BuildContext context, GroupMember member, String? role) async {
    final messenger = ScaffoldMessenger.of(context);
    final name = group().name;
    // Only the new owner could hand it back, so this asks first.
    if (role == 'owner') {
      final ok = await _confirm(
        context,
        "Make ${member.name} the owner of $name? You'll become an admin, and only they can hand it back.",
        'Make owner',
      );
      if (!ok) return;
    }
    if (role == null) {
      if (!context.mounted) return;
      final ok = await _confirm(
          context, 'Remove ${member.name} from this group?', 'Remove');
      if (!ok) return;
    }

    saving = true;
    _notify();
    try {
      if (role == 'owner') {
        final updated = await api.transfer(group().id, member.id);
        // The old owner stays on as an admin, and so does the new one.
        members = [
          for (final m in members!)
            m.id == member.id || m.id == userId
                ? GroupMember(id: m.id, name: m.name, role: 'admin')
                : m,
        ];
        onTransferred(updated);
      } else if (role == null) {
        await api.removeMember(group().id, member.id);
        members = [...members!.where((m) => m.id != member.id)];
      } else {
        await api.changeMemberRole(group().id, member.id, role);
        members = [
          for (final m in members!)
            m.id == member.id
                ? GroupMember(id: m.id, name: m.name, role: role)
                : m,
        ];
      }
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      saving = false;
      _notify();
    }
  }
}

/// The first few members on the group page; See all opens the rest.
class _MembersPreview extends StatelessWidget {
  const _MembersPreview({required this.roster});

  final _Roster roster;

  @override
  Widget build(BuildContext context) {
    final members = roster.members;
    if (roster.error != null) {
      return Text(roster.error!, style: const TextStyle(color: kLiveRed));
    }
    if (members == null) {
      return const Padding(
        padding: EdgeInsets.all(12),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    return _Card(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Column(
        children: [
          for (final member in members.take(_membersShown))
            _MemberRow(member: member, roster: roster),
        ],
      ),
    );
  }
}

/// Everyone in the group, from See all: the same rows and controls as on
/// the group page.
class _MembersPage extends StatelessWidget {
  const _MembersPage({required this.roster, required this.groupName});

  final _Roster roster;
  final String groupName;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: roster,
      builder: (context, _) {
        final members = roster.members ?? const <GroupMember>[];
        return _SubPage(
          groupName: groupName,
          title: 'Members (${members.length})',
          children: [
            _Card(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Column(
                children: [
                  for (final member in members)
                    _MemberRow(member: member, roster: roster),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

/// One member: initials, name and role, with a role dropdown and remove
/// for those the user can manage.
class _MemberRow extends StatelessWidget {
  const _MemberRow({required this.member, required this.roster});

  final GroupMember member;
  final _Roster roster;

  static String _initials(String name) {
    final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
    if (words.isEmpty) return '?';
    final first = words.first[0];
    final last = words.length > 1 ? words.last[0] : '';
    return '$first$last'.toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final manage = roster.canManage(member);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: kSurfaceLight,
            child: Text(_initials(member.name),
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 13,
                    fontWeight: FontWeight.w700)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(member.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w600)),
                if (!manage)
                  Text(roster.roleName(member),
                      style: const TextStyle(color: kMuted, fontSize: 13)),
              ],
            ),
          ),
          if (manage) ...[
            DropdownButton<String>(
              value: member.role,
              dropdownColor: kSurfaceLight,
              underline: const SizedBox(),
              style: const TextStyle(color: Colors.white, fontSize: 14),
              onChanged: roster.saving
                  ? null
                  : (role) {
                      if (role != null && role != member.role) {
                        roster.update(context, member, role);
                      }
                    },
              items: [
                if (roster.isOwner)
                  const DropdownMenuItem(value: 'owner', child: Text('Owner')),
                const DropdownMenuItem(value: 'admin', child: Text('Admin')),
                const DropdownMenuItem(value: 'member', child: Text('Member')),
                const DropdownMenuItem(value: 'viewer', child: Text('Viewer')),
              ],
            ),
            IconButton(
              onPressed: roster.saving
                  ? null
                  : () => roster.update(context, member, null),
              tooltip: 'Remove ${member.name} from group',
              icon: const Icon(Icons.remove, color: kLiveRed, size: 26),
            ),
          ],
        ],
      ),
    );
  }
}

/// Asks before something that can't be undone. Returns true to go ahead.
Future<bool> _confirm(
    BuildContext context, String message, String action) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          style: FilledButton.styleFrom(backgroundColor: kLiveRed),
          child: Text(action),
        ),
      ],
    ),
  );
  return ok == true;
}

/// Invite people: the code, Share, Copy link and Show QR, and for admins
/// Reset invite.
class _InvitePage extends StatefulWidget {
  const _InvitePage({
    required this.group,
    required this.api,
    required this.canReset,
    required this.onChanged,
  });

  final Group group;
  final GroupsApi api;
  final bool canReset;

  /// After a reset, with the group's new invite.
  final ValueChanged<Group> onChanged;

  @override
  State<_InvitePage> createState() => _InvitePageState();
}

class _InvitePageState extends State<_InvitePage> {
  late Group _group = widget.group;
  bool _resetting = false;

  /// A new invite code and link, after asking: the old ones stop working.
  Future<void> _reset() async {
    final ok = await _confirm(
      context,
      'Reset the invite for ${_group.name}? The old link, code and QR stop working.',
      'Reset',
    );
    if (!ok || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _resetting = true);
    try {
      final updated = await widget.api.resetInvite(_group.id);
      if (!mounted) return;
      setState(() => _group = updated);
      widget.onChanged(updated);
      messenger.showSnackBar(const SnackBar(content: Text('New invite ready')));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _resetting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _SubPage(
      groupName: _group.name,
      title: 'Invite people',
      children: [
        _Card(
          child: InvitePanel(
            group: _group,
            onReset: widget.canReset ? _reset : null,
            resetting: _resetting,
          ),
        ),
      ],
    );
  }
}

/// Team color swatches for admins and the owner. Goes back to the group
/// once saved.
class _ColorPage extends StatefulWidget {
  const _ColorPage(
      {required this.group, required this.api, required this.onSaved});

  final Group group;
  final GroupsApi api;
  final ValueChanged<Group> onSaved;

  @override
  State<_ColorPage> createState() => _ColorPageState();
}

class _ColorPageState extends State<_ColorPage> {
  late String? _color = _paletteColor(widget.group.primaryColor);
  bool _saving = false;
  String? _error;

  static String? _paletteColor(String? hex) {
    final lower = hex?.toLowerCase();
    return kTeamColors.any((c) => c.$2 == lower) ? lower : null;
  }

  bool get _changed =>
      _color != null && _color != widget.group.primaryColor?.toLowerCase();

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final updated = await widget.api.updateColor(widget.group.id, _color!);
      widget.onSaved(updated);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    return _SubPage(
      groupName: widget.group.name,
      title: 'Team color',
      children: [
        const Text(
          "Shown on the group's card, and across the app for anyone whose primary group this is.",
          style: TextStyle(color: kMuted, height: 1.4),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (final (name, hex) in kTeamColors)
              Semantics(
                label: 'Team color $name',
                selected: hex == _color,
                button: true,
                child: GestureDetector(
                  onTap: _saving ? null : () => setState(() => _color = hex),
                  child: Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: parseHexColor(hex),
                      shape: BoxShape.circle,
                      border: Border.all(
                        color:
                            hex == _color ? Colors.white : Colors.transparent,
                        width: 2.5,
                      ),
                    ),
                    child: hex == _color
                        ? Icon(Icons.check,
                            size: 22, color: inkOn(parseHexColor(hex)!))
                        : null,
                  ),
                ),
              ),
          ],
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(_error!, style: const TextStyle(color: kLiveRed)),
          ),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _saving || !_changed ? null : _save,
          style: _accentButton(team),
          child: Text(_saving ? 'Saving…' : 'Save color'),
        ),
      ],
    );
  }
}

/// Group details: its name (the owner can rename it), its ID, and who owns
/// it. Handing it over is a role in Members, so this points there.
class _DetailsPage extends StatefulWidget {
  const _DetailsPage({
    required this.group,
    required this.api,
    required this.roster,
    required this.canRename,
    required this.onSaved,
  });

  final Group group;
  final GroupsApi api;
  final _Roster roster;
  final bool canRename;
  final ValueChanged<Group> onSaved;

  @override
  State<_DetailsPage> createState() => _DetailsPageState();
}

class _DetailsPageState extends State<_DetailsPage> {
  late final _name = TextEditingController(text: widget.group.name);
  late Group _group = widget.group;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final updated =
          await widget.api.updateDetails(_group.id, name: _name.text.trim());
      widget.onSaved(updated);
      if (mounted) setState(() => _group = updated);
      messenger
          .showSnackBar(const SnackBar(content: Text('Group details saved')));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    return ListenableBuilder(
      listenable: widget.roster,
      builder: (context, _) {
        final owner = widget.roster.members
            ?.where((m) => m.id == _group.owner)
            .firstOrNull;
        Widget info(String label, String value) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  Expanded(
                      child:
                          Text(label, style: const TextStyle(color: kMuted))),
                  Text(value,
                      style: const TextStyle(
                          color: Colors.white, fontWeight: FontWeight.w600)),
                ],
              ),
            );

        return _SubPage(
          groupName: _group.name,
          title: 'Group details',
          children: [
            if (widget.canRename) ...[
              TextField(
                controller: _name,
                maxLength: 100,
                enabled: !_busy,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  counterText: '',
                  filled: true,
                  fillColor: kSurface,
                  // A filled border, so the label sits inside the box (an
                  // outline puts it on the box's invisible edge).
                  border: UnderlineInputBorder(
                    borderRadius: BorderRadius.all(Radius.circular(14)),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: EdgeInsets.fromLTRB(12, 10, 12, 10),
                ),
              ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _busy ? null : _save,
                style: _accentButton(team),
                child: const Text('Save'),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(_error!, style: const TextStyle(color: kLiveRed)),
                ),
              const SizedBox(height: 16),
            ],
            _Card(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Column(
                children: [
                  if (!widget.canRename) info('Name', _group.name),
                  info('Group ID', _group.id),
                  info('Owner', owner?.name ?? '—'),
                ],
              ),
            ),
            // The ID is only for this now; invites are the usual way in.
            const Padding(
              padding: EdgeInsets.only(top: 12),
              child: Text(
                'People without an invite can ask to join with the group ID, '
                'and an admin lets them in.',
                style: TextStyle(color: kMuted, height: 1.4),
              ),
            ),
            if (widget.canRename)
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text(
                  'To hand the group to someone else, make them the owner in '
                  'Members.',
                  style: TextStyle(color: kMuted, height: 1.4),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// Leave group, or for the owner Delete group (the owner has to hand it to
/// someone else before leaving), each after asking.
class _LeaveOrDelete extends StatefulWidget {
  const _LeaveOrDelete({
    required this.group,
    required this.api,
    required this.isOwner,
    required this.onGone,
  });

  final Group group;
  final GroupsApi api;
  final bool isOwner;
  final VoidCallback onGone;

  @override
  State<_LeaveOrDelete> createState() => _LeaveOrDeleteState();
}

class _LeaveOrDeleteState extends State<_LeaveOrDelete> {
  bool _busy = false;
  String? _error;

  Future<void> _go() async {
    final name = widget.group.name;
    final ok = widget.isOwner
        ? await _confirm(
            context,
            "Delete $name with all of its sessions, recordings and comments? This can't be undone.",
            'Delete',
          )
        : await _confirm(
            context,
            "Leave $name? You'll need an invite to join again.",
            'Leave',
          );
    if (!ok || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (widget.isOwner) {
        await widget.api.deleteGroup(widget.group.id);
      } else {
        await widget.api.leave(widget.group.id);
      }
      widget.onGone();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final label = widget.isOwner ? 'Delete group' : 'Leave group';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextButton(
          onPressed: _busy ? null : _go,
          style: TextButton.styleFrom(
            foregroundColor: kLiveRed,
            backgroundColor: kSurface,
            minimumSize: const Size.fromHeight(52),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
            textStyle:
                const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
          child:
              Text(_busy ? (widget.isOwner ? 'Deleting…' : 'Leaving…') : label),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(_error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: kLiveRed)),
          ),
      ],
    );
  }
}

/// People who asked to join with the group's ID, for admins and the owner to
/// let in or turn down. Hidden while there are none.
class _RequestsSection extends StatefulWidget {
  const _RequestsSection(
      {required this.group, required this.api, required this.onApproved});

  final Group group;
  final GroupsApi api;

  /// Someone was let in, so the roster has changed.
  final VoidCallback onApproved;

  @override
  State<_RequestsSection> createState() => _RequestsSectionState();
}

class _RequestsSectionState extends State<_RequestsSection> {
  List<JoinRequest> _requests = const [];

  /// The request being answered, so its buttons wait.
  int? _answering;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final requests = await widget.api.getRequests(widget.group.id);
      if (mounted) setState(() => _requests = requests);
    } on ApiException {
      // Nothing to show; the section stays hidden.
    }
  }

  Future<void> _answer(JoinRequest request, {required bool approve}) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _answering = request.userId);
    try {
      if (approve) {
        await widget.api.approveRequest(widget.group.id, request.userId);
        messenger.showSnackBar(SnackBar(
            content: Text('${request.name} is in ${widget.group.name}')));
        widget.onApproved();
      } else {
        await widget.api.declineRequest(widget.group.id, request.userId);
      }
    } on ApiException catch (e) {
      // Another admin may have answered it first; it's gone either way.
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
      if (e.statusCode != 404) {
        if (mounted) setState(() => _answering = null);
        return;
      }
    }
    if (!mounted) return;
    setState(() {
      _answering = null;
      _requests = [
        ..._requests.where((r) => r.userId != request.userId),
      ];
    });
  }

  /// "Asked 5m ago", "Asked just now", "Asked Sep 29".
  static String _asked(DateTime at) {
    final ago = timeAgo(at);
    if (ago == 'just now') return 'Asked just now';
    return RegExp(r'^\d').hasMatch(ago) ? 'Asked $ago ago' : 'Asked $ago';
  }

  @override
  Widget build(BuildContext context) {
    if (_requests.isEmpty) return const SizedBox.shrink();
    final team = TeamAccent.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _SectionHeader(title: 'Requests to join (${_requests.length})'),
        _Card(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Column(
            children: [
              for (final request in _requests)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(request.name,
                                style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600)),
                            Text(_asked(request.requestedAt),
                                style: const TextStyle(
                                    color: kMuted, fontSize: 13)),
                          ],
                        ),
                      ),
                      TextButton(
                        onPressed: _answering != null
                            ? null
                            : () => _answer(request, approve: false),
                        style: TextButton.styleFrom(foregroundColor: kMuted),
                        child: const Text('Decline'),
                      ),
                      const SizedBox(width: 4),
                      FilledButton(
                        onPressed: _answering != null
                            ? null
                            : () => _answer(request, approve: true),
                        style: FilledButton.styleFrom(
                          backgroundColor: team.fill,
                          foregroundColor: team.ink,
                          shape: const StadiumBorder(),
                        ),
                        child: const Text('Approve'),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

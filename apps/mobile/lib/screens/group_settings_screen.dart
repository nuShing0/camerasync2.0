import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../api/notifications_api.dart' show timeAgo;
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../config.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/invite_panel.dart';
import 'recordings_screen.dart';
import 'session_screen.dart';
import 'watch_screen.dart';

const _roleLabel = {
  'admin': 'an admin',
  'member': 'a member',
  'viewer': 'a viewer'
};

/// One group's page, opened by tapping its card (the web app's group page):
/// its live session to join or starting one, its recordings, and below them
/// its settings: primary group, team color (admins and the owner), the
/// invite, requests to join (admins) and the roster.
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
  bool _savingPrimary = false;
  bool _resettingInvite = false;

  /// Bumped when someone is let in, so the roster loads again.
  int _rosterVersion = 0;

  int? get _userId => widget.auth.user?.id;
  bool get _isOwner => _group.owner != null && _group.owner == _userId;

  void _toast(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _makePrimary() async {
    setState(() => _savingPrimary = true);
    try {
      await widget.auth.updateProfile(primaryGroupId: _group.id);
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _savingPrimary = false);
    }
  }

  /// A new invite code and link, after asking: the old ones stop working.
  Future<void> _resetInvite() async {
    final ok = await _confirm(
      context,
      'Reset the invite for ${_group.name}? The old link, code and QR stop working.',
      'Reset',
    );
    if (!ok || !mounted) return;
    setState(() => _resettingInvite = true);
    try {
      final updated = await _api.resetInvite(_group.id);
      if (!mounted) return;
      setState(() => _group = updated);
      _toast('New invite ready');
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _resettingInvite = false);
    }
  }

  /// After leaving or deleting the group: recolor the app if it was the
  /// primary group, and go back to the list.
  void _goneFromGroup() {
    TeamAccent.of(context).refresh();
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final fill = parseHexColor(_group.primaryColor) ?? kSurfaceLight;
    final ink = inkOn(fill);
    final isPrimary = team.primaryGroup?.id == _group.id;
    final yourRole =
        _isOwner ? 'the owner' : _roleLabel[_group.role] ?? 'a member';

    return Scaffold(
      backgroundColor: kBackground,
      appBar: AppBar(
        backgroundColor: kBackground,
        foregroundColor: Colors.white,
        title: const Text('Group'),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 32),
        children: [
          // Banner in the team color.
          Container(
            padding: const EdgeInsets.fromLTRB(20, 18, 16, 18),
            decoration: BoxDecoration(
                color: fill, borderRadius: BorderRadius.circular(16)),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(_group.name,
                          style: TextStyle(
                              color: ink,
                              fontSize: 24,
                              fontWeight: FontWeight.w800)),
                      const SizedBox(height: 4),
                      Text(
                        'ID ${_group.id} · You\'re $yourRole',
                        style: TextStyle(
                            color: ink.withValues(alpha: 0.75), fontSize: 13),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _GroupSessions(
            auth: widget.auth,
            group: _group,
            canStart: _group.canManage(_userId),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(4, 10, 0, 10),
            child: Text(
              'SETTINGS',
              style: TextStyle(
                  color: kMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1),
            ),
          ),
          _Section(
            title: 'Primary group',
            children: [
              if (isPrimary)
                const Text(
                    'This is your primary group, so the app uses its color.',
                    style: TextStyle(color: kMuted, height: 1.4))
              else ...[
                const Text("Your primary group sets the app's color.",
                    style: TextStyle(color: kMuted, height: 1.4)),
                const SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerLeft,
                  child: FilledButton(
                    onPressed: _savingPrimary ? null : _makePrimary,
                    style: FilledButton.styleFrom(
                      backgroundColor: team.fill,
                      foregroundColor: team.ink,
                    ),
                    child: Text(_savingPrimary
                        ? 'Saving…'
                        : 'Make this my primary group'),
                  ),
                ),
              ],
            ],
          ),
          if (_group.canManage(_userId))
            _ColorSection(
              group: _group,
              api: _api,
              onSaved: (updated) {
                setState(() => _group = updated);
                // The primary group's color may have changed.
                TeamAccent.of(context).refresh();
              },
            ),
          if (_group.inviteCode != null && _group.inviteUrl != null)
            _Section(
              title: 'Invite people',
              children: [
                InvitePanel(
                  group: _group,
                  onReset:
                      _group.canManage(_userId) ? _resetInvite : null,
                  resetting: _resettingInvite,
                ),
              ],
            ),
          if (_group.canManage(_userId))
            _RequestsSection(
              group: _group,
              api: _api,
              onApproved: () => setState(() => _rosterVersion++),
            ),
          _MembersSection(
            key: ValueKey(_rosterVersion),
            group: _group,
            api: _api,
            userId: _userId,
            isOwner: _isOwner,
            onTransferred: (updated) {
              setState(() => _group = updated);
              TeamAccent.of(context).refresh();
            },
          ),
          if (_isOwner)
            _OwnerSection(
              group: _group,
              api: _api,
              userId: _userId,
              onSaved: (updated) {
                setState(() => _group = updated);
                TeamAccent.of(context).refresh();
              },
              onGone: _goneFromGroup,
            )
          else
            _LeaveSection(group: _group, api: _api, onLeft: _goneFromGroup),
        ],
      ),
    );
  }
}

/// The group's live session to join, starting one (admins and the owner,
/// whom the server lets create sessions), and its finished sessions'
/// recordings, newest first. Like the web group page.
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
    final buttonStyle = FilledButton.styleFrom(
        backgroundColor: team.fill, foregroundColor: team.ink);

    return Column(
      children: [
        _Section(
          title: 'Session',
          children: [
            for (final s in live)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    const CircleAvatar(radius: 4, backgroundColor: kLiveRed),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        '${s.name} · ${s.activeMemberCount} '
                        '${s.activeMemberCount == 1 ? 'device' : 'devices'}',
                        style: const TextStyle(
                            color: Colors.white, fontWeight: FontWeight.w600),
                      ),
                    ),
                    FilledButton(
                      onPressed: _busy ? null : () => _join(s),
                      style: buttonStyle,
                      child: Text(s.isJoined ? 'Enter' : 'Join'),
                    ),
                  ],
                ),
              ),
            if (live.isEmpty && widget.canStart) ...[
              TextField(
                controller: _name,
                maxLength: 100,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(
                  hintText: 'Session name',
                  counterText: '',
                ),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _busy ? null : _start,
                  style: buttonStyle,
                  icon: const Icon(Icons.videocam),
                  label: Text(_busy ? 'Starting…' : 'Start a session'),
                ),
              ),
            ] else if (live.isEmpty)
              const Text(
                'Nothing live right now. An admin starts sessions for this group.',
                style: TextStyle(color: kMuted, height: 1.4),
              ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: Color(0xFFFF8A80))),
            ],
          ],
        ),
        _Section(
          title: 'Sessions',
          // The newest few here; View all opens the group's full list.
          action: done.isEmpty
              ? null
              : TextButton(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => RecordingsScreen(
                        auth: widget.auth,
                        groupId: widget.group.id,
                        title: widget.group.name),
                  )),
                  style: TextButton.styleFrom(
                    foregroundColor: team.accent,
                    padding: EdgeInsets.zero,
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text('View all'),
                ),
          children: [
            if (_sessions == null && _error == null)
              const Text('Loading…', style: TextStyle(color: kMuted))
            else if (done.isEmpty)
              const Text('No recordings yet. Finished sessions show up here.',
                  style: TextStyle(color: kMuted, height: 1.4))
            else
              for (final s in done.take(4))
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Container(
                    width: 52,
                    height: 36,
                    decoration: BoxDecoration(
                        color: const Color(0xFF0A0B0D),
                        borderRadius: BorderRadius.circular(7)),
                    child: Icon(Icons.play_circle_fill,
                        color: team.accent, size: 20),
                  ),
                  title: Text(s.name,
                      style: const TextStyle(
                          color: Colors.white, fontWeight: FontWeight.w600)),
                  subtitle: Text(
                    [
                      if (s.scheduledAt != null)
                        '${s.scheduledAt!.month}/${s.scheduledAt!.day}',
                      if (s.recordingCount != null)
                        '${s.recordingCount} ${s.recordingCount == 1 ? 'recording' : 'recordings'}',
                    ].join(' · '),
                    style: const TextStyle(color: kMuted),
                  ),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) =>
                        WatchScreen(auth: widget.auth, session: s),
                  )),
                ),
          ],
        ),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children, this.action});

  final String title;
  final List<Widget> children;

  /// Shown at the right of the title, like a "View all" link.
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    // Material rather than a colored box, so tap ripples inside show.
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Material(
        color: kSurface,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(title,
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 17,
                            fontWeight: FontWeight.w700)),
                  ),
                  if (action != null) action!,
                ],
              ),
              const SizedBox(height: 8),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

/// Team color swatches for admins and the owner. Everyone else never sees
/// this, and the server refuses their changes anyway.
class _ColorSection extends StatefulWidget {
  const _ColorSection(
      {required this.group, required this.api, required this.onSaved});

  final Group group;
  final GroupsApi api;
  final ValueChanged<Group> onSaved;

  @override
  State<_ColorSection> createState() => _ColorSectionState();
}

class _ColorSectionState extends State<_ColorSection> {
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
      widget.onSaved(await widget.api.updateColor(widget.group.id, _color!));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    return _Section(
      title: 'Team color',
      children: [
        const Text(
          "Shown on the group's card, and across the app for anyone whose primary group this is.",
          style: TextStyle(color: kMuted, height: 1.4),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            for (final (name, hex) in kTeamColors)
              Semantics(
                label: 'Team color $name',
                selected: hex == _color,
                button: true,
                child: GestureDetector(
                  onTap: _saving ? null : () => setState(() => _color = hex),
                  child: Container(
                    width: 36,
                    height: 36,
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
                            size: 20, color: inkOn(parseHexColor(hex)!))
                        : null,
                  ),
                ),
              ),
          ],
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(_error!, style: const TextStyle(color: kLiveRed)),
          ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerRight,
          child: FilledButton(
            onPressed: _saving || !_changed ? null : _save,
            style: FilledButton.styleFrom(
                backgroundColor: team.fill, foregroundColor: team.ink),
            child: Text(_saving ? 'Saving…' : 'Save color'),
          ),
        ),
      ],
    );
  }
}

class _MembersSection extends StatefulWidget {
  const _MembersSection({
    super.key,
    required this.group,
    required this.api,
    required this.userId,
    required this.isOwner,
    required this.onTransferred,
  });

  final Group group;
  final GroupsApi api;
  final int? userId;
  final bool isOwner;

  /// After the owner hands the group to someone, with the updated group.
  final ValueChanged<Group> onTransferred;

  @override
  State<_MembersSection> createState() => _MembersSectionState();
}

class _MembersSectionState extends State<_MembersSection> {
  List<GroupMember>? _members;
  String? _error;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final members = await widget.api.getMembers(widget.group.id);
      if (mounted) setState(() => _members = members);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  bool get _isAdmin => widget.isOwner || widget.group.role == 'admin';

  /// Same rule as the web roster: the owner can manage anyone else; admins
  /// can manage members and viewers.
  bool _canManage(GroupMember member) =>
      member.id != widget.group.owner &&
      member.id != widget.userId &&
      (widget.isOwner ||
          (_isAdmin && (member.role == 'member' || member.role == 'viewer')));

  /// A role change saves straight away (it's easy to undo); removing
  /// someone asks first.
  Future<void> _update(GroupMember member, String? role) async {
    // Only the new owner could hand it back, so this asks first.
    if (role == 'owner') {
      final ok = await _confirm(
        context,
        "Make ${member.name} the owner of ${widget.group.name}? You'll become an admin, and only they can hand it back.",
        'Make owner',
      );
      if (!ok || !mounted) return;
    }
    if (role == null) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          content: Text('Remove ${member.name} from this group?'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              style: FilledButton.styleFrom(backgroundColor: kLiveRed),
              child: const Text('Remove'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }

    setState(() => _saving = true);
    try {
      if (role == 'owner') {
        final updated = await widget.api.transfer(widget.group.id, member.id);
        // The old owner stays on as an admin, and so does the new one.
        setState(() => _members = [
              for (final m in _members!)
                m.id == member.id || m.id == widget.userId
                    ? GroupMember(id: m.id, name: m.name, role: 'admin')
                    : m,
            ]);
        widget.onTransferred(updated);
      } else if (role == null) {
        await widget.api.removeMember(widget.group.id, member.id);
        setState(
            () => _members = [..._members!.where((m) => m.id != member.id)]);
      } else {
        await widget.api.changeMemberRole(widget.group.id, member.id, role);
        setState(() => _members = [
              for (final m in _members!)
                m.id == member.id
                    ? GroupMember(id: m.id, name: m.name, role: role)
                    : m,
            ]);
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _roleName(GroupMember member) => member.id == widget.group.owner
      ? 'Owner'
      : switch (member.role) {
          'admin' => 'Admin',
          'viewer' => 'Viewer',
          _ => 'Member'
        };

  @override
  Widget build(BuildContext context) {
    final members = _members;
    return _Section(
      title: members == null ? 'Members' : 'Members (${members.length})',
      children: [
        if (_error != null)
          Text(_error!, style: const TextStyle(color: kLiveRed))
        else if (members == null)
          const Padding(
            padding: EdgeInsets.all(12),
            child: Center(child: CircularProgressIndicator()),
          )
        else
          for (final member in members)
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: Text(member.name,
                  style: const TextStyle(color: Colors.white, fontSize: 15)),
              subtitle: _canManage(member)
                  ? null
                  : Text(_roleName(member),
                      style: const TextStyle(color: kMuted)),
              trailing: _canManage(member)
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        DropdownButton<String>(
                          value: member.role,
                          dropdownColor: kSurfaceLight,
                          underline: const SizedBox(),
                          style: const TextStyle(
                              color: Colors.white, fontSize: 14),
                          onChanged: _saving
                              ? null
                              : (role) {
                                  if (role != null && role != member.role) {
                                    _update(member, role);
                                  }
                                },
                          items: [
                            if (widget.isOwner)
                              const DropdownMenuItem(
                                  value: 'owner', child: Text('Owner')),
                            const DropdownMenuItem(
                                value: 'admin', child: Text('Admin')),
                            const DropdownMenuItem(
                                value: 'member', child: Text('Member')),
                            const DropdownMenuItem(
                                value: 'viewer', child: Text('Viewer')),
                          ],
                        ),
                        IconButton(
                          onPressed:
                              _saving ? null : () => _update(member, null),
                          tooltip: 'Remove ${member.name} from group',
                          icon: const Icon(Icons.remove,
                              color: kLiveRed, size: 28),
                        ),
                      ],
                    )
                  : null,
            ),
      ],
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

/// The owner's controls: the group's name, handing it to someone else
/// (after which they can leave), and deleting it.
class _OwnerSection extends StatefulWidget {
  const _OwnerSection({
    required this.group,
    required this.api,
    required this.userId,
    required this.onSaved,
    required this.onGone,
  });

  final Group group;
  final GroupsApi api;
  final int? userId;
  final ValueChanged<Group> onSaved;
  final VoidCallback onGone;

  @override
  State<_OwnerSection> createState() => _OwnerSectionState();
}

class _OwnerSectionState extends State<_OwnerSection> {
  late final _name = TextEditingController(text: widget.group.name);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _toast(String message) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(message)));

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _saveDetails() => _run(() async {
        final updated = await widget.api
            .updateDetails(widget.group.id, name: _name.text.trim());
        widget.onSaved(updated);
        _toast('Group details saved');
      });

  Future<void> _delete() async {
    final ok = await _confirm(
      context,
      "Delete ${widget.group.name} with all of its sessions, recordings and comments? This can't be undone.",
      'Delete',
    );
    if (!ok || !mounted) return;
    await _run(() async {
      await widget.api.deleteGroup(widget.group.id);
      widget.onGone();
    });
  }

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Section(
          title: 'Group details',
          children: [
            TextField(
              controller: _name,
              maxLength: 100,
              enabled: !_busy,
              decoration:
                  const InputDecoration(labelText: 'Name', counterText: ''),
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                onPressed: _busy ? null : _saveDetails,
                style: FilledButton.styleFrom(
                    backgroundColor: team.fill, foregroundColor: team.ink),
                child: const Text('Save'),
              ),
            ),
          ],
        ),
        _Section(
          title: 'Delete group',
          children: [
            const Text(
              'Deleting the group removes every session, recording and comment in it.',
              style: TextStyle(color: kMuted, height: 1.4),
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton(
                onPressed: _busy ? null : _delete,
                style: OutlinedButton.styleFrom(
                  foregroundColor: kLiveRed,
                  side: const BorderSide(color: Color(0xFF5A2A2A)),
                ),
                child: const Text('Delete group'),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(_error!, style: const TextStyle(color: kLiveRed)),
              ),
          ],
        ),
      ],
    );
  }
}

class _LeaveSection extends StatefulWidget {
  const _LeaveSection(
      {required this.group, required this.api, required this.onLeft});

  final Group group;
  final GroupsApi api;
  final VoidCallback onLeft;

  @override
  State<_LeaveSection> createState() => _LeaveSectionState();
}

class _LeaveSectionState extends State<_LeaveSection> {
  bool _leaving = false;
  String? _error;

  Future<void> _leave() async {
    final ok = await _confirm(
      context,
      "Leave ${widget.group.name}? You'll need an invite to join again.",
      'Leave',
    );
    if (!ok || !mounted) return;
    setState(() {
      _leaving = true;
      _error = null;
    });
    try {
      await widget.api.leave(widget.group.id);
      widget.onLeft();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _leaving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return _Section(
      title: 'Leave group',
      children: [
        const Text("You'll stop seeing its sessions and recordings.",
            style: TextStyle(color: kMuted)),
        const SizedBox(height: 10),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton(
            onPressed: _leaving ? null : _leave,
            style: OutlinedButton.styleFrom(
              foregroundColor: kLiveRed,
              side: const BorderSide(color: Color(0xFF5A2A2A)),
            ),
            child: Text(_leaving ? 'Leaving…' : 'Leave group'),
          ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(_error!, style: const TextStyle(color: kLiveRed)),
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
        messenger.showSnackBar(
            SnackBar(content: Text('${request.name} is in ${widget.group.name}')));
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
    return _Section(
      title: 'Requests to join (${_requests.length})',
      children: [
        for (final request in _requests)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(request.name,
                          style: const TextStyle(
                              color: Colors.white, fontSize: 15)),
                      Text(_asked(request.requestedAt),
                          style: const TextStyle(color: kMuted, fontSize: 13)),
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
                      backgroundColor: team.fill, foregroundColor: team.ink),
                  child: const Text('Approve'),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

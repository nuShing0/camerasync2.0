import 'dart:async';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/groups_api.dart';
import '../auth/auth_service.dart';
import '../groups/invite_code.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/create_group_dialog.dart';
import '../widgets/empty_state.dart';
import '../widgets/invite_panel.dart';
import '../widgets/invite_preview.dart';
import 'group_settings_screen.dart';
import 'scan_invite_screen.dart';

/// Lists the user's groups and lets them open a group's sessions. Groups
/// are joined with an invite (a code, link or QR from someone in it), or by
/// asking to join with the group's ID for an admin to approve.
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

  List<Group> _groups = [];
  bool _loading = true;
  String? _error;

  /// The invite field: a code or a pasted link. [_inviteCode] is the code
  /// in it once there is one, and its preview shows below.
  final _invite = TextEditingController();
  String? _inviteCode;
  String? _inviteHint;

  /// Asking to join by the group's exact ID, the way in without an invite.
  final _requestId = TextEditingController();
  bool _asking = false;
  bool _requesting = false;
  String? _requestMessage;
  bool _requestFailed = false;

  @override
  void initState() {
    super.initState();
    _loadGroups();
    widget.refresh?.addListener(_loadGroups);
  }

  @override
  void dispose() {
    widget.refresh?.removeListener(_loadGroups);
    _invite.dispose();
    _requestId.dispose();
    super.dispose();
  }

  Future<void> _loadGroups() async {
    setState(() {
      _loading = true;
      _error = null;
    });

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

  /// The preview shows as soon as the field holds a whole code or link.
  void _onInviteChanged(String text) {
    setState(() {
      _inviteCode = inviteCodeFrom(text);
      _inviteHint = null;
    });
  }

  void _onInviteSubmitted(String text) {
    if (_inviteCode == null && text.trim().isNotEmpty) {
      setState(() => _inviteHint =
          'Enter the 6-character code, like ABC-DEF, or paste the invite link.');
    }
  }

  Future<void> _scan() async {
    final code = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const ScanInviteScreen()),
    );
    if (code == null || !mounted) return;
    _invite.text = formatInviteCode(code);
    _onInviteChanged(code);
  }

  void _clearInvite() {
    _invite.clear();
    _onInviteChanged('');
  }

  Future<void> _joined(Group group) async {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('Joined ${group.name}')));
    _clearInvite();
    await _loadGroups();
    if (!mounted) return;
    // A first group becomes the primary group, which colors the app.
    TeamAccent.of(context).refresh();
    await _openGroup(group);
  }

  Future<void> _openGroupById(String id) async {
    Group? find() => _groups.where((g) => g.id == id).firstOrNull;
    // Joined somewhere the list hasn't caught up with yet.
    if (find() == null) await _loadGroups();
    final group = find();
    if (group == null || !mounted) return;
    _clearInvite();
    await _openGroup(group);
  }

  Future<void> _askToJoin() async {
    final id = _requestId.text.trim();
    if (id.isEmpty) return;
    setState(() {
      _requesting = true;
      _requestMessage = null;
    });
    try {
      final result = await _groupsApi.requestToJoin(id);
      if (!mounted) return;
      setState(() {
        _requestFailed = false;
        _requestMessage = result.alreadyMember
            ? "You're already in ${result.groupName}."
            : "Request sent to ${result.groupName}. You'll be in once an "
                'admin approves.';
      });
      if (!result.alreadyMember) _requestId.clear();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _requestFailed = true;
        _requestMessage = e.message;
      });
    } finally {
      if (mounted) setState(() => _requesting = false);
    }
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
              fontSize: 22,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Your groups let you share sessions and recordings with teammates.\nTap a group to view its sessions.',
            style: TextStyle(color: kMuted, height: 1.5),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _createGroup,
              style: TextButton.styleFrom(padding: EdgeInsets.zero),
              child: Text.rich(
                TextSpan(
                  text: "Don't have a group? ",
                  style: const TextStyle(color: Colors.white),
                  children: [
                    TextSpan(
                      text: 'Create one',
                      style: TextStyle(
                        color: team.accent,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),

          const Text('Join a group', style: TextStyle(color: kMuted)),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _invite,
                  decoration: InputDecoration(
                    hintText: 'Enter a code or paste a link',
                    prefixIcon: const Icon(Icons.group_add_outlined),
                    suffixIcon: _invite.text.isEmpty
                        ? null
                        : IconButton(
                            tooltip: 'Clear',
                            icon: const Icon(Icons.close),
                            onPressed: _clearInvite,
                          ),
                    filled: true,
                    fillColor: const Color(0xFF121212),
                    border: const OutlineInputBorder(
                        borderRadius: BorderRadius.zero),
                  ),
                  autocorrect: false,
                  textCapitalization: TextCapitalization.characters,
                  textInputAction: TextInputAction.go,
                  onChanged: _onInviteChanged,
                  onSubmitted: _onInviteSubmitted,
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                height: 56,
                child: OutlinedButton.icon(
                  onPressed: _scan,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: const BorderSide(color: kSurfaceLight),
                    shape: const RoundedRectangleBorder(),
                  ),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('Scan QR'),
                ),
              ),
            ],
          ),
          if (_inviteCode != null) ...[
            const SizedBox(height: 12),
            InvitePreviewCard(
              api: _groupsApi,
              code: _inviteCode!,
              onJoined: _joined,
              onOpen: _openGroupById,
            ),
          ] else if (_inviteHint != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_inviteHint!,
                  style: const TextStyle(color: kMuted, height: 1.4)),
            ),

          // Without an invite: ask with the group's exact ID.
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => setState(() => _asking = !_asking),
              style: TextButton.styleFrom(padding: EdgeInsets.zero),
              child: Text.rich(
                TextSpan(
                  text: "Know the group's ID? ",
                  style: const TextStyle(color: kMuted, fontSize: 13),
                  children: [
                    TextSpan(
                      text: 'Ask to join',
                      style: TextStyle(
                        color: team.accent,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_asking) ...[
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _requestId,
                    enabled: !_requesting,
                    decoration: const InputDecoration(
                      hintText: 'Group ID',
                      isDense: true,
                      filled: true,
                      fillColor: Color(0xFF121212),
                      border:
                          OutlineInputBorder(borderRadius: BorderRadius.zero),
                    ),
                    autocorrect: false,
                    // IDs are letters and numbers only (see CreateGroupDialog).
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp('[A-Za-z0-9]')),
                    ],
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _askToJoin(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _requesting ? null : _askToJoin,
                  style: FilledButton.styleFrom(
                      backgroundColor: team.fill, foregroundColor: team.ink),
                  child: Text(_requesting ? 'Sending…' : 'Ask'),
                ),
              ],
            ),
            if (_requestMessage != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _requestMessage!,
                  style: TextStyle(
                      color: _requestFailed
                          ? const Color(0xFFFF8A80)
                          : Colors.white,
                      height: 1.4),
                ),
              ),
          ],
          const SizedBox(height: 8),
          const Divider(color: Color(0xFF2A2A2A)),
          const SizedBox(height: 8),

          const Text('My groups', style: TextStyle(color: kMuted)),
          const SizedBox(height: 12),

          if (_loading)
            const Padding(
              padding: EdgeInsets.only(top: 48),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_error != null)
            _Notice(message: _error!, actionLabel: 'Retry', onAction: _loadGroups)
          else if (_groups.isEmpty)
            EmptyState(
              title: 'No groups yet',
              message: "Enter your team's invite code above to join its "
                  'group, or create a new one for your team.',
              actionLabel: 'Create a group',
              onAction: _createGroup,
            )
          else
            // Long-press a group and drag it to change the order; the order
            // is saved on the account, like on the web.
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
                      scale: 1 + 0.06 * t,
                      child: Material(
                        color: Colors.transparent,
                        elevation: 16 * t,
                        shadowColor: Colors.black,
                        borderRadius: BorderRadius.circular(12),
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
                    isPrimary: g.id == TeamAccent.of(context).primaryGroup?.id,
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

  /// The group's page: its live session or starting one, its recordings,
  /// and its settings.
  Future<void> _openGroup(Group g) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => GroupSettingsScreen(auth: widget.auth, group: g)),
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

class _GroupCard extends StatelessWidget {
  const _GroupCard({
    required this.group,
    required this.isPrimary,
    required this.onOpen,
  });

  final Group group;
  final bool isPrimary;
  final VoidCallback onOpen;

  /// The card is filled with the team color and opens the group's page,
  /// matching the web's group tiles.
  @override
  Widget build(BuildContext context) {
    final fill = parseHexColor(group.primaryColor);
    final ink = fill == null ? Colors.white : inkOn(fill);

    return Card(
      color: fill ?? const Color(0xFF1C1C1C),
      margin: const EdgeInsets.only(bottom: 12),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 14, 10, 14),
        child: Row(
          children: [
            // Shows the cards can be moved: long-press and drag.
            Icon(Icons.drag_indicator, color: ink.withValues(alpha: 0.55)),
            const SizedBox(width: 6),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    children: [
                      Text(
                        group.name,
                        style: TextStyle(color: ink, fontSize: 16, fontWeight: FontWeight.w600),
                      ),
                      if (isPrimary)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: ink.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text('Primary',
                              style: TextStyle(color: ink, fontSize: 11, fontWeight: FontWeight.w700)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Group ID: ${group.id}',
                    style: TextStyle(color: fill == null ? kMuted : ink.withValues(alpha: 0.75)),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: ink.withValues(alpha: 0.8)),
          ],
        ),
        ),
      ),
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
          Text(message, textAlign: TextAlign.center, style: const TextStyle(color: kMuted, height: 1.5)),
          if (actionLabel != null) ...[
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onAction, child: Text(actionLabel!)),
          ]
        ],
      ),
    );
  }
}

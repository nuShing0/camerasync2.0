import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../groups/invite_code.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../widgets/invite_preview.dart';
import 'scan_invite_screen.dart';

/// What the join screen ended with: a group just [joined], or the ID of one
/// the user was in already and chose to open.
typedef JoinGroupResult = ({Group? joined, String id});

/// Joining a group, in a sheet from Join group on the Groups tab (see
/// [showJoinGroupSheet]): an invite (a code, link or QR from someone in it)
/// with its preview, or asking to join with the group's ID for an admin to
/// approve. Pops with a [JoinGroupResult] once there's a group to open.
class JoinGroupScreen extends StatefulWidget {
  const JoinGroupScreen({super.key, required this.api});

  final GroupsApi api;

  @override
  State<JoinGroupScreen> createState() => _JoinGroupScreenState();
}

class _JoinGroupScreenState extends State<JoinGroupScreen> {
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
  void dispose() {
    _invite.dispose();
    _requestId.dispose();
    super.dispose();
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

  Future<void> _askToJoin() async {
    final id = _requestId.text.trim();
    if (id.isEmpty) return;
    setState(() {
      _requesting = true;
      _requestMessage = null;
    });
    try {
      final result = await widget.api.requestToJoin(id);
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

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    const field = OutlineInputBorder(
      borderRadius: BorderRadius.all(Radius.circular(14)),
      borderSide: BorderSide.none,
    );

    // Rises with the keyboard, so the field and the preview stay in view.
    return Padding(
      padding:
          EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 28),
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: kSurfaceLight,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Join group',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Close',
                icon: const Icon(Icons.close, color: kMuted),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            "Enter the invite code from someone in the group, paste their "
            'link, or scan their QR.',
            style: TextStyle(color: kMuted, height: 1.4),
          ),
          const SizedBox(height: 14),
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
                    fillColor: kSurface,
                    border: field,
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
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
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
              api: widget.api,
              code: _inviteCode!,
              onJoined: (group) =>
                  Navigator.of(context).pop((joined: group, id: group.id)),
              onOpen: (id) => Navigator.of(context).pop((joined: null, id: id)),
            ),
          ] else if (_inviteHint != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_inviteHint!,
                  style: const TextStyle(color: kMuted, height: 1.4)),
            ),
          const SizedBox(height: 8),

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
                      fillColor: kSurface,
                      border: field,
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
        ],
      ),
    );
  }
}

/// Opens joining as a sheet over the current screen. Resolves with what
/// it ended with, or null if it was closed.
Future<JoinGroupResult?> showJoinGroupSheet(
    BuildContext context, GroupsApi api) {
  return showModalBottomSheet<JoinGroupResult>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: kBackground,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (_) => JoinGroupScreen(api: api),
  );
}

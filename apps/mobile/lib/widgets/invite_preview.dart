import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../theme.dart';

/// What an invite code leads to before joining: the group's name in its
/// team color, how many are in it, and Join. For a group the user is in
/// already it says so and offers to open it instead. Used on the Groups tab
/// and in the sheet an invite link opens.
class InvitePreviewCard extends StatefulWidget {
  const InvitePreviewCard({
    super.key,
    required this.api,
    required this.code,
    required this.onJoined,
    required this.onOpen,
  });

  final GroupsApi api;
  final String code;

  /// After joining, with the group.
  final ValueChanged<Group> onJoined;

  /// Open the page of a group the user is already in, by its ID.
  final ValueChanged<String> onOpen;

  @override
  State<InvitePreviewCard> createState() => _InvitePreviewCardState();
}

class _InvitePreviewCardState extends State<InvitePreviewCard> {
  GroupInvite? _invite;
  String? _error;
  bool _joining = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(InvitePreviewCard old) {
    super.didUpdateWidget(old);
    if (old.code != widget.code) {
      setState(() {
        _invite = null;
        _error = null;
      });
      _load();
    }
  }

  Future<void> _load() async {
    final code = widget.code;
    try {
      final invite = await widget.api.getInvite(code);
      // A reply for a code that's since been replaced doesn't count.
      if (!mounted || code != widget.code) return;
      setState(() => _invite = invite);
    } on ApiException catch (e) {
      if (!mounted || code != widget.code) return;
      setState(() => _error = e.message);
    }
  }

  Future<void> _join() async {
    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      final group = await widget.api.joinWithInvite(widget.code);
      if (mounted) widget.onJoined(group);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _joining = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final invite = _invite;
    if (invite == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: _error != null
            ? Text(_error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xFFFF8A80), height: 1.4))
            : const Center(child: CircularProgressIndicator()),
      );
    }

    final color = parseHexColor(invite.primaryColor) ?? kGold;
    final ink = inkOn(color);
    final members =
        '${invite.memberCount} ${invite.memberCount == 1 ? 'member' : 'members'}';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
          color: kSurface, borderRadius: BorderRadius.circular(16)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 22,
                backgroundColor: color,
                child: Text(
                  invite.name.isEmpty ? '?' : invite.name[0].toUpperCase(),
                  style: TextStyle(
                      color: ink, fontSize: 18, fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(invite.name,
                        style: TextStyle(
                            color: legibleOnDark(color),
                            fontSize: 18,
                            fontWeight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    Text(members, style: const TextStyle(color: kMuted)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          if (invite.isMember) ...[
            const Text("You're already in this group.",
                style: TextStyle(color: Colors.white)),
            const SizedBox(height: 10),
            OutlinedButton(
              onPressed: () => widget.onOpen(invite.id),
              style: OutlinedButton.styleFrom(
                foregroundColor: Colors.white,
                side: const BorderSide(color: kSurfaceLight),
              ),
              child: const Text('Open group'),
            ),
          ] else
            FilledButton(
              onPressed: _joining ? null : _join,
              style: FilledButton.styleFrom(
                  backgroundColor: color, foregroundColor: ink),
              child: Text(_joining ? 'Joining…' : 'Join ${invite.name}'),
            ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: const TextStyle(color: Color(0xFFFF8A80))),
          ],
        ],
      ),
    );
  }
}

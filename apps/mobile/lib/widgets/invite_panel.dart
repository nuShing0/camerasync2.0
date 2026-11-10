import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../api/groups_api.dart';
import '../groups/invite_code.dart';
import '../team_accent.dart';
import '../theme.dart';

/// A group's invite: the code in big letters to read out, Share (the
/// phone's share sheet: Messages, Snapchat, ...), Copy link and Show QR for
/// someone standing next to you. [onReset] (admins only) adds Reset invite.
/// On the group page and in the sheet after creating a group.
class InvitePanel extends StatelessWidget {
  const InvitePanel({
    super.key,
    required this.group,
    this.onReset,
    this.resetting = false,
  });

  final Group group;
  final VoidCallback? onReset;
  final bool resetting;

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final code = group.inviteCode;
    final link = group.inviteUrl;
    if (code == null || link == null) return const SizedBox.shrink();
    final outlined = OutlinedButton.styleFrom(
      foregroundColor: Colors.white,
      side: const BorderSide(color: kSurfaceLight),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('Anyone with this code, link or QR can join.',
            style: TextStyle(color: kMuted, height: 1.4)),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
              color: const Color(0xFF0A0B0D),
              borderRadius: BorderRadius.circular(12)),
          child: SelectableText(
            formatInviteCode(code),
            textAlign: TextAlign.center,
            semanticsLabel: 'Invite code ${code.split('').join(' ')}',
            style: const TextStyle(
              color: Colors.white,
              fontSize: 34,
              fontWeight: FontWeight.w800,
              letterSpacing: 4,
            ),
          ),
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: () => SharePlus.instance.share(ShareParams(
            text: 'Join ${group.name} on 8kount with code '
                '${formatInviteCode(code)}: $link',
          )),
          style: FilledButton.styleFrom(
              backgroundColor: team.fill, foregroundColor: team.ink),
          icon: const Icon(Icons.ios_share),
          label: const Text('Share'),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: link));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Invite link copied')));
                  }
                },
                style: outlined,
                icon: const Icon(Icons.link),
                label: const Text('Copy link'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => showInviteQr(context, group),
                style: outlined,
                icon: const Icon(Icons.qr_code_2),
                label: const Text('Show QR'),
              ),
            ),
          ],
        ),
        if (onReset != null) ...[
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: resetting ? null : onReset,
              style: TextButton.styleFrom(
                  foregroundColor: kMuted, padding: EdgeInsets.zero),
              icon: const Icon(Icons.refresh, size: 18),
              label: Text(resetting ? 'Resetting…' : 'Reset invite'),
            ),
          ),
        ],
      ],
    );
  }
}

/// The invite link as a QR code, big enough to scan from another phone
/// held up to this one. Dark on white, the way cameras read QR codes best.
Future<void> showInviteQr(BuildContext context, Group group) {
  return showDialog<void>(
    context: context,
    builder: (context) => Dialog(
      backgroundColor: kSurface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(group.name,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 20,
                    fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            const Text('Scan to join', style: TextStyle(color: kMuted)),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                  color: Colors.white, borderRadius: BorderRadius.circular(12)),
              child: QrImageView(
                data: group.inviteUrl!,
                size: 220,
                padding: EdgeInsets.zero,
                backgroundColor: Colors.white,
                semanticsLabel: 'QR code for the ${group.name} invite',
              ),
            ),
            const SizedBox(height: 12),
            Text(formatInviteCode(group.inviteCode!),
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 3)),
            const SizedBox(height: 4),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Right after creating a group: its invite, so the team can be brought in
/// straight away.
Future<void> showInviteTeamSheet(BuildContext context, Group group) {
  if (group.inviteCode == null || group.inviteUrl == null) {
    return Future.value();
  }
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: kSurface,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Invite your team',
              style: TextStyle(
                color: TeamAccent.of(context).accent,
                fontSize: 20,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '${group.name} is ready. Send your team the invite so they can '
              'join; you can find it again on the group\'s page.',
              style: const TextStyle(color: Colors.white, height: 1.4),
            ),
            const SizedBox(height: 14),
            InvitePanel(group: group),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Done', style: TextStyle(color: kMuted)),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

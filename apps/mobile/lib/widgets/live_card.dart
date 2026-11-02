import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../config.dart';
import '../screens/session_screen.dart';
import '../team_accent.dart';
import '../theme.dart';

/// A scheduled session whose start time has come: it can be joined from
/// then until 15 minutes after (the server's rule).
bool isOpenToJoin(RecordingSession s) {
  final at = s.scheduledAt;
  if (!s.isScheduled || at == null) return false;
  final since = DateTime.now().difference(at);
  return !since.isNegative && since <= const Duration(minutes: 15);
}

/// What the live card is for: sessions live now, then ones open to join.
List<RecordingSession> liveNow(Iterable<RecordingSession> sessions) => [
      ...sessions.where((s) => s.isActive),
      ...sessions.where(isOpenToJoin),
    ];

/// "6:52 PM".
String clockLabel(DateTime at) {
  final time = TimeOfDay.fromDateTime(at);
  return '${time.hourOfPeriod == 0 ? 12 : time.hourOfPeriod}:'
      '${time.minute.toString().padLeft(2, '0')} '
      '${time.period == DayPeriod.am ? 'AM' : 'PM'}';
}

/// Goes into [session]: the REST join first (it records membership and
/// starts a scheduled session, which the socket room checks before letting
/// us in), then the session screen. A failure shows as a snackbar.
Future<void> enterSession(
    BuildContext context, AuthService auth, RecordingSession session) async {
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);
  try {
    final joined = await RecordingsApi(auth.api).joinSession(session.id);
    await navigator.push(
      MaterialPageRoute(
        builder: (_) => SessionScreen(
          serverUrl: kServerUrl,
          auth: auth,
          sessionId: joined.id,
          sessionName: joined.name,
        ),
      ),
    );
  } on ApiException catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  }
}

/// A session happening right now, filled with the team color: who's in it
/// and a big Join (Enter once you're in). The one thing to do now, on Home
/// and atop the Sessions tab.
class LiveCard extends StatelessWidget {
  const LiveCard({
    super.key,
    required this.session,
    required this.groupName,
    required this.onJoin,
    this.joining = false,
    this.onWatch,
    this.onEnd,
  });

  final RecordingSession session;
  final String? groupName;

  /// Null hides the button (viewers watch but don't record).
  final VoidCallback? onJoin;
  final bool joining;

  /// "Watch so far" and "End session" links, shown when set.
  final VoidCallback? onWatch;
  final VoidCallback? onEnd;

  static const _maxFaces = 4;

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final ink = team.ink;
    final s = session;
    final at = s.scheduledAt;
    final devices = s.activeMemberCount;
    final takes = s.recordingCount ?? 0;

    final where = [
      if (groupName != null && groupName!.isNotEmpty) groupName!,
      if (at != null) s.isActive ? 'started ${clockLabel(at)}' : clockLabel(at),
    ].join(' · ');
    final links = [
      if (onWatch != null) _link('Watch so far', onWatch!, ink),
      if (onEnd != null) _link('End session', onEnd!, ink),
    ];

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: team.fill,
        borderRadius: BorderRadius.circular(24),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _pill(ink),
              const SizedBox(width: 8),
              Flexible(
                child: Text(where,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        color: ink, fontSize: 12, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            s.name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
                color: ink, fontSize: 24, fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              if (s.activeMemberNames.isNotEmpty) ...[
                _faces(team),
                const SizedBox(width: 10),
              ],
              Flexible(
                child: Text(
                  s.isActive
                      ? '$devices ${devices == 1 ? 'device' : 'devices'} · '
                          '$takes ${takes == 1 ? 'recording' : 'recordings'} '
                          'so far'
                      : 'Open to join now',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      color: ink, fontSize: 13, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
          if (links.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(spacing: 14, runSpacing: 4, children: links),
          ],
          if (onJoin != null) ...[
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              height: 48,
              child: FilledButton(
                onPressed: joining ? null : onJoin,
                style: FilledButton.styleFrom(
                  backgroundColor: ink,
                  foregroundColor: team.fill,
                  disabledBackgroundColor: ink,
                  shape: const StadiumBorder(),
                ),
                child: joining
                    ? SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: team.fill),
                      )
                    : Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.videocam_outlined, size: 20),
                          const SizedBox(width: 8),
                          // Enter when already in it, as on the web.
                          Text(
                            s.isJoined && s.isActive ? 'Enter' : 'Join',
                            style: const TextStyle(
                                fontSize: 16, fontWeight: FontWeight.w700),
                          ),
                        ],
                      ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// LIVE with a red dot, in the card's ink; STARTING for a scheduled one
  /// whose time has come.
  Widget _pill(Color ink) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: ink,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (session.isActive) ...[
            Container(
              width: 7,
              height: 7,
              decoration:
                  const BoxDecoration(color: kLiveRed, shape: BoxShape.circle),
            ),
            const SizedBox(width: 5),
          ],
          Text(
            session.isActive ? 'LIVE' : 'STARTING',
            style: TextStyle(
                color: inkOn(ink), fontSize: 12, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }

  /// Who's in it, as overlapping initials: the first few, then +N.
  Widget _faces(TeamAccent team) {
    final names = session.activeMemberNames;
    final shown = names.take(_maxFaces).toList();
    final extra = names.length - shown.length;
    final labels = [
      for (final name in shown)
        name.trim().isEmpty ? '?' : name.trim().characters.first.toUpperCase(),
      if (extra > 0) '+$extra',
    ];
    const size = 26.0, step = 18.0;
    return SizedBox(
      width: size + step * (labels.length - 1),
      height: size,
      child: Stack(
        children: [
          for (var i = 0; i < labels.length; i++)
            Positioned(
              left: step * i,
              child: Container(
                width: size,
                height: size,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: team.ink,
                  shape: BoxShape.circle,
                  border: Border.all(color: team.fill, width: 2),
                ),
                child: Text(
                  labels[i],
                  style: TextStyle(
                      color: team.fill,
                      fontSize: labels[i].length > 2 ? 9 : 11,
                      fontWeight: FontWeight.w700),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _link(String label, VoidCallback onTap, Color ink) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Text(
          label,
          style: TextStyle(
            color: ink,
            fontSize: 13,
            fontWeight: FontWeight.w700,
            decoration: TextDecoration.underline,
            decorationColor: ink,
          ),
        ),
      ),
    );
  }
}

/// Several live cards swiped sideways, with dots under them. The pager is
/// as tall as the tallest card (cards differ: one may have links).
class LiveCardPager extends StatefulWidget {
  const LiveCardPager({super.key, required this.cards});

  final List<Widget> cards;

  @override
  State<LiveCardPager> createState() => _LiveCardPagerState();
}

class _LiveCardPagerState extends State<LiveCardPager> {
  int _page = 0;

  static const _gap = 12.0;

  @override
  Widget build(BuildContext context) {
    final cards = widget.cards;
    if (cards.length == 1) return cards.first;
    final page = _page.clamp(0, cards.length - 1);
    return Column(
      children: [
        Stack(
          clipBehavior: Clip.none,
          children: [
            // Invisible copies size the pager to the tallest card.
            for (final card in cards)
              Visibility(
                visible: false,
                maintainSize: true,
                maintainAnimation: true,
                maintainState: true,
                child: ExcludeSemantics(child: card),
              ),
            // Each page is a gap wider than the card, so cards don't touch
            // while swiping; the gap hangs into the screen's side margin.
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              right: -_gap,
              child: PageView.builder(
                itemCount: cards.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (context, i) => Padding(
                  padding: const EdgeInsets.only(right: _gap),
                  child: Align(alignment: Alignment.topCenter, child: cards[i]),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (var i = 0; i < cards.length; i++)
              Container(
                width: 6,
                height: 6,
                margin: const EdgeInsets.symmetric(horizontal: 3),
                decoration: BoxDecoration(
                  color: i == page
                      ? TeamAccent.of(context).accent
                      : const Color(0xFF3A3A3A),
                  shape: BoxShape.circle,
                ),
              ),
          ],
        ),
      ],
    );
  }
}

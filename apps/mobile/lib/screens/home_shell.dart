import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show lerpDouble;
import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../groups/invite_links.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../notifications/phone_alerts.dart';
import '../sessions/new_session.dart';
import '../tv/tv_link.dart';
import '../api/recordings_api.dart';
import '../outbox/upload_queue.dart';
import 'calendar_tab.dart';
import 'groups_screen.dart';
import 'home_tab.dart';
import 'sessions_tab.dart';
import 'settings_tab.dart';
import 'watch_screen.dart' show isBigScreen;

// Older imports pull the palette from this file; keep that working.
export '../theme.dart';

/// App shell after sign-in: a dark content area with the floating yellow pill
/// navigation from the design. Tabs keep their state via IndexedStack.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.auth});

  final AuthService auth;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

/// Bar slots. The middle one is the + button, not a tab.
const _home = 0, _groups = 1, _plus = 2, _sessions = 3, _calendar = 4;

class _HomeShellState extends State<HomeShell>
    with SingleTickerProviderStateMixin {
  int _index = _home;

  /// Which half of the Sessions tab shows: 0 live & upcoming, 1 past.
  final _sessionsSegment = ValueNotifier<int>(1);

  /// Ticks when the + menu starts or schedules a session.
  final _sessionsChanged = ValueNotifier<int>(0);

  /// Ticks when a group is joined from an invite link.
  final _groupsChanged = ValueNotifier<int>(0);

  /// Phone notifications for activity in the user's groups, while signed in.
  late final PhoneAlerts _alerts = PhoneAlerts(widget.auth);

  @override
  void initState() {
    super.initState();
    _alerts.start().catchError((_) {});
    // Takes still waiting from last time carry on uploading.
    final queue =
        UploadQueue.instance ??= UploadQueue(RecordingsApi(widget.auth.api));
    unawaited(queue.start());
    // TV mode: a TV plugged in gets the app's TV screen (see TvLink).
    TvLink.instance.start();
    // An invite link opened before sign-in shows now; later ones as they
    // come.
    InviteLinks.instance.pending.addListener(_showInvite);
    WidgetsBinding.instance.addPostFrameCallback((_) => _showInvite());
  }

  /// The invite preview for a link that opened the app, over whatever is
  /// showing.
  void _showInvite() {
    if (!mounted || InviteLinks.instance.pending.value == null) return;
    final code = InviteLinks.instance.take()!;
    showInvitePreviewSheet(context, widget.auth, code,
        onJoined: () => _groupsChanged.value++);
  }

  /// The + menu: the nav bar grows up into a panel of choices.
  late final AnimationController _menu = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 260),
    reverseDuration: const Duration(milliseconds: 200),
  )..addStatusListener((_) => setState(() {}));

  bool get _menuOpen =>
      _menu.status == AnimationStatus.forward ||
      _menu.status == AnimationStatus.completed;

  void _toggleMenu() => _menuOpen ? _menu.reverse() : _menu.forward();

  Future<void> _choose(String choice) async {
    await _menu.reverse();
    if (!mounted) return;
    final changed = await runNewSessionChoice(context, widget.auth, choice);
    if (changed) _sessionsChanged.value++;
  }

  @override
  void dispose() {
    InviteLinks.instance.pending.removeListener(_showInvite);
    _menu.dispose();
    _alerts.stop();
    _sessionsSegment.dispose();
    _sessionsChanged.dispose();
    _groupsChanged.dispose();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Running on the big screen itself (DeX) already shows the full grid.
    TvLink.instance.suppressed = isBigScreen(MediaQuery.sizeOf(context));
  }

  void _openSessions({required bool upcoming}) {
    _sessionsSegment.value = upcoming ? 0 : 1;
    setState(() => _index = _sessions);
  }

  void _openSettings() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (context) => Scaffold(
        backgroundColor: kBackground,
        appBar: AppBar(
          backgroundColor: kBackground,
          foregroundColor: Colors.white,
          title: const Text('Settings'),
        ),
        body: SettingsTab(auth: widget.auth, alerts: _alerts),
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final tabs = [
      HomeTab(
        key: const ValueKey('home-tab'),
        auth: widget.auth,
        onOpenSessions: _openSessions,
        onOpenSettings: _openSettings,
        onOpenGroups: () => setState(() => _index = _groups),
        onOpenCalendar: () => setState(() => _index = _calendar),
      ),
      GroupsScreen(auth: widget.auth, refresh: _groupsChanged),
      const SizedBox.shrink(), // the + button's slot
      SessionsTab(
        auth: widget.auth,
        segment: _sessionsSegment,
        refresh: _sessionsChanged,
      ),
      CalendarTab(auth: widget.auth),
    ];

    return PopScope(
      // Back closes the + menu first.
      canPop: !_menuOpen,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _menu.reverse();
      },
      child: Scaffold(
        backgroundColor: kBackground,
        // extendBody lets the content run beneath the floating nav bar.
        extendBody: true,
        body: Stack(
          children: [
            SafeArea(
              bottom: false,
              child: IndexedStack(index: _index, children: tabs),
            ),
            // Dims the screen behind the open + menu; a tap closes it.
            AnimatedBuilder(
              animation: _menu,
              builder: (context, _) => _menu.value == 0
                  ? const SizedBox.shrink()
                  : Positioned.fill(
                      child: GestureDetector(
                        onTap: _menu.reverse,
                        child: ColoredBox(
                          color: Colors.black
                              .withValues(alpha: 0.55 * _menu.value),
                        ),
                      ),
                    ),
            ),
          ],
        ),
        bottomNavigationBar: _PillNavBar(
          index: _index,
          menu: _menu,
          onChoose: _choose,
          onChanged: (i) {
            if (i == _plus) {
              _toggleMenu();
            } else {
              setState(() => _index = i);
            }
          },
        ),
      ),
    );
  }
}

/// The floating tab bar, filled with the team color like the web sidebar: a
/// pill with a thin lighter edge, and a darker capsule that slides to the
/// selected tab. The capsule is wider than a tab and nearly as tall as the
/// bar, so it reads as a capsule rather than a circle.
///
/// The + grows the bar itself up into a panel of choices ([menu] runs 0 to
/// 1): the tabs fade, the + turns into an x, and the choices come in above
/// it on the team color.
class _PillNavBar extends StatelessWidget {
  const _PillNavBar({
    required this.index,
    required this.onChanged,
    required this.menu,
    required this.onChoose,
  });

  final int index;
  final ValueChanged<int> onChanged;
  final Animation<double> menu;

  /// One of [newSessionChoices] was picked.
  final ValueChanged<String> onChoose;

  static const _items = <IconData>[
    Icons.home_outlined,
    Icons.groups,
    Icons.add,
    Icons.video_library_outlined,
    Icons.calendar_month_outlined,
  ];

  static const _labels = <String>[
    'Home',
    'Groups',
    'New session',
    'Sessions',
    'Calendar',
  ];

  static const _height = 64.0;
  static const _inset = 5.0;
  static const _choiceHeight = 60.0;
  static final _panelHeight = _choiceHeight * newSessionChoices.length + 12;

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    final fill = team.fill;
    // Same hue, stepped toward the text color: light teams get a darker
    // capsule, dark teams a lighter one. 8kount gold uses the design's own
    // selected tint, as the web sidebar does.
    final shade = team.ink == Colors.black ? Colors.black : Colors.white;
    final capsule =
        fill == kGold ? kGoldActive : Color.lerp(fill, shade, 0.22)!;
    final edge = Color.lerp(fill, Colors.white, 0.35)!;

    // On iPhones the bar sits down in the home-indicator area, 20 pt off the
    // bottom like the system's own floating tab bars, clear of the swipe-up
    // handle; elsewhere it stays above the system's gesture area.
    final systemBottom = MediaQuery.viewPaddingOf(context).bottom;
    final ios = Theme.of(context).platform == TargetPlatform.iOS;
    final bottom = ios && systemBottom > 0
        ? math.max(systemBottom - 14, 14.0)
        : systemBottom + 14;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, bottom),
      child: AnimatedBuilder(
        animation: menu,
        builder: (context, _) {
          final t = Curves.easeOutCubic.transform(menu.value);
          return Container(
            height: _height + _panelHeight * t,
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: fill,
              borderRadius:
                  BorderRadius.circular(lerpDouble(_height / 2, 26, t)!),
              border: Border.all(color: edge, width: 1.5),
            ),
            child: Stack(
              children: [
                // The choices, uncovered as the bar grows up over them.
                if (t > 0)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: _height - 6,
                    height: _panelHeight,
                    child: Opacity(
                      opacity: ((t - 0.3) / 0.7).clamp(0.0, 1.0),
                      child: IgnorePointer(
                        ignoring: t < 0.9,
                        child: _choices(team.ink),
                      ),
                    ),
                  ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: _height - 3,
                  child: _tabs(team, capsule, t),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _choices(Color ink) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
      child: Column(
        children: [
          // Nearest the + at the bottom.
          for (final c in newSessionChoices.reversed)
            SizedBox(
              height: _choiceHeight,
              child: Material(
                type: MaterialType.transparency,
                child: InkWell(
                  borderRadius: BorderRadius.circular(18),
                  onTap: () => onChoose(c.value),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    child: Row(
                      children: [
                        Icon(c.icon, color: ink, size: 26),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(c.title,
                                  style: TextStyle(
                                      color: ink,
                                      fontSize: 16,
                                      fontWeight: FontWeight.w700)),
                              Text(c.detail,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      color: ink.withValues(alpha: 0.7),
                                      fontSize: 13)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// The tabs, fading out (all but the +, which turns into an x) as the
  /// menu opens by [t].
  Widget _tabs(TeamAccent team, Color capsule, double t) {
    final fade = (1 - t * 2.5).clamp(0.0, 1.0);
    return LayoutBuilder(
      builder: (context, constraints) {
        // Tabs are inset from the ends just enough that the capsule, 20%
        // wider than a tab, stays centered on every icon including the
        // first and last.
        final slotWidth =
            (constraints.maxWidth - 2 * _inset) / (_items.length + 0.2);
        final sidePadding = _inset + 0.1 * slotWidth;
        final capsuleWidth = slotWidth * 1.2;
        final left = sidePadding + index * slotWidth - 0.1 * slotWidth;

        return Stack(
          children: [
            AnimatedPositioned(
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeOutCubic,
              left: left,
              top: _inset,
              bottom: _inset,
              width: capsuleWidth,
              child: Opacity(
                opacity: fade,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: capsule,
                    borderRadius: BorderRadius.circular(_height / 2),
                  ),
                ),
              ),
            ),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: sidePadding),
              child: Row(
                children: List.generate(_items.length, (i) {
                  final selected = i == index;
                  final plus = i == _plus;
                  return Expanded(
                    child: IgnorePointer(
                      // Only the x works while the menu is open.
                      ignoring: !plus && t > 0,
                      child: Semantics(
                        label: plus && t > 0.5 ? 'Close' : _labels[i],
                        selected: selected,
                        button: true,
                        excludeSemantics: true,
                        // No ripple: the sliding capsule is the feedback.
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () => onChanged(i),
                          child: Center(
                            // + is a button, not a tab: a filled circle.
                            child: plus
                                ? Container(
                                    width: 44,
                                    height: 44,
                                    decoration: BoxDecoration(
                                      color: team.ink,
                                      shape: BoxShape.circle,
                                    ),
                                    child: Transform.rotate(
                                      angle: t * math.pi / 4,
                                      child: Icon(Icons.add,
                                          size: 30, color: team.fill),
                                    ),
                                  )
                                : Opacity(
                                    opacity: fade,
                                    child: Icon(_items[i],
                                        size: 28, color: team.ink),
                                  ),
                          ),
                        ),
                      ),
                    ),
                  );
                }),
              ),
            ),
          ],
        );
      },
    );
  }
}

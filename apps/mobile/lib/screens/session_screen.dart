import 'dart:math' as math;
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'camera_screen.dart';
import 'controller_screen.dart';
import 'watch_screen.dart';

import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../keep_awake.dart';
import '../socket/sync_socket.dart';
import '../outbox/upload_queue.dart';
import '../widgets/frosted.dart';

/// Recording view for a session. Requests camera/mic only while mounted and
/// releases them on dispose (per the MVP permissions rule — no background
/// access). Connects the authenticated socket, joins the session room, and
/// goes straight to the camera, with the session's name and how many devices
/// are connected across the top. CameraScreen follows the synchronized
/// start/stop. A host or admin can turn this phone's camera off and run the
/// session from ControllerScreen instead.
class SessionScreen extends StatefulWidget {
  const SessionScreen({
    super.key,
    required this.serverUrl,
    required this.auth,
    required this.sessionId,
    this.sessionName,
  });

  final String serverUrl;
  final AuthService auth;
  final String sessionId;
  final String? sessionName;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  SyncSocket? _socket;
  final List<StreamSubscription> _subs = [];

  bool _permissionsGranted = false;
  bool _initialized = false;
  String? _error;

  /// The connection dropped and is retrying; the camera stays up.
  bool _reconnecting = false;
  List<SessionMember> _members = [];
  bool _canControl = false;

  /// This user started the session: leaving ends it for everyone.
  bool _isHost = false;

  /// Leaving (or ending) after the back arrow, so the session closing
  /// isn't reported back to this phone as someone else's doing.
  bool _leaving = false;

  /// Running the session without recording on this phone.
  bool _controllerOnly = false;

  /// A take is scheduled or running; the camera can't be switched mid-take.
  bool _takeRunning = false;

  /// The running take's number, and its shared start on this phone's
  /// clock, for the REC chip's timer.
  int? _takeNumber;
  int? _takeStartAtMs;
  Timer? _resumeUploads;
  bool _switching = false;

  @override
  void initState() {
    super.initState();
    KeepAwake.acquire();
    _init();
  }

  Future<void> _init() async {
    await _requestPermissions();

    final socket = SyncSocket(
      widget.serverUrl,
      cookie: widget.auth.api.cookie,
    );
    _socket = socket;

    _subs.add(socket.members.listen((m) => setState(() => _members = m)));
    _subs.add(socket.recordingStart.listen((command) {
      // No uploads start while a take runs: on a slow network they'd hold
      // up the start and stop messages (see UploadQueue).
      UploadQueue.instance?.pause('take');
      if (!mounted) return;
      setState(() {
        _takeRunning = true;
        _takeNumber = command.recordingNumber;
        _takeStartAtMs = command.localStartAtEpochMs;
      });
      // Watching when the next take starts: back to the camera, which is
      // already recording underneath.
      final here = _sessionRoute;
      if (_watching && here != null) {
        Navigator.of(context).popUntil((route) => route == here);
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('A new take started.')));
      }
    }));
    _subs.add(socket.recordingStop.listen((command) {
      // Uploads go again once every camera has really stopped.
      final now = DateTime.now().millisecondsSinceEpoch;
      final stopAt = command.localStopAtEpochMs ?? now;
      _resumeUploads?.cancel();
      _resumeUploads = Timer(
        Duration(milliseconds: math.max(0, stopAt - now) + 1500),
        () => UploadQueue.instance?.resume('take'),
      );
      if (mounted) setState(() => _takeRunning = false);
    }));
    // Whoever runs the session hears when a camera drops out of a take, so
    // they can redo it.
    _subs.add(socket.cameraDropped.listen((member) {
      if (!mounted || !_canControl) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('${member.displayName} left the app, so their camera '
            'stopped recording this take.'),
        duration: const Duration(seconds: 6),
      ));
    }));
    _subs.add(socket.errors.listen((message) {
      if (mounted) setState(() => _error = message);
    }));
    _subs.add(socket.connection.listen((connected) {
      if (mounted) setState(() => _reconnecting = !connected);
    }));
    _subs.add(socket.sessionClosed.listen((_) {
      if (!mounted || _leaving) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('The host ended the session.')),
      );
      Navigator.of(context).popUntil((route) => route.isFirst);
    }));

    try {
      await socket.connect();
      final result = await socket.joinSession(widget.sessionId);
      if (!mounted) return;
      setState(() {
        _initialized = true;
        _canControl = result.canControl;
        _isHost = result.createdBy != null &&
            result.createdBy == widget.auth.user?.id;
        if (!result.ok) _error = result.error;
      });
    } on SyncSocketException catch (e) {
      if (!mounted) return;
      setState(() {
        _initialized = true;
        _error = e.message;
      });
    }
  }

  Future<void> _setControllerOnly(bool controllerOnly) async {
    final socket = _socket;
    if (socket == null || _switching || _takeRunning) return;
    setState(() => _switching = true);
    final result =
        await socket.joinSession(widget.sessionId, camera: !controllerOnly);
    if (!mounted) return;
    setState(() {
      _switching = false;
      if (result.ok) _controllerOnly = controllerOnly;
    });
    if (!result.ok) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(result.error ?? "Couldn't switch the camera.")));
    }
  }

  /// The session's recordings, watched without leaving it: the camera (or
  /// the controls) stays up underneath and comes back when the next take
  /// starts.
  bool _watching = false;
  ModalRoute<dynamic>? _sessionRoute;

  Future<void> _watchRecordings() async {
    // Not mid-take: the take has to finish (and upload) first.
    if (_takeRunning) return;
    _sessionRoute = ModalRoute.of(context);
    setState(() => _watching = true);
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => WatchScreen(
        auth: widget.auth,
        session: RecordingSession(
          id: widget.sessionId,
          name: widget.sessionName ?? 'Session ${widget.sessionId}',
          status: 'active',
          activeMemberCount: _members.length,
          isJoined: true,
        ),
      ),
    ));
    if (mounted) setState(() => _watching = false);
  }

  /// The back arrow leaves the session, after asking: the host's leaving
  /// ends it for everyone, anyone else just drops out (and the device
  /// count updates on every phone).
  Future<void> _confirmLeave() async {
    if (_leaving) return;
    final host = _isHost;
    final midTake = _takeRunning;
    final leave = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(host ? 'End the session?' : 'Leave the session?'),
        content: Text([
          if (host)
            "You're the host, so leaving closes the session for everyone. "
                "Every camera stops and they can't record more takes."
          else
            "You'll stop being a camera in this session. You can join "
                "again with its code.",
          if (midTake) 'A take is recording; it stops on this phone now.',
        ].join('\n\n')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Stay'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: TextButton.styleFrom(foregroundColor: Colors.redAccent),
            child: Text(host ? 'End for everyone' : 'Leave'),
          ),
        ],
      ),
    );
    if (leave != true || !mounted) return;
    setState(() => _leaving = true);
    final api = RecordingsApi(widget.auth.api);
    try {
      if (host) {
        await api.endSession(widget.sessionId);
      } else {
        await api.leaveSession(widget.sessionId);
      }
    } catch (e) {
      if (host && mounted) {
        // Not ended: say so and stay, rather than leave everyone in a
        // session with no host.
        setState(() => _leaving = false);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text("Couldn't end the session. Check the connection "
                'and try again.')));
        return;
      }
      // Leaving still drops this phone out of the live room (dispose).
    }
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _requestPermissions() async {
    final statuses = await [Permission.camera, Permission.microphone].request();
    setState(() {
      _permissionsGranted = statuses.values.every((s) => s.isGranted);
    });
  }

  @override
  void dispose() {
    KeepAwake.release();
    _resumeUploads?.cancel();
    UploadQueue.instance?.resume('take');
    for (final s in _subs) {
      s.cancel();
    }

    _socket?.leaveSession();
    _socket?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final joined = _initialized && _error == null;
    return PopScope(
      // Not in the session (still joining, or couldn't): just go back.
      canPop: !joined || _leaving,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _confirmLeave();
      },
      child: _buildScreen(context),
    );
  }

  Widget _buildScreen(BuildContext context) {
    if (!_initialized) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    final socket = _socket!;
    final joined = _error == null;

    final topBar = _SessionTopBar(
      name: widget.sessionName ?? 'Session ${widget.sessionId}',
      code: widget.sessionId,
      members: _members,
      clockSynced: socket.clockSynced,
      reconnecting: _reconnecting,
      recording: _takeRunning,
      takeNumber: _takeNumber,
      takeStartAtMs: _takeStartAtMs,
      myId: widget.auth.user?.id,
    );

    if (joined && _controllerOnly) {
      return ControllerScreen(
        socket: socket,
        sessionId: widget.sessionId,
        members: _members,
        topBar: topBar,
        onUseCamera: _switching ? null : () => _setControllerOnly(false),
        onWatch: _watchRecordings,
      );
    }

    if (joined && _permissionsGranted) {
      return CameraScreen(
        socket: socket,
        sessionId: widget.sessionId,
        recordings: RecordingsApi(widget.auth.api),
        canControl: _canControl,
        topBar: topBar,
        onWatch: _watchRecordings,
        // Hosts and admins can turn their camera off and just run the take.
        onControlOnly:
            _canControl && !_switching ? () => _setControllerOnly(true) : null,
      );
    }

    // Couldn't join, or camera/microphone access was refused.
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Text(widget.sessionName ?? 'Session ${widget.sessionId}'),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error ??
                'Camera and microphone permission are required to record.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.redAccent, height: 1.4),
          ),
        ),
      ),
    );
  }
}

/// The bar across the top of a session's camera: back, the session's name,
/// and how many devices are connected (a hint when the clock isn't synced).
/// While a take runs, the device count grows to say it's recording.
/// The recordings and the camera on/off switch sit beside the shutter.
class _SessionTopBar extends StatelessWidget {
  const _SessionTopBar({
    required this.name,
    required this.code,
    required this.members,
    required this.clockSynced,
    this.reconnecting = false,
    this.recording = false,
    this.takeNumber,
    this.takeStartAtMs,
    this.myId,
  });

  final String name;

  /// The session's code, so others can join with it.
  final String code;
  final List<SessionMember> members;
  final bool clockSynced;

  /// The connection dropped; Start and Stop won't reach this phone until
  /// it's back.
  final bool reconnecting;

  final bool recording;
  final int? takeNumber;
  final int? takeStartAtMs;

  /// This phone's user, whose own connection shows in the pill.
  final int? myId;

  @override
  Widget build(BuildContext context) {
    // Back, the name and the connection on top; the device count centred
    // under them.
    final left = <Widget>[
      // A frosted circle behind it rather than a shadow: Flutter draws an
      // icon's shadow out of place (beside it, or behind the name).
      Frosted(
        radius: 24,
        child: IconButton(
          onPressed: () => Navigator.of(context).maybePop(),
          icon: const Icon(Icons.arrow_back, color: Colors.white, size: 22),
          tooltip: 'Leave session',
        ),
      ),
      const SizedBox(width: 6),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
            Text(
              'Code $code',
              style: const TextStyle(color: Colors.white70, fontSize: 12),
            ),
            if (!reconnecting && !clockSynced)
              const Text(
                'Clock not synced; recordings may drift.',
                style: TextStyle(color: Colors.orangeAccent, fontSize: 12),
              ),
          ],
        ),
      ),
    ];
    final devices = _DevicesPill(
      members: members,
      myId: myId,
      reconnecting: reconnecting,
    );
    // Top right, only while a take runs.
    final rec = recording
        ? _RecChip(number: takeNumber, startAtMs: takeStartAtMs)
        : const SizedBox.shrink();

    if (MediaQuery.orientationOf(context) == Orientation.landscape) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(4, 2, 12, 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Row(children: left)),
            const SizedBox(width: 12),
            // Top-aligned and nudged down to line up with the name, so
            // opened it grows down over the camera without moving the rest.
            Padding(padding: const EdgeInsets.only(top: 6), child: devices),
            const SizedBox(width: 12),
            // As wide as the left, so the pill stays centred.
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Align(alignment: Alignment.topRight, child: rec),
              ),
            ),
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [...left, const SizedBox(width: 8), rec]),
          const SizedBox(height: 4),
          devices,
        ],
      ),
    );
  }
}

/// How many devices are connected; tapped, it grows into the list of who
/// they are (tap again, or anywhere else, to close). It leads with this
/// phone's own signal, and says Reconnecting when the connection drops.
class _DevicesPill extends StatefulWidget {
  const _DevicesPill({
    required this.members,
    this.myId,
    this.reconnecting = false,
  });

  final List<SessionMember> members;
  final int? myId;

  /// This phone lost its connection; the pill says so until it's back.
  final bool reconnecting;

  @override
  State<_DevicesPill> createState() => _DevicesPillState();
}

class _DevicesPillState extends State<_DevicesPill> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final members = widget.members;
    final count =
        '${members.length} ${members.length == 1 ? 'device' : 'devices'}';
    // Opening, the list unfolds from under the pill and fades in while the
    // pill widens and rounds out with it, all on one curve; closing plays
    // it back.
    const ease = Duration(milliseconds: 280);
    const curve = Curves.easeOutCubic;
    return TapRegion(
      onTapOutside: (_) {
        if (_open) setState(() => _open = false);
      },
      // Frosted: the camera behind is blurred, so the list reads over a
      // bright picture with the pill's own light tint, open or closed. The
      // corners are one size throughout (closed, the pill is shorter than
      // them, so its ends stay round).
      child: Frosted(
        tint: Colors.transparent,
        child: AnimatedContainer(
          duration: ease,
          curve: curve,
          // Open, only as wide as the names need (within limits).
          constraints: const BoxConstraints(maxWidth: 300),
          decoration: BoxDecoration(
            color: Colors.black54,
            borderRadius: BorderRadius.circular(18),
            border:
                Border.all(color: _open ? Colors.white12 : Colors.transparent),
          ),
          child: IntrinsicWidth(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  button: true,
                  label: "Who's connected",
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => setState(() => _open = !_open),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 6),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // This phone's own signal (everyone's is in the
                          // list).
                          _SignalIcon(
                            roundTripMs: members
                                .where((m) => m.id == widget.myId)
                                .firstOrNull
                                ?.roundTripMs,
                            offline: widget.reconnecting,
                            size: 16,
                          ),
                          const SizedBox(width: 8),
                          Text(
                            widget.reconnecting
                                ? 'Reconnecting…'
                                : '$count connected',
                            style: TextStyle(
                                color: widget.reconnecting
                                    ? Colors.redAccent
                                    : Colors.white,
                                fontWeight: FontWeight.w600),
                          ),
                          const SizedBox(width: 2),
                          AnimatedRotation(
                            turns: _open ? 0.5 : 0,
                            duration: ease,
                            curve: curve,
                            child: const Icon(Icons.arrow_drop_down,
                                size: 18, color: Colors.white70),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                // Always there, folded to nothing while closed.
                AnimatedAlign(
                  duration: ease,
                  curve: curve,
                  alignment: Alignment.topCenter,
                  widthFactor: _open ? 1 : 0,
                  heightFactor: _open ? 1 : 0,
                  child: AnimatedOpacity(
                    duration: ease,
                    curve: _open ? const Interval(0.25, 1) : Curves.easeOut,
                    opacity: _open ? 1 : 0,
                    child: Padding(
                      // Lined up with the pill's own row above.
                      padding: const EdgeInsets.fromLTRB(12, 2, 14, 10),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (final member in members)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 5),
                              child: _MemberRow(
                                  member: member,
                                  isMe: member.id == widget.myId),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// How good a connection is, from how long it takes to answer the server.
enum _Signal { good, weak, offline, unknown }

/// Above this a round trip counts as weak: start and stop may arrive late
/// and uploads will be slow.
const _weakAboveMs = 600;

_Signal _signalOf(int? roundTripMs, {bool offline = false}) {
  if (offline) return _Signal.offline;
  if (roundTripMs == null) return _Signal.unknown;
  return roundTripMs > _weakAboveMs ? _Signal.weak : _Signal.good;
}

(IconData, Color, String) _signalLook(_Signal signal) => switch (signal) {
      _Signal.good => (
          Icons.signal_cellular_alt,
          const Color(0xFF4ADE80),
          'Good'
        ),
      _Signal.weak => (Icons.network_cell, Colors.orangeAccent, 'Weak'),
      _Signal.offline => (
          Icons.signal_cellular_connected_no_internet_0_bar,
          Colors.redAccent,
          'Offline'
        ),
      _Signal.unknown => (
          Icons.signal_cellular_alt,
          Colors.white38,
          'Checking'
        ),
    };

/// One person in the who's-connected list: how good their connection is,
/// their name ("(you)" on this phone's own), and whether their camera is
/// recording or they're just running the session.
class _MemberRow extends StatelessWidget {
  const _MemberRow({required this.member, this.isMe = false});

  final SessionMember member;
  final bool isMe;

  @override
  Widget build(BuildContext context) {
    final name = member.displayName.trim();
    // The signal first, in a column under the pill's own.
    return Row(
      children: [
        _SignalIcon(roundTripMs: member.roundTripMs, size: 16),
        const SizedBox(width: 8),
        Expanded(
          child: Text.rich(
            TextSpan(text: name, children: [
              if (isMe)
                const TextSpan(
                  text: ' (you)',
                  style: TextStyle(
                      color: Colors.white54, fontWeight: FontWeight.w400),
                ),
            ]),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
                color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
        const SizedBox(width: 10),
        if (member.camera)
          const Icon(Icons.videocam, size: 18, color: Colors.white70)
        else
          const Text('Controlling',
              style: TextStyle(color: Colors.white54, fontSize: 12)),
      ],
    );
  }
}

/// Someone's connection: green, orange (weak), red (offline) or grey (not
/// timed yet), with the round trip on a long press. In the list for
/// everyone, and in the pill for this phone.
class _SignalIcon extends StatelessWidget {
  const _SignalIcon({this.roundTripMs, this.offline = false, this.size = 18});

  final int? roundTripMs;
  final bool offline;
  final double size;

  @override
  Widget build(BuildContext context) {
    final (icon, color, label) =
        _signalLook(_signalOf(roundTripMs, offline: offline));
    return Tooltip(
      message: roundTripMs == null
          ? 'Checking connection'
          : '$label · $roundTripMs ms',
      child: Icon(icon, size: size, color: color, semanticLabel: label),
    );
  }
}

/// Top right while a take runs: a solid red chip with REC and how long it's
/// been recording ("Starting" in the moment before its shared start).
class _RecChip extends StatefulWidget {
  const _RecChip({this.number, this.startAtMs});

  final int? number;
  final int? startAtMs;

  @override
  State<_RecChip> createState() => _RecChipState();
}

class _RecChipState extends State<_RecChip> {
  late final Timer _tick =
      Timer.periodic(const Duration(milliseconds: 250), (_) => setState(() {}));

  @override
  void initState() {
    super.initState();
    _tick;
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final start = widget.startAtMs;
    final elapsed =
        start == null ? null : DateTime.now().millisecondsSinceEpoch - start;
    final String time;
    if (elapsed == null || elapsed < 0) {
      time = 'Starting';
    } else {
      final seconds = elapsed ~/ 1000;
      time = '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
    }
    return Semantics(
      label: widget.number == null
          ? 'Recording, $time'
          : 'Recording ${widget.number}, $time',
      // Solid red: it should catch the eye, unlike the controls around it.
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: const Color(0xFFE5484D),
          borderRadius: BorderRadius.circular(18),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.circle, size: 9, color: Colors.white),
              const SizedBox(width: 6),
              const Text('REC',
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.5)),
              const SizedBox(width: 6),
              Text(time,
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      fontFeatures: [FontFeature.tabularFigures()])),
            ],
          ),
        ),
      ),
    );
  }
}

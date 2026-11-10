import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'dart:async';
import 'dart:math' as math;
import '../api/recordings_api.dart';
import '../keep_awake.dart';
import '../recording/first_frame.dart';
import '../outbox/upload_queue.dart';
import '../outbox/upload_status.dart';
import '../recording_quality.dart';
import '../notifications/take_alerts.dart';
import '../socket/sync_socket.dart';
import '../widgets/shutter_side_button.dart';

/// Camera view. Works in two modes:
///
///  * **Session mode** — pass a [socket]; recording starts and stops on the
///    admin's synchronized broadcast, in step with every other device.
///  * **Solo mode** — omit [socket]; the on-screen buttons are the only
///    control. Useful when no other cameras are connected.
class CameraScreen extends StatefulWidget {
  const CameraScreen({
    super.key,
    this.socket,
    this.sessionId,
    this.recordings,
    this.embedded = false,
    this.canControl = false,
    this.topBar,
    this.onWatch,
    this.onControlOnly,
  });

  final SyncSocket? socket;
  final String? sessionId;

  /// Where finished recordings are uploaded. Only used in session mode: a
  /// video is uploaded when both [sessionId] and this are set.
  final RecordingsApi? recordings;

  /// True when hosted inside a tab (no Scaffold/AppBar of its own, and room
  /// left at the bottom for the floating dock).
  final bool embedded;

  /// In a session, whether this user's shutter starts and stops the take for
  /// every device (the session's creator, or a group admin or owner). Other
  /// members' cameras just follow the host.
  final bool canControl;

  /// Shown across the top of the full-screen camera instead of an app bar,
  /// like the session's name and how many devices are connected.
  final Widget? topBar;

  /// In a session, opens its recordings from a button beside the shutter
  /// (greyed out while a take runs).
  final VoidCallback? onWatch;

  /// For hosts and admins: turns this phone's camera off to just run the
  /// take, from a button on the shutter's other side.
  final VoidCallback? onControlOnly;

  bool get isSolo => socket == null;

  @override
  State<CameraScreen> createState() => _CameraScreenState();
}

/// How long before a take's shared start the camera is told to record.
/// Phones only really start a beat after they're asked (0.9 s on an Android
/// in testing, 0.1-0.2 s on iPhones), so asking early has them rolling by
/// the start. The extra second at the front costs nothing: playback lines
/// the angles up by each camera's first frame.
const kCameraLeadMs = 1000;

class _CameraScreenState extends State<CameraScreen> {
  final List<StreamSubscription> _subs = [];
  Timer? _pendingStart;

  /// The stop is in, and the cameras keep rolling until its time.
  Timer? _pendingStop;

  /// The take this phone left the app during. It carries on without this
  /// camera; rejoining doesn't fall back into it (the clip from before
  /// leaving is what's kept), only the next take.
  int? _droppedTakeStartAt;

  late final AppLifecycleListener _lifecycle;
  CameraController? _cameraController;
  bool _cameraReady = false;
  bool _recording = false;
  bool _permissionDenied = false;

  /// Server-clock start of the recording in progress. Every device in the
  /// session shares this value, and the server groups uploads by it.
  int? _plannedStartAtEpochMs;

  /// Server-clock time the camera really began, which is a moment after the
  /// planned start. Playback shifts this angle by the difference.
  int? _actualStartAtEpochMs;

  /// What [_actualStartAtEpochMs] is: 'frame' when it's the first frame's
  /// capture time, 'call' when it's when the camera was asked to start.
  String? _startClock;

  /// "Recording N" for the current session recording, when the server said.
  int? _recordingNumber;

  bool get _uploadsEnabled =>
      widget.sessionId != null && widget.recordings != null;

  @override
  void initState() {
    super.initState();
    KeepAwake.acquire();
    _lifecycle = AppLifecycleListener(
      onInactive: _onLeftScreen,
      onResume: _onBackOnScreen,
    );
    _initialize();
  }

  Future<void> _initialize() async {
    // Solo mode can be reached without going through SessionScreen, so ask
    // here too. Already-granted permissions return immediately.
    final statuses = await [Permission.camera, Permission.microphone].request();
    if (!statuses.values.every((s) => s.isGranted)) {
      if (mounted) setState(() => _permissionDenied = true);
      return;
    }

    await _initializeCamera();

    // Only a session-mode screen follows the synchronized broadcast.
    final socket = widget.socket;
    if (socket != null) {
      _subs.add(socket.recordingStart.listen(_scheduleStart));
      _subs.add(socket.recordingStop.listen(_scheduleStop));
    }
  }

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();

      if (cameras.isEmpty) {
        debugPrint('No cameras available.');
        return;
      }

      _cameraController = CameraController(
        cameras.first,
        // 1080p. `medium` is only 480p, which looks pixelated full-screen and
        // is too soft to review formations or spacing. Drop to `high` (720p)
        // if upload size or bandwidth becomes the bottleneck.
        ResolutionPreset.veryHigh,
        enableAudio: true,
        // Capped so uploads stay manageable on slow Wi-Fi (see
        // recording_quality.dart).
        videoBitrate: videoBitrateFor(defaultTargetPlatform),
        audioBitrate: kAudioBitrate,
      );

      await _cameraController!.initialize();
      // Sets up recording ahead of time on iPhone, so a take starts sooner.
      await _cameraController!.prepareForVideoRecording().catchError((_) {});

      if (!mounted) return;

      setState(() {
        _cameraReady = true;
      });
    } catch (e) {
      debugPrint('Error initializing camera: $e');
    }
  }

  /// A take keeps one orientation: the way the phone is held as it begins.
  /// The saved video is fixed to it, and so is the screen (upright stays
  /// upright; sideways can still flip end for end), so a bump mid-take
  /// can't swing the preview around. Unlocked when the take stops.
  bool _orientationLocked = false;

  Future<void> _lockOrientation() async {
    final controller = _cameraController;
    if (_orientationLocked || controller == null) return;
    _orientationLocked = true;
    final portrait = MediaQuery.of(context).orientation == Orientation.portrait;
    try {
      await controller.lockCaptureOrientation();
    } catch (e) {
      debugPrint('Could not lock capture orientation: $e');
    }
    await SystemChrome.setPreferredOrientations(portrait
        ? const [DeviceOrientation.portraitUp]
        : const [
            DeviceOrientation.landscapeLeft,
            DeviceOrientation.landscapeRight
          ]);
    if (mounted) setState(() {});
  }

  Future<void> _unlockOrientation() async {
    if (!_orientationLocked) return;
    _orientationLocked = false;
    try {
      await _cameraController?.unlockCaptureOrientation();
    } catch (_) {}
    await SystemChrome.setPreferredOrientations(const []);
    if (mounted) setState(() {});
  }

  void _scheduleStart(RecordingStartCommand command) {
    if (command.serverStartAtEpochMs == _droppedTakeStartAt) return;
    unawaited(_lockOrientation());
    _plannedStartAtEpochMs = command.serverStartAtEpochMs;
    _plannedLocalStartAtEpochMs = command.localStartAtEpochMs;
    _recordingNumber = command.recordingNumber;
    _pendingStop?.cancel();

    final delay = command.localStartAtEpochMs -
        kCameraLeadMs -
        DateTime.now().millisecondsSinceEpoch;

    _pendingStart?.cancel();

    _pendingStart = Timer(
      Duration(milliseconds: delay < 0 ? 0 : delay),
      _startRecording,
    ); //Timer
  }

  /// The take's shared start on this device's clock.
  int? _plannedLocalStartAtEpochMs;

  /// Keeps recording until the stop's time. A take stopped before its shared start is
  /// cancelled: anything already recorded for it (the camera starts early)
  /// is thrown away.
  void _scheduleStop(RecordingStopCommand command) {
    _pendingStart?.cancel();
    final now = DateTime.now().millisecondsSinceEpoch;
    final startAt = _plannedLocalStartAtEpochMs;
    final stopAt = command.localStopAtEpochMs;
    final cancelled = command.localEndBeepAtEpochMs == null &&
        stopAt != null &&
        startAt != null &&
        stopAt < startAt;

    if (!(_cameraController?.value.isRecordingVideo ?? false)) {
      // Stopped before it started: nothing to save, just unlock.
      _unlockOrientation();
      _plannedStartAtEpochMs = null;
      return;
    }
    _pendingStop?.cancel();
    _pendingStop = Timer(
      Duration(milliseconds: stopAt == null ? 0 : math.max(0, stopAt - now)),
      () => _stopRecording(discard: cancelled),
    );
    setState(() {});
  }

  /// The app is leaving the screen (home button, app switcher, a call). The
  /// phone takes the camera away from a background app, so a take in
  /// progress is stopped here while it can still be saved, uploaded and
  /// lined up; the rest of the room is told, and the camera is let go until
  /// the app is back, as the camera plugin requires.
  Future<void> _onLeftScreen() async {
    final controller = _cameraController;
    if (controller == null) return;
    final takeStartAt = _plannedStartAtEpochMs;
    final midTake = !widget.isSolo &&
        takeStartAt != null &&
        (controller.value.isRecordingVideo ||
            (_pendingStart?.isActive ?? false));
    _pendingStart?.cancel();
    _pendingStop?.cancel();
    if (midTake) {
      _droppedTakeStartAt = takeStartAt;
      widget.socket?.reportCameraDropped();
      unawaited(TakeAlerts.recordingStopped());
    }
    if (controller.value.isRecordingVideo) await _stopRecording();
    if (!mounted || _cameraController != controller) return;
    _cameraController = null;
    setState(() => _cameraReady = false);
    await controller.dispose();
  }

  Future<void> _onBackOnScreen() async {
    if (_cameraController == null && !_permissionDenied) {
      await _initializeCamera();
    }
    if (!mounted || _droppedTakeStartAt == null) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
      content:
          Text('You left the app, so your recording stopped. What was recorded '
              'is saved, and you\'ll join the next take.'),
      duration: Duration(seconds: 6),
    ));
  }

  Future<void> _startRecording() async {
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      debugPrint('Camera not ready');
      return;
    }

    if (_cameraController!.value.isRecordingVideo) {
      debugPrint('Already recording');
      return;
    }

    // A manual shutter tap in session mode has no shared start command, so
    // stamp it with the server-clock "now" and it uploads on its own.
    final socket = widget.socket;
    if (_plannedStartAtEpochMs == null && socket != null) {
      _plannedStartAtEpochMs =
          socket.localToServer(DateTime.now().millisecondsSinceEpoch);
    }

    if (!_orientationLocked) await _lockOrientation();
    try {
      _actualStartAtEpochMs = null;
      await _cameraController!.startVideoRecording();
      // Taken as soon as the camera says it is recording; the phone's own
      // start-up delay is what this measures.
      if (socket != null) {
        _actualStartAtEpochMs =
            socket.localToServer(DateTime.now().millisecondsSinceEpoch);
        _startClock = 'call';
        // Better still: when the first frame was really captured, which the
        // camera knows a moment later (see first_frame.dart).
        final take = _plannedStartAtEpochMs;
        unawaited(firstFrameAtEpochMs().then((local) {
          if (local == null || take == null || _plannedStartAtEpochMs != take) {
            return;
          }
          _actualStartAtEpochMs = socket.localToServer(local);
          _startClock = 'frame';
        }));
      }

      setState(() {
        _recording = true;
      });

      debugPrint('Recording started');
    } catch (e) {
      debugPrint('Start recording error: $e');
      await _unlockOrientation();
    }
  }

  /// Stops and uploads the take. [discard] drops it instead: a take
  /// cancelled before its start, that this camera began early for.
  Future<void> _stopRecording({bool discard = false}) async {
    _pendingStop?.cancel();
    if (_cameraController == null ||
        !_cameraController!.value.isRecordingVideo) {
      debugPrint('Not recording');
      return;
    }

    final startedAt = _plannedStartAtEpochMs;
    final actualStartedAt = _actualStartAtEpochMs;
    final startClock = _startClock;
    _startClock = null;
    _plannedStartAtEpochMs = null;
    _plannedLocalStartAtEpochMs = null;
    _actualStartAtEpochMs = null;
    _recordingNumber = null;

    try {
      final file = await _cameraController!.stopVideoRecording();

      setState(() => _recording = false);
      await _unlockOrientation();

      debugPrint('Video saved: ${file.path}');

      if (_uploadsEnabled && startedAt != null && !discard) {
        // Into the phone's outbox, which sends it as soon as it can and
        // keeps it until it's through (see UploadQueue). Not awaited:
        // leaving the app stops a take, and the camera is let go right
        // after.
        final queue = UploadQueue.instance ??= UploadQueue(widget.recordings!);
        unawaited(queue.add(
          sessionId: widget.sessionId!,
          startedAtMs: startedAt,
          actualStartedAtMs: actualStartedAt,
          startClock: startClock,
          sourcePath: file.path,
          filename: file.name,
        ));
      }
    } catch (e) {
      debugPrint('Stop recording error: $e');
      await _unlockOrientation();
    }
  }

  @override
  void dispose() {
    KeepAwake.release();
    _lifecycle.dispose();
    _pendingStop?.cancel();
    if (_orientationLocked) SystemChrome.setPreferredOrientations(const []);
    _pendingStart?.cancel();

    for (final sub in _subs) {
      sub.cancel();
    }

    _cameraController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.embedded) {
      return _body();
    }

    final topBar = widget.topBar;
    if (topBar != null) {
      return Scaffold(
        backgroundColor: Colors.black,
        body: Stack(
          fit: StackFit.expand,
          children: [
            _body(),
            // Tinted from the top down, fading out below the bar, so its
            // text reads over any picture without shadows of its own. A
            // fixed height: the devices pill opening over it doesn't stretch
            // it.
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: MediaQuery.paddingOf(context).top + _topBarSpace + 56,
              child: const IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      // Eased out over a long way, so there's no edge to see.
                      colors: [
                        Color(0x73000000),
                        Color(0x47000000),
                        Color(0x1F000000),
                        Color(0x08000000),
                        Color(0x00000000),
                      ],
                      stops: [0, 0.35, 0.65, 0.85, 1],
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: SafeArea(bottom: false, child: topBar),
            ),
          ],
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.isSolo ? 'Solo recording' : 'Camera'),
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_permissionDenied) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Camera and microphone permission are required to record.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.redAccent),
          ),
        ),
      );
    }

    if (!_cameraReady || _cameraController == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return Stack(
      fit: StackFit.expand,
      children: [
        _preview(),

        // Recording indicator, kept clear of the status bar. In a session
        // the top bar's pill says it, so only the rotation lock shows here.
        if (_recording && (widget.topBar == null || _orientationLocked))
          Positioned(
            top: 60 + _topBarSpace,
            left: 0,
            right: 0,
            child: Center(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (widget.topBar == null)
                    Text(
                      _recordingNumber == null
                          ? '● REC'
                          : '● REC  ·  Recording ${_recordingNumber!.toString().padLeft(3, '0')}',
                      style: const TextStyle(
                        color: Colors.redAccent,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 1,
                      ),
                    ),
                  if (_orientationLocked) ...[
                    if (widget.topBar == null) const SizedBox(width: 8),
                    const Icon(Icons.screen_lock_rotation,
                        size: 16,
                        color: Colors.white70,
                        semanticLabel: 'Rotation locked for this take'),
                  ],
                ],
              ),
            ),
          ),

        // Shutter: bottom-centre in portrait, right-hand side and vertically
        // centred in landscape — where your thumb sits holding the phone
        // sideways, and clear of the floating dock either way. What the
        // phone's outbox is doing (sending, waiting, done) sits just above
        // it in portrait, and along the bottom in landscape.
        if (MediaQuery.of(context).orientation == Orientation.landscape) ...[
          Positioned(
            top: 0,
            bottom: 0,
            right: 32,
            child: Center(child: _shutter()),
          ),
          if (_uploadsEnabled)
            Positioned(
              left: 16,
              right: 16,
              bottom: 20,
              child: Center(
                child: UploadStatusBanner(
                  queue: UploadQueue.instance ??=
                      UploadQueue(widget.recordings!),
                ),
              ),
            ),
        ] else
          Positioned(
            left: 16,
            right: 16,
            bottom: widget.embedded ? 118 : 40,
            child: Center(child: _withUploads(_shutter())),
          ),
      ],
    );
  }

  Widget _withUploads(Widget shutter) {
    if (!_uploadsEnabled) return shutter;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        UploadStatusBanner(
          queue: UploadQueue.instance ??= UploadQueue(widget.recordings!),
        ),
        const SizedBox(height: 14),
        shutter,
      ],
    );
  }

  /// Room left under [CameraScreen.topBar] so the camera's own labels
  /// don't sit beneath it.
  double get _topBarSpace => widget.topBar == null
      ? 0
      : MediaQuery.orientationOf(context) == Orientation.landscape
          ? 56
          : 96;

  /// Fills the screen without distorting, in either orientation.
  ///
  /// previewSize is always reported landscape-first (e.g. 1920x1080), so in
  /// portrait the dimensions have to be swapped before covering the viewport
  /// — otherwise the image renders squashed.
  Widget _preview() {
    final size = _cameraController!.value.previewSize!;
    final isPortrait =
        MediaQuery.of(context).orientation == Orientation.portrait;

    return ClipRect(
      child: FittedBox(
        fit: BoxFit.cover,
        child: SizedBox(
          width: isPortrait ? size.height : size.width,
          height: isPortrait ? size.width : size.height,
          child: CameraPreview(_cameraController!),
        ),
      ),
    );
  }

  /// A start or stop request is on its way to the server.
  bool _requesting = false;

  /// The host's shutter starts or stops the take on every device; the server
  /// then sends the shared start (or stop) back here like everywhere else.
  Future<void> _hostShutter() async {
    final socket = widget.socket;
    final sessionId = widget.sessionId;
    if (socket == null || sessionId == null || _requesting) return;
    // Already stopping: the cameras are just rolling on to the stop's time.
    if (_pendingStop?.isActive ?? false) return;
    final stopping = _recording || (_pendingStart?.isActive ?? false);
    setState(() => _requesting = true);
    final error = stopping
        ? await socket.requestStop(sessionId)
        : await socket.requestStart(sessionId);
    if (!mounted) return;
    setState(() => _requesting = false);
    if (error != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
    }
  }

  Widget _shutter() {
    // In a session only the host's shutter does anything; everyone else's
    // camera follows the host's start and stop, and a tap on their greyed
    // out shutter says why.
    if (!widget.isSolo && !widget.canControl) {
      return _withSideButtons(GestureDetector(
        onTap: _explainHostOnly,
        child: Opacity(opacity: 0.35, child: _shutterButton()),
      ));
    }
    return _withSideButtons(GestureDetector(
      onTap: widget.isSolo
          ? (_recording ? _stopRecording : _startRecording)
          : _hostShutter,
      child: _shutterButton(),
    ));
  }

  void _explainHostOnly() {
    final action = _recording ? 'stop' : 'start';
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text("You can't $action recording"),
        content: const Text(
            "Only the session's host or a group admin can start and stop "
            'recording. Your camera records when they do.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  /// [shutter] with the recordings on its left and, for hosts, the camera
  /// off switch on its right (above and below it in landscape). An empty
  /// slot stands in for a missing button so the shutter stays centred.
  Widget _withSideButtons(Widget shutter) {
    final onWatch = widget.onWatch;
    if (onWatch == null) return shutter;
    final busy = _recording || (_pendingStart?.isActive ?? false);
    final onControlOnly = widget.onControlOnly;
    const gap = SizedBox(width: 28, height: 28);
    final children = [
      ShutterSideButton(
        icon: Icons.video_library_outlined,
        tooltip: 'Watch recordings',
        onPressed: busy ? null : onWatch,
      ),
      gap,
      shutter,
      gap,
      onControlOnly == null
          ? const SizedBox.square(dimension: ShutterSideButton.size)
          : ShutterSideButton(
              icon: Icons.videocam,
              tooltip: 'Control only (turn this camera off)',
              onPressed: busy ? null : onControlOnly,
            ),
    ];
    return MediaQuery.of(context).orientation == Orientation.landscape
        ? Column(mainAxisSize: MainAxisSize.min, children: children)
        : Row(mainAxisSize: MainAxisSize.min, children: children);
  }

  Widget _shutterButton() {
    final active =
        _recording || (!widget.isSolo && (_pendingStart?.isActive ?? false));
    return Container(
      width: 72,
      height: 72,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: Colors.white24,
        border: Border.all(color: Colors.white, width: 3),
      ),
      child: Center(
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          width: active ? 28 : 56,
          height: active ? 28 : 56,
          decoration: BoxDecoration(
            color: Colors.redAccent,
            borderRadius: BorderRadius.circular(active ? 6 : 28),
          ),
        ),
      ),
    );
  }
}

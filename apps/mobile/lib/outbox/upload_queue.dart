import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';
import 'package:video_compress/video_compress.dart';

import '../api/api_client.dart';
import '../api/recordings_api.dart';

/// One finished take waiting to reach the server.
class QueuedTake {
  QueuedTake({
    required this.id,
    required this.sessionId,
    required this.startedAtMs,
    required this.path,
    required this.filename,
    this.actualStartedAtMs,
    this.startClock,
    this.attempts = 0,
    this.preview = PreviewState.none,
    this.previewPath,
    this.uploadId,
    this.previewUploadId,
  });

  final String id;
  final String sessionId;

  /// The take's shared server-clock start; the server files angles by it.
  final int startedAtMs;
  final int? actualStartedAtMs;

  /// 'frame' when [actualStartedAtMs] is the first frame's capture time.
  final String? startClock;

  /// Where the video sits in the app's own storage until it's uploaded.
  final String path;
  final String filename;
  int attempts;

  /// The small copy sent ahead of the full video (see [UploadQueue]).
  PreviewState preview;
  String? previewPath;

  /// The server's resumable upload of the video, and of its preview, once
  /// one has started: a later try carries on from what reached the server.
  String? uploadId;
  String? previewUploadId;

  /// When the next try may start, after a failed one.
  DateTime? retryAt;
  String? lastError;

  Map<String, dynamic> toJson() => {
        'id': id,
        'sessionId': sessionId,
        'startedAtMs': startedAtMs,
        'actualStartedAtMs': actualStartedAtMs,
        'startClock': startClock,
        'path': path,
        'filename': filename,
        'attempts': attempts,
        'preview': preview.name,
        'previewPath': previewPath,
        'uploadId': uploadId,
        'previewUploadId': previewUploadId,
      };

  static QueuedTake fromJson(Map<String, dynamic> json) => QueuedTake(
        id: json['id'] as String,
        sessionId: json['sessionId'] as String,
        startedAtMs: (json['startedAtMs'] as num).toInt(),
        actualStartedAtMs: (json['actualStartedAtMs'] as num?)?.toInt(),
        startClock: json['startClock'] as String?,
        path: json['path'] as String,
        filename: json['filename'] as String,
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        preview: PreviewState.values.asNameMap()[json['preview']] ??
            PreviewState.none,
        uploadId: json['uploadId'] as String?,
        previewUploadId: json['previewUploadId'] as String?,
        previewPath: json['previewPath'] as String?,
      );
}

/// Where a take's preview is: still to be made, made and waiting to send,
/// or nothing left to do (sent, not needed, or couldn't be made).
enum PreviewState { toMake, toSend, none }

/// Makes a small copy of the video at [path] and returns where it is, or
/// null if it couldn't be made.
typedef PreviewMaker = Future<String?> Function(String path);

/// A 480p copy made with the phone's hardware encoder, about 1 Mbps.
Future<String?> makeVideoPreview(String path) async {
  final info = await VideoCompress.compressVideo(path,
      quality: VideoQuality.Res640x480Quality, includeAudio: true);
  // A cancelled one comes back (on iPhones) as the original video.
  if (info == null || info.isCancel == true || info.path == path) return null;
  return info.path;
}

/// What the queue last did with a take, for the status shown on the camera.
enum UploadEvent { uploaded, unrecorded, rejected }

/// The phone's outbox of finished takes. Every take is moved into the app's
/// own storage and listed here before it's sent, so nothing is lost to a
/// bad connection, a new take, leaving the camera or closing the app: the
/// list is saved and picked up again the next time the app opens.
///
/// A take big enough to take a while gets a small preview (480p, about a
/// fifth of the size) made and sent first, so the coach can watch it within
/// seconds on a slow connection; every waiting take's preview goes before
/// any full video. The server plays the preview until the full one lands.
///
/// Takes go one at a time, and a failed one is tried again after a growing
/// wait (5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min) until it gets
/// through. No upload starts while a take is starting or running ([pause]),
/// so the start and stop messages aren't stuck behind video on a slow
/// network; one already sending is stopped, and carries on from what
/// reached the server once the take is over (uploads go in resumable
/// pieces, see [RecordingsApi.uploadSessionVideo]).
class UploadQueue extends ChangeNotifier {
  UploadQueue(this._api, {PreviewMaker? makePreview, Directory? dir})
      : _makePreview = makePreview ?? makeVideoPreview,
        _dir = dir;

  /// The app's queue, made when the user is signed in (see HomeShell).
  static UploadQueue? instance;

  final RecordingsApi _api;
  final PreviewMaker _makePreview;
  final List<QueuedTake> _items = [];
  final Set<String> _pausedFor = {};
  Directory? _dir;
  bool _loaded = false;
  bool _running = false;
  bool _makingPreview = false;
  Timer? _wake;
  late final AppLifecycleListener _lifecycle =
      AppLifecycleListener(onResume: kick);

  /// The take being sent right now, if any.
  QueuedTake? sending;

  /// What of [sending] is going up ('preview' or 'full'), and how much of it
  /// has gone, 0 to 1. Null while a preview is being made, and the fraction
  /// until the first bytes go.
  String? sendingStage;
  double? sendingFraction;

  /// The most recent outcome, and when, for a short message on the camera.
  UploadEvent? lastEvent;
  DateTime? lastEventAt;

  List<QueuedTake> get items => List.unmodifiable(_items);
  int get waiting => _items.length;
  bool get paused => _pausedFor.isNotEmpty;

  /// The soonest a failed take will be tried again, when nothing is sending.
  DateTime? get nextRetryAt {
    DateTime? soonest;
    for (final item in _items) {
      final at = item.retryAt;
      if (at != null && (soonest == null || at.isBefore(soonest))) soonest = at;
    }
    return soonest;
  }

  /// Takes smaller than this have no video in them: the camera was
  /// interrupted before writing a frame (seen on iPhones), and the server
  /// would only reject them.
  static const minVideoBytes = 4096;

  /// Takes at least this big get a preview: about 10 s of 1080p. Smaller
  /// ones upload quickly enough as they are.
  static const previewFromBytes = 10 * 1024 * 1024;

  static const _retryDelays = [5, 15, 30, 60, 120, 300];

  Future<void> start() async {
    if (_loaded) return;
    _loaded = true;
    _lifecycle; // starts listening for the app coming back
    final dir = await _storage();
    final file = File('${dir.path}/queue.json');
    try {
      if (await file.exists()) {
        final list = jsonDecode(await file.readAsString()) as List;
        for (final json in list) {
          final item =
              QueuedTake.fromJson(Map<String, dynamic>.from(json as Map));
          if (!await File(item.path).exists()) continue;
          final previewPath = item.previewPath;
          if (item.preview == PreviewState.toSend &&
              (previewPath == null || !await File(previewPath).exists())) {
            item.preview = PreviewState.toMake;
          }
          _items.add(item);
        }
      }
    } catch (e) {
      debugPrint('Upload queue could not be read: $e');
    }
    notifyListeners();
    kick();
  }

  /// Adds a finished take. The video is moved out of the camera's temporary
  /// folder (which the phone may clear) into the app's own storage first.
  Future<void> add({
    required String sessionId,
    required int startedAtMs,
    int? actualStartedAtMs,
    String? startClock,
    required String sourcePath,
    required String filename,
  }) async {
    await start();
    final source = File(sourcePath);
    final size = await source.exists() ? await source.length() : 0;
    if (size < minVideoBytes) {
      await source.delete().catchError((_) => source);
      _event(UploadEvent.unrecorded);
      return;
    }
    final dir = await _storage();
    final id = '${DateTime.now().microsecondsSinceEpoch}';
    final ext = filename.contains('.') ? filename.split('.').last : 'mp4';
    final dest = '${dir.path}/$id.$ext';
    try {
      await source.rename(dest);
    } on FileSystemException {
      await source.copy(dest);
      await source.delete().catchError((_) => source);
    }
    _items.add(QueuedTake(
      id: id,
      sessionId: sessionId,
      startedAtMs: startedAtMs,
      actualStartedAtMs: actualStartedAtMs,
      startClock: startClock,
      path: dest,
      filename: filename,
      preview:
          size >= previewFromBytes ? PreviewState.toMake : PreviewState.none,
    ));
    await _save();
    notifyListeners();
    kick();
  }

  /// Holds new uploads back while [reason] lasts (a take starting or
  /// running); [resume] with the same reason lets them go again.
  void pause(String reason) {
    if (!_pausedFor.add(reason)) return;
    // Making a preview uses the video encoder the camera is about to need.
    if (_makingPreview) unawaited(VideoCompress.cancelCompression());
    notifyListeners();
  }

  void resume(String reason) {
    if (_pausedFor.remove(reason)) {
      notifyListeners();
      kick();
    }
  }

  /// Tries every waiting take now, without waiting out its retry time (the
  /// "Try now" button, after moving somewhere with better signal).
  void retryNow() {
    for (final item in _items) {
      item.retryAt = null;
    }
    kick();
  }

  /// Tries the queue now: after a new take, coming back to the app, or the
  /// end of a pause. Failed takes still wait out their retry time.
  void kick() {
    if (_running || paused || _items.isEmpty) return;
    unawaited(_run());
  }

  Future<void> _run() async {
    _running = true;
    _wake?.cancel();
    try {
      while (!paused) {
        final now = DateTime.now();
        final next = _items
            .where(
                (item) => item.retryAt == null || !item.retryAt!.isAfter(now))
            .firstOrNull;
        if (next == null) break;
        await _step(next);
      }
    } finally {
      _running = false;
      sending = null;
      sendingStage = null;
      sendingFraction = null;
      notifyListeners();
      _scheduleWake();
    }
  }

  /// The next thing to do for [item]: a preview to make or send comes
  /// first, for any waiting take, before a full video.
  Future<void> _step(QueuedTake item) async {
    final previews = _items.where((i) =>
        i.preview != PreviewState.none &&
        (i.retryAt == null || !i.retryAt!.isAfter(DateTime.now())));
    final take = previews.firstOrNull ?? item;
    switch (take.preview) {
      case PreviewState.toMake:
        await _makePreviewFor(take);
      case PreviewState.toSend:
        await _send(take, preview: true);
      case PreviewState.none:
        await _send(take);
    }
  }

  Future<void> _makePreviewFor(QueuedTake item) async {
    sending = item;
    sendingStage = null;
    sendingFraction = null;
    notifyListeners();
    _makingPreview = true;
    String? made;
    try {
      made = await _makePreview(item.path);
    } catch (e) {
      debugPrint('Preview could not be made: $e');
    } finally {
      _makingPreview = false;
    }
    // Stopped for a take: make it again afterwards.
    if (paused) {
      if (made != null) {
        await File(made).delete().catchError((_) => File(made!));
      }
      return;
    }
    final size =
        made == null ? 0 : await File(made).length().catchError((_) => 0);
    if (made == null || size < minVideoBytes) {
      item.preview = PreviewState.none;
    } else {
      final dest = '${(await _storage()).path}/${item.id}-preview.mp4';
      try {
        await File(made).rename(dest);
      } on FileSystemException {
        await File(made).copy(dest);
        await File(made).delete().catchError((_) => File(made!));
      }
      item.previewPath = dest;
      item.preview = PreviewState.toSend;
    }
    await _save();
  }

  /// The upload in progress was stopped for a [pause], not by a failure.
  bool _stoppedForPause = false;

  Future<void> _send(QueuedTake item, {bool preview = false}) async {
    sending = item;
    sendingStage = preview ? 'preview' : 'full';
    sendingFraction = null;
    notifyListeners();
    try {
      await _api.saveRecordingDetails(item.sessionId, item.startedAtMs,
          actualStartedAtMs: item.actualStartedAtMs,
          startClock: item.startClock);
      await _api.uploadSessionVideo(
        item.sessionId,
        item.startedAtMs,
        preview ? item.previewPath! : item.path,
        filename: preview ? 'preview.mp4' : item.filename,
        actualStartedAtMs: item.actualStartedAtMs,
        startClock: item.startClock,
        preview: preview,
        timeout: const Duration(minutes: 30),
        resumeId: preview ? item.previewUploadId : item.uploadId,
        onStarted: (uploadId) {
          if (preview) {
            item.previewUploadId = uploadId;
          } else {
            item.uploadId = uploadId;
          }
          unawaited(_save());
        },
        onProgress: (sent, total) {
          // Throwing here ends the file's stream, which ends the upload.
          if (paused) {
            _stoppedForPause = true;
            throw StateError('Upload paused for a take');
          }
          _showProgress(sent, total);
          _reportProgress(item, preview ? 'preview' : 'full', sent, total);
        },
      );
      item.attempts = 0;
      if (preview) {
        await _dropPreview(item);
      } else {
        await _remove(item);
        _event(UploadEvent.uploaded);
      }
    } on ApiException catch (e) {
      if (_wasPaused()) return;
      // The server looked at it and said no (not a video, session gone):
      // trying again won't change that. Anything else (no connection, the
      // server busy, signed out) is worth another go.
      final permanent = e.statusCode >= 400 &&
          e.statusCode < 500 &&
          !const {401, 403, 408, 429}.contains(e.statusCode);
      if (permanent && preview) {
        // Only the preview: the full video still goes.
        debugPrint('Preview rejected (${e.statusCode}): ${e.message}');
        await _dropPreview(item);
      } else if (permanent) {
        debugPrint('Upload rejected (${e.statusCode}): ${e.message}');
        await _remove(item);
        _event(UploadEvent.rejected);
      } else {
        _failed(item, e.message);
      }
    } catch (e) {
      if (_wasPaused()) return;
      _failed(item, '$e');
    }
  }

  /// Whether the upload just ended was stopped for a [pause]. It then waits
  /// in the queue as it was, with no failed try counted.
  bool _wasPaused() {
    if (!_stoppedForPause) return false;
    _stoppedForPause = false;
    return true;
  }

  /// How often an upload's progress is sent to the server, for the bars
  /// viewers see: often enough to look alive, rarely enough not to compete
  /// with the upload on a bad connection.
  static const _progressEvery = Duration(seconds: 3);
  DateTime? _progressSentAt;

  /// For the camera's upload pill: redrawn only when the whole percent moves.
  void _showProgress(int sent, int total) {
    if (total <= 0) return;
    final fraction = (sent / total).clamp(0.0, 1.0);
    final before = sendingFraction;
    sendingFraction = fraction;
    if (before == null || (before * 100).floor() != (fraction * 100).floor()) {
      notifyListeners();
    }
  }

  void _reportProgress(QueuedTake item, String stage, int sent, int total) {
    final now = DateTime.now();
    final last = _progressSentAt;
    if (total <= 0 || (last != null && now.difference(last) < _progressEvery)) {
      return;
    }
    _progressSentAt = now;
    unawaited(_api
        .reportUploadProgress(
            item.sessionId, item.startedAtMs, stage, sent / total)
        .catchError((_) {}));
  }

  void _failed(QueuedTake item, String error) {
    item.attempts += 1;
    item.lastError = error;
    final wait =
        _retryDelays[math.min(item.attempts - 1, _retryDelays.length - 1)];
    item.retryAt = DateTime.now().add(Duration(seconds: wait));
    debugPrint(
        'Upload failed (try ${item.attempts}), again in ${wait}s: $error');
    unawaited(_save());
    notifyListeners();
  }

  Future<void> _remove(QueuedTake item) async {
    _items.remove(item);
    await File(item.path).delete().catchError((_) => File(item.path));
    await _dropPreview(item);
  }

  /// Done with the preview: sent, refused, or the take is gone.
  Future<void> _dropPreview(QueuedTake item) async {
    final path = item.previewPath;
    item.preview = PreviewState.none;
    item.previewPath = null;
    item.previewUploadId = null;
    if (path != null) await File(path).delete().catchError((_) => File(path));
    await _save();
  }

  void _event(UploadEvent event) {
    lastEvent = event;
    lastEventAt = DateTime.now();
    notifyListeners();
  }

  void _scheduleWake() {
    _wake?.cancel();
    final at = nextRetryAt;
    if (at == null || paused) return;
    final wait = at.difference(DateTime.now());
    _wake = Timer(wait.isNegative ? Duration.zero : wait, kick);
  }

  Future<Directory> _storage() async {
    final existing = _dir;
    if (existing != null) return existing;
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/upload_queue');
    await dir.create(recursive: true);
    return _dir = dir;
  }

  Future<void> _save() async {
    final dir = await _storage();
    final file = File('${dir.path}/queue.json');
    await file
        .writeAsString(jsonEncode([for (final item in _items) item.toJson()]));
  }
}

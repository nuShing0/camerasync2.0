import 'dart:async';
import 'dart:io';

import 'package:camerasync_mobile/api/recordings_api.dart';
import 'package:camerasync_mobile/outbox/upload_queue.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records what was uploaded, in order.
class _FakeApi implements RecordingsApi {
  final sent = <String>[];

  @override
  Future<void> saveRecordingDetails(String id, int startedAtMs,
      {int? actualStartedAtMs, String? startClock}) async {}

  @override
  Future<void> uploadSessionVideo(String id, int startedAtMs, String filePath,
      {String? filename,
      int? actualStartedAtMs,
      String? startClock,
      bool preview = false,
      Duration timeout = const Duration(minutes: 10),
      void Function(int sent, int total)? onProgress,
      String? resumeId,
      void Function(String uploadId)? onStarted}) async {
    onProgress?.call(5, 10);
    sent.add('${preview ? 'preview' : 'full'} $startedAtMs');
  }

  final progress = <String>[];

  @override
  Future<void> reportUploadProgress(
      String id, int startedAtMs, String stage, double fraction) async {
    progress.add('$stage $startedAtMs $fraction');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Sends half, then waits for [halfway] before the rest, like a slow
/// upload a take can start in the middle of.
class _SlowApi extends _FakeApi {
  final halfway = <Completer<void>>[];

  /// The upload each try carried on from (null: a new one).
  final resumedFrom = <String?>[];

  @override
  Future<void> uploadSessionVideo(String id, int startedAtMs, String filePath,
      {String? filename,
      int? actualStartedAtMs,
      String? startClock,
      bool preview = false,
      Duration timeout = const Duration(minutes: 10),
      void Function(int sent, int total)? onProgress,
      String? resumeId,
      void Function(String uploadId)? onStarted}) async {
    resumedFrom.add(resumeId);
    if (resumeId == null) onStarted?.call('upload-$startedAtMs');
    onProgress?.call(5, 10);
    final gate = Completer<void>();
    halfway.add(gate);
    await gate.future;
    onProgress?.call(10, 10);
    sent.add('${preview ? 'preview' : 'full'} $startedAtMs');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory dir;
  setUp(() => dir = Directory.systemTemp.createTempSync('outbox'));
  tearDown(() => dir.deleteSync(recursive: true));

  Future<String> take(String name, int bytes) async {
    final file = File('${dir.path}/$name.mp4');
    await file.writeAsBytes(List.filled(bytes, 1));
    return file.path;
  }

  Future<void> settle(UploadQueue queue) async {
    for (var i = 0;
        i < 100 && (queue.waiting > 0 || queue.sending != null);
        i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  test('sends every waiting preview before any full video', () async {
    final api = _FakeApi();
    final queue =
        UploadQueue(api, dir: Directory('${dir.path}/queue')..createSync(),
            makePreview: (path) async {
      final copy = File('$path.small.mp4');
      await copy.writeAsBytes(List.filled(8192, 2));
      return copy.path;
    });
    queue.pause('take');
    for (final at in [1, 2]) {
      await queue.add(
          sessionId: 's',
          startedAtMs: at,
          sourcePath: await take('t$at', UploadQueue.previewFromBytes),
          filename: 't$at.mp4');
    }
    // What the camera's upload pill shows, as it changes.
    final shown = <String>[];
    queue.addListener(() {
      if (queue.sendingFraction case final fraction?) {
        final line = '${queue.sendingStage} $fraction';
        if (shown.lastOrNull != line) shown.add(line);
      }
    });
    queue.resume('take');
    await settle(queue);
    expect(api.sent, ['preview 1', 'preview 2', 'full 1', 'full 2']);
    expect(shown, ['preview 0.5', 'full 0.5']);
    expect(queue.sendingFraction, isNull);
    // Viewers' progress bars got a report, without one per byte.
    expect(api.progress, isNotEmpty);
    expect(api.progress.first, 'preview 1 0.5');
    // Nothing left behind on the phone.
    expect(
        Directory('${dir.path}/queue')
            .listSync()
            .whereType<File>()
            .where((f) => f.path.endsWith('.mp4')),
        isEmpty);
  });

  test('a small take, or one whose preview fails, goes as it is', () async {
    final api = _FakeApi();
    final queue = UploadQueue(api,
        dir: Directory('${dir.path}/queue')..createSync(),
        makePreview: (_) async => null);
    await queue.add(
        sessionId: 's',
        startedAtMs: 1,
        sourcePath: await take('big', UploadQueue.previewFromBytes),
        filename: 'big.mp4');
    await settle(queue);
    await queue.add(
        sessionId: 's',
        startedAtMs: 2,
        sourcePath: await take('small', 8192),
        filename: 'small.mp4');
    await settle(queue);
    expect(api.sent, ['full 1', 'full 2']);
  });

  test('a take starting stops the upload in progress, which carries on after',
      () async {
    final api = _SlowApi();
    final queue =
        UploadQueue(api, dir: Directory('${dir.path}/queue')..createSync());
    await queue.add(
        sessionId: 's',
        startedAtMs: 1,
        sourcePath: await take('small', 8192),
        filename: 'small.mp4');
    for (var i = 0; i < 100 && api.halfway.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }

    queue.pause('take');
    api.halfway.last.complete();
    await settle(queue);
    // Stopped mid-way: still waiting, with no failed try held against it.
    expect(api.sent, isEmpty);
    expect(queue.waiting, 1);
    expect(queue.nextRetryAt, isNull);

    queue.resume('take');
    for (var i = 0; i < 100 && api.halfway.length < 2; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    api.halfway.last.complete();
    await settle(queue);
    expect(api.sent, ['full 1']);
    // The second try picked up the first one's upload, not a new one.
    expect(api.resumedFrom, [null, 'upload-1']);
  });
}

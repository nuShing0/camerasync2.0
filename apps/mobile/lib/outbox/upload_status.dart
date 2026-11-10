import 'dart:async';

import 'package:flutter/material.dart';

import '../widgets/frosted.dart';
import 'upload_queue.dart';

/// A small pill on the camera saying what the phone's outbox is doing:
/// sending, waiting (and why), just finished, or a take that didn't record.
/// Hidden when there's nothing to say.
class UploadStatusBanner extends StatefulWidget {
  const UploadStatusBanner({super.key, required this.queue});

  final UploadQueue queue;

  @override
  State<UploadStatusBanner> createState() => _UploadStatusBannerState();
}

class _UploadStatusBannerState extends State<UploadStatusBanner> {
  // Keeps "retrying in 12 s" counting and lets short messages expire.
  late final Timer _tick =
      Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));

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
    return ListenableBuilder(
      listenable: widget.queue,
      builder: (context, _) {
        final status = _status(widget.queue);
        if (status == null) return const SizedBox.shrink();
        return _pill(status);
      },
    );
  }

  _Status? _status(UploadQueue q) {
    final now = DateTime.now();
    final event = q.lastEvent;
    final eventAge =
        q.lastEventAt == null ? null : now.difference(q.lastEventAt!);
    final waiting = q.waiting;
    String takes(int n) => n == 1 ? '1 take' : '$n takes';

    if (event == UploadEvent.unrecorded &&
        eventAge! < const Duration(seconds: 10)) {
      return const _Status(
          _Kind.error, "That take didn't record: the camera was interrupted.");
    }
    if (event == UploadEvent.rejected &&
        eventAge! < const Duration(seconds: 10)) {
      return const _Status(_Kind.error, "The server couldn't use that take.");
    }
    if (q.sending != null) {
      final more = waiting - 1;
      final fraction = q.sendingFraction;
      if (fraction != null) {
        // Same words as the progress under the angle when it's watched.
        final what = q.sendingStage == 'preview' ? 'preview' : 'full quality';
        final percent = (fraction * 100).floor();
        return _Status(
            _Kind.busy,
            more > 0
                ? 'Uploading $what $percent% ($more more waiting)'
                : 'Uploading $what $percent%',
            progress: fraction);
      }
      return _Status(
          _Kind.busy,
          more > 0
              ? 'Uploading a take ($more more waiting)…'
              : 'Uploading take…');
    }
    if (waiting > 0 && q.paused) {
      return _Status(
          _Kind.waiting, '${takes(waiting)} to upload after this take');
    }
    if (waiting > 0) {
      final retryAt = q.nextRetryAt;
      if (retryAt != null) {
        final secs = retryAt.difference(now).inSeconds.clamp(0, 9999);
        return _Status(_Kind.waiting,
            'No connection: ${takes(waiting)} waiting, trying again in ${secs}s',
            canRetry: true);
      }
      return _Status(_Kind.waiting, '${takes(waiting)} waiting to upload');
    }
    if (event == UploadEvent.uploaded &&
        eventAge! < const Duration(seconds: 4)) {
      return const _Status(_Kind.done, 'Uploaded for playback');
    }
    return null;
  }

  Widget _pill(_Status status) {
    return Frosted(
      radius: 20,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: IntrinsicWidth(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _row(status),
              if (status.progress case final progress?) ...[
                const SizedBox(height: 6),
                ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: LinearProgressIndicator(
                    value: progress,
                    minHeight: 3,
                    color: Colors.white,
                    backgroundColor: Colors.white24,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _row(_Status status) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        switch (status.kind) {
          _Kind.busy => const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(
                  strokeWidth: 2, color: Colors.white),
            ),
          _Kind.waiting => const Icon(Icons.cloud_upload_outlined,
              size: 18, color: Colors.amberAccent),
          _Kind.done => const Icon(Icons.cloud_done_outlined,
              size: 18, color: Colors.greenAccent),
          _Kind.error =>
            const Icon(Icons.error_outline, size: 18, color: Colors.redAccent),
        },
        const SizedBox(width: 8),
        Flexible(
          child: Text(status.message,
              style: const TextStyle(color: Colors.white, fontSize: 13)),
        ),
        if (status.canRetry) ...[
          const SizedBox(width: 6),
          TextButton(
            onPressed: widget.queue.retryNow,
            style: TextButton.styleFrom(
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: const Text('Try now'),
          ),
        ],
      ],
    );
  }
}

enum _Kind { busy, waiting, done, error }

class _Status {
  const _Status(this.kind, this.message,
      {this.canRetry = false, this.progress});
  final _Kind kind;
  final String message;
  final bool canRetry;

  /// How much of the upload has gone, 0 to 1, drawn as a bar under the text.
  final double? progress;
}

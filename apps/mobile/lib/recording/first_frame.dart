import 'dart:async';

import 'package:flutter/services.dart';

/// When the camera captured the current recording's first frame, on this
/// phone's clock (ms since the epoch), from the project's copies of the
/// camera plugins (packages/camera_android_camerax, packages/camera_avfoundation).
///
/// The time the app noted when it asked the camera to start can be up to a
/// second early (camera warm-up). This one is when recording really began,
/// so angles can be lined up by time.
const _channel = MethodChannel('app.eightkount/first_frame');

/// Asks for it until it's known (a moment after recording starts), for up to
/// [within]. Null when the plugin can't say (an older build, the web) or
/// the take is stopped first.
Future<int?> firstFrameAtEpochMs({
  Duration within = const Duration(seconds: 4),
}) async {
  final deadline = DateTime.now().add(within);
  while (DateTime.now().isBefore(deadline)) {
    try {
      final value = await _channel.invokeMethod<int>('get');
      if (value != null) return value;
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  return null;
}

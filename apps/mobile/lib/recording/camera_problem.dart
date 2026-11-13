import 'package:camera/camera.dart';

/// What went wrong opening (or keeping) the camera, in words a person can
/// act on. [error] is what the camera plugin threw, or the description it
/// reported later on the controller.
String cameraProblemMessage(Object? error) {
  final code = error is CameraException ? error.code : '';
  final text = (error is CameraException
          ? '${error.code} ${error.description ?? ''}'
          : '${error ?? ''}')
      .toLowerCase();

  if (code.startsWith('CameraAccess') ||
      code == 'AudioAccessDenied' ||
      code.startsWith('AudioAccess') ||
      text.contains('permission')) {
    return "8Kount isn't allowed to use the camera or microphone. Allow them "
        'in Settings, then try again.';
  }
  if (text.contains('in use') ||
      text.contains('in_use') ||
      text.contains('busy') ||
      text.contains('max_cameras') ||
      text.contains('another') ||
      text.contains('interrupt')) {
    return 'Another app is using the camera, like a video call or another '
        'camera app. Close it there, then try again.';
  }
  return "The camera couldn't start. If another app is using it, like a "
      'video call, close it there, then try again.';
}

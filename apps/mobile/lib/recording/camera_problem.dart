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
    return "8Kount can't use the camera or microphone. Allow them in Settings.";
  }
  if (text.contains('in use') ||
      text.contains('in_use') ||
      text.contains('busy') ||
      text.contains('max_cameras') ||
      text.contains('another') ||
      text.contains('interrupt')) {
    return 'Another app is using the camera. Close it there, then try again.';
  }
  return "The camera couldn't start. Try again.";
}

import 'package:camera/camera.dart';
import 'package:camerasync_mobile/recording/camera_problem.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('another app holding the camera says so', () {
    expect(
        cameraProblemMessage(CameraException(
            'cameraError', 'The camera is in use by another app')),
        contains('Another app'));
    expect(cameraProblemMessage('ERROR_MAX_CAMERAS_IN_USE'),
        contains('Another app'));
    expect(cameraProblemMessage('Capture session was interrupted'),
        contains('Another app'));
  });

  test('a refused permission points to Settings', () {
    expect(
        cameraProblemMessage(
            CameraException('CameraAccessDenied', 'User denied access')),
        contains('Settings'));
  });

  test('anything else still says what to try', () {
    expect(cameraProblemMessage(CameraException('weird', null)),
        contains('Try again'));
    expect(cameraProblemMessage(null), contains('Try again'));
  });

  test('messages stay short and name no other app', () {
    for (final e in [
      'in use',
      CameraException('CameraAccessDenied', null),
      null,
    ]) {
      final message = cameraProblemMessage(e);
      expect(message.length, lessThan(80));
      expect(message, isNot(matches(RegExp('Zoom|Teams|FaceTime|video call'))));
    }
  });
}

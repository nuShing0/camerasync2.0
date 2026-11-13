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
        contains('try again'));
    expect(cameraProblemMessage(null), contains('try again'));
  });
}

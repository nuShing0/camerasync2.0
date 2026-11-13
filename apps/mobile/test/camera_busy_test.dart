// ignore_for_file: depend_on_referenced_packages
import 'package:camera_platform_interface/camera_platform_interface.dart';
import 'package:camerasync_mobile/screens/camera_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// A phone whose camera another app has.
class _BusyCamera extends CameraPlatform {
  int opened = 0;

  @override
  Future<List<CameraDescription>> availableCameras() async {
    opened++;
    throw CameraException(
        'cameraError', 'The camera is in use by another app');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _BusyCamera camera;
  setUp(() {
    camera = _BusyCamera();
    CameraPlatform.instance = camera;
    // Camera and microphone already allowed.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('flutter.baseflow.com/permissions/methods'),
      (call) async => {1: 1, 7: 1},
    );
  });

  testWidgets('a host can switch to control only while the camera is busy',
      (tester) async {
    var controlOnly = 0;
    await tester.pumpWidget(MaterialApp(
      home: CameraScreen(onControlOnly: () => controlOnly++),
    ));
    await tester.pump();
    await tester.pump();

    expect(find.text('Camera unavailable'), findsOneWidget);
    expect(find.textContaining('Another app is using the camera'),
        findsOneWidget);

    await tester.tap(find.text('Control only (no camera)'));
    expect(controlOnly, 1);

    // Try again opens the camera again (still busy here).
    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump();
    expect(camera.opened, 2);
    expect(find.text('Camera unavailable'), findsOneWidget);
  });

  testWidgets('a member who cannot control only gets Try again',
      (tester) async {
    await tester.pumpWidget(const MaterialApp(home: CameraScreen()));
    await tester.pump();
    await tester.pump();

    expect(find.text('Try again'), findsOneWidget);
    expect(find.text('Control only (no camera)'), findsNothing);
  });
}

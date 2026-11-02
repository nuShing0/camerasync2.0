import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/home_shell.dart';

void main() {
  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
  });

  Widget wrap(Widget child) => MaterialApp(home: child);

  testWidgets('bar: Home, Groups, +, Sessions, Calendar', (tester) async {
    final auth = AuthService(ApiClient('http://127.0.0.1:1'));
    await tester.pumpWidget(wrap(HomeShell(auth: auth)));

    expect(find.byIcon(Icons.home_outlined), findsOneWidget);
    expect(find.byIcon(Icons.groups), findsOneWidget);
    expect(find.byIcon(Icons.add), findsOneWidget);
    expect(find.byIcon(Icons.video_library_outlined), findsOneWidget);
    expect(find.byIcon(Icons.calendar_month_outlined), findsOneWidget);
    expect(find.byIcon(Icons.photo_camera_outlined), findsNothing);
  });

  testWidgets('opens on Home and switches tabs when tapped', (tester) async {
    final auth = AuthService(ApiClient('http://127.0.0.1:1'));
    await tester.pumpWidget(wrap(HomeShell(auth: auth)));

    // Home is the default tab, at the far left.
    expect(find.byKey(const ValueKey('home-tab')), findsOneWidget);

    await tester.tap(find.byIcon(Icons.groups));
    await tester.pumpAndSettle();
    expect(find.text('Join group'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.video_library_outlined));
    await tester.pumpAndSettle();
    // One page now: live sessions and Past, searchable, no switch.
    expect(find.text('Search sessions'), findsOneWidget);
    expect(find.text('Live & upcoming'), findsNothing);
  });

  testWidgets('+ opens the new session menu', (tester) async {
    final auth = AuthService(ApiClient('http://127.0.0.1:1'));
    await tester.pumpWidget(wrap(HomeShell(auth: auth)));

    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();
    expect(find.text('Start a session now'), findsOneWidget);
    expect(find.text('Schedule a session'), findsOneWidget);
    expect(find.text('Join with a code'), findsOneWidget);
  });

  testWidgets('Settings opens from the gear on Home', (tester) async {
    final auth = AuthService(ApiClient('http://127.0.0.1:1'));
    await tester.pumpWidget(wrap(HomeShell(auth: auth)));

    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Log out'), findsOneWidget);
  });
}

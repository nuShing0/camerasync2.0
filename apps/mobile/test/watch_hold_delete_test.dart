import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/api/recordings_api.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/watch_screen.dart';

/// Holding a recording in a session's list deletes it with every angle, for
/// admins only, against a tiny local server like the real recordings routes.
void main() {
  const first = 1790000000000;
  const second = 1790000600000;
  late HttpServer server;
  late List<int> deleted;
  late bool admin;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    HttpOverrides.global = null;
    deleted = [];
    admin = true;

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      Object? body;
      var status = 200;
      if (path == '/api/recordings/sessions/abc123/videos') {
        body = {
          'session': {'id': 'abc123', 'name': 'Stunt practice'},
          'canDelete': admin,
          'recordings': [
            for (final (at, number) in [(first, 1), (second, 2)])
              if (!deleted.contains(at))
                {
                  'startedAt': at,
                  'number': number,
                  'videos': [
                    // No url, so the test needs no video player.
                    {'userId': 1, 'name': 'Ryan', 'url': null},
                    {'userId': 2, 'name': 'Parker', 'url': null},
                  ],
                },
          ],
        };
      } else if (path.startsWith('/api/recordings/sessions/abc123/recordings/') &&
          req.method == 'DELETE') {
        deleted.add(int.parse(path.split('/').last));
        body = {'ok': true};
      } else if (path == '/api/recordings/sessions/abc123/notes') {
        body = {'notes': []};
      } else {
        status = 404;
        body = {'error': 'not found'};
      }
      req.response
        ..statusCode = status
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(body));
      await req.response.close();
    });
  });

  tearDown(() => server.close(force: true));

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 300));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> openList(WidgetTester tester) async {
    final auth = AuthService(
        ApiClient('http://${server.address.address}:${server.port}'));
    const session = RecordingSession(
      id: 'abc123',
      name: 'Stunt practice',
      status: 'complete',
      activeMemberCount: 0,
      isJoined: true,
    );
    await tester.runAsync(() async {
      await tester.pumpWidget(
        MaterialApp(home: WatchScreen(auth: auth, session: session)),
      );
    });
    await settle(tester);
  }

  /// Leaves the screen, which stops its refresh timer, then lets requests
  /// still on their way finish and their 15 s timeouts and any message run
  /// out.
  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
    await tester.pump(const Duration(seconds: 20));
  }

  testWidgets('an admin holds a recording to delete it, after asking',
      (tester) async {
    await openList(tester);
    expect(find.text('Hold a recording to delete it.'), findsOneWidget);

    await tester.longPress(find.text('Recording 002'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Delete Recording 002?'), findsOneWidget);

    // Cancel keeps it.
    await tester.tap(find.text('Cancel'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(deleted, isEmpty);

    await tester.longPress(find.text('Recording 002'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Delete Recording 002?'), findsOneWidget);
    await tester.tap(find.text('Delete'));
    for (var i = 0; i < 4 && deleted.isEmpty; i++) {
      await settle(tester);
    }
    expect(deleted, [second]);
    expect(find.text('Recording 002 deleted'), findsOneWidget);
    await close(tester);
  });

  testWidgets('members get no hold to delete', (tester) async {
    admin = false;
    await openList(tester);
    expect(find.text('Recording 002'), findsOneWidget);
    expect(find.text('Hold a recording to delete it.'), findsNothing);

    await tester.longPress(find.text('Recording 002'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Delete Recording 002?'), findsNothing);
    expect(deleted, isEmpty);
    await close(tester);
  });
}

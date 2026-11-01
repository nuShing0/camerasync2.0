import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/recordings_screen.dart';

/// Drives the list against a tiny local server so the real ApiClient and
/// JSON parsing are exercised, not a mock.
void main() {
  late HttpServer server;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      Object body;
      if (req.uri.path == '/api/recordings/sessions') {
        body = {
          'sessions': [
            {
              'id': 'abc123',
              'groupId': 'cheer',
              'name': 'Stunt practice',
              'status': 'complete',
              'scheduledAt': '2026-09-29T18:00:00.000Z',
              'activeMemberCount': 0,
              'isJoined': true,
              // 8 angles across 2 takes: the card counts the takes.
              'totalRecordings': 8,
              'recordingCount': 2,
            },
            {
              'id': 'def456',
              'groupId': 'cheer',
              'name': 'Still live',
              'status': 'active',
              'activeMemberCount': 3,
              'isJoined': false,
            },
            {
              'id': 'ghi789',
              'groupId': 'dance',
              'name': 'Dance run-through',
              'status': 'complete',
              'scheduledAt': '2026-09-28T18:00:00.000Z',
              'activeMemberCount': 0,
              'isJoined': true,
              'totalRecordings': 1,
              'recordingCount': 1,
            },
          ],
        };
      } else if (req.uri.path == '/api/groups') {
        body = {
          'groups': [
            {'id': 'cheer', 'name': 'UCF Cheer'},
            {'id': 'dance', 'name': 'Dance Team'},
          ],
        };
      } else {
        body = {'error': 'not found'};
        req.response.statusCode = 404;
      }
      req.response
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(body));
      await req.response.close();
    });
  });

  tearDown(() => server.close(force: true));

  AuthService auth() =>
      AuthService(ApiClient('http://${server.address.address}:${server.port}'));

  // flutter_test installs an HttpOverrides that fails every request with a
  // 400; clear it so the widget can reach the local server above.
  setUp(() => HttpOverrides.global = null);

  testWidgets('lists completed sessions newest first with group names',
      (tester) async {
    await tester.runAsync(() async {
      await tester.pumpWidget(MaterialApp(home: RecordingsScreen(auth: auth())));
      // Let the HTTP round trips finish, then rebuild.
      await Future<void>.delayed(const Duration(milliseconds: 500));
      await tester.pump();
      await tester.pump();
    });

    expect(find.text('Stunt practice'), findsOneWidget);
    expect(find.text('Dance run-through'), findsOneWidget);
    expect(find.text('Still live'), findsNothing);
    expect(find.textContaining('UCF Cheer'), findsOneWidget);
    expect(find.textContaining('2 recordings'), findsOneWidget);

    final stunt = tester.getTopLeft(find.text('Stunt practice'));
    final dance = tester.getTopLeft(find.text('Dance run-through'));
    expect(stunt.dy, lessThan(dance.dy));
  });

  testWidgets('filters to one group when opened from Groups', (tester) async {
    await tester.runAsync(() async {
      await tester.pumpWidget(MaterialApp(
        home: RecordingsScreen(auth: auth(), groupId: 'dance', title: 'Dance Team'),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 500));
      await tester.pump();
      await tester.pump();
    });

    expect(find.text('Dance run-through'), findsOneWidget);
    expect(find.text('Stunt practice'), findsNothing);
  });
}

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/sessions_tab.dart';

/// Drives the Sessions tab against a tiny local server, so the real
/// ApiClient and JSON parsing are exercised, not a mock.
void main() {
  late HttpServer server;
  late List<String> deleted;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    deleted = [];
    final now = DateTime.now().toUtc();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      Object body;
      if (req.method == 'DELETE') {
        deleted.add(req.uri.pathSegments.last);
        body = {};
      } else if (req.uri.path == '/api/recordings/sessions') {
        body = {
          'sessions': [
            {
              'id': 'live01',
              'groupId': 'cheer',
              'name': 'Thursday session',
              'status': 'active',
              'scheduledAt':
                  now.subtract(const Duration(minutes: 10)).toIso8601String(),
              'activeMemberCount': 6,
              'activeMemberNames': ['Cara', 'Maya', 'Jo', 'Lee', 'Sam', 'Pat'],
              'recordingCount': 4,
              'createdBy': 99,
              'isJoined': false,
            },
            {
              'id': 'abc123',
              'groupId': 'cheer',
              'name': 'Stunt practice',
              'status': 'complete',
              'scheduledAt': '2026-09-29T18:00:00.000Z',
              'activeMemberCount': 0,
              'isJoined': true,
              'recordingCount': 2,
            },
            {
              'id': 'ghi789',
              'groupId': 'dance',
              'name': 'Dance run-through',
              'status': 'complete',
              'scheduledAt': '2026-09-28T18:00:00.000Z',
              'activeMemberCount': 0,
              'isJoined': true,
              'recordingCount': 1,
            },
            {
              'id': 'solo01',
              'name': 'Open gym',
              'status': 'complete',
              'scheduledAt': '2026-08-02T18:00:00.000Z',
              'activeMemberCount': 0,
              'isJoined': true,
              'recordingCount': 1,
            },
            {
              'id': 'next01',
              'groupId': 'dance',
              'name': 'Next week',
              'status': 'scheduled',
              'scheduledAt': now.add(const Duration(days: 3)).toIso8601String(),
              'activeMemberCount': 0,
              'isJoined': false,
            },
          ],
        };
      } else if (req.uri.path == '/api/groups') {
        body = {
          'groups': [
            {'id': 'cheer', 'name': 'UCF Cheer', 'role': 'admin'},
            {'id': 'dance', 'name': 'Dance Team', 'role': 'member'},
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

  // flutter_test installs an HttpOverrides that fails every request with a
  // 400; clear it so the widget can reach the local server above.
  setUp(() => HttpOverrides.global = null);

  AuthService auth() =>
      AuthService(ApiClient('http://${server.address.address}:${server.port}'));

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() async {
      // Let the HTTP round trips finish, then rebuild.
      await Future<void>.delayed(const Duration(milliseconds: 500));
      await tester.pump();
      await tester.pump();
    });
  }

  Future<void> show(WidgetTester tester) async {
    // Tall enough that the whole list is built.
    tester.view.physicalSize = const Size(420, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.runAsync(() async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: SessionsTab(auth: auth())),
      ));
    });
    await settle(tester);
  }

  testWidgets('live card on top, then Past by month; no upcoming',
      (tester) async {
    await show(tester);

    expect(find.text('Sessions'), findsOneWidget);
    expect(find.text('4 sessions · 8 recordings'), findsOneWidget);

    // The live card: who's in it (four initials, then +2) and the counts.
    expect(find.text('LIVE'), findsOneWidget);
    expect(find.text('Thursday session'), findsOneWidget);
    for (final initial in ['C', 'M', 'J', 'L', '+2']) {
      expect(find.text(initial), findsOneWidget);
    }
    expect(find.text('6 devices · 4 recordings so far'), findsOneWidget);
    expect(find.text('Join'), findsOneWidget);
    expect(find.text('Watch so far'), findsOneWidget);
    // An admin of the session's group can end it.
    expect(find.text('End session'), findsOneWidget);

    expect(find.text('Past'), findsOneWidget);
    expect(find.textContaining('SEPTEMBER'), findsOneWidget);
    expect(find.textContaining('AUGUST'), findsOneWidget);
    expect(find.text('Stunt practice'), findsOneWidget);
    expect(find.text('Dance run-through'), findsOneWidget);
    expect(find.text('Open gym'), findsOneWidget);
    expect(find.text('Next week'), findsNothing);

    // Only the admin's group gets the ··· menu.
    expect(find.text('···'), findsOneWidget);
  });

  testWidgets('search and group chips filter both live and past',
      (tester) async {
    await show(tester);

    // A chip per group, and No group since one session has none.
    expect(find.text('All'), findsOneWidget);
    expect(find.text('UCF Cheer'), findsOneWidget);
    expect(find.text('Dance Team'), findsOneWidget);
    expect(find.text('No group'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'dance');
    await tester.pump();
    expect(find.text('Dance run-through'), findsOneWidget);
    expect(find.text('Stunt practice'), findsNothing);
    expect(find.text('Thursday session'), findsNothing);

    await tester.enterText(find.byType(TextField), '');
    await tester.tap(find.text('UCF Cheer'));
    await tester.pump();
    expect(find.text('Thursday session'), findsOneWidget);
    expect(find.text('Stunt practice'), findsOneWidget);
    expect(find.text('Dance run-through'), findsNothing);
    expect(find.text('Open gym'), findsNothing);

    await tester.ensureVisible(find.text('No group'));
    await tester.tap(find.text('No group'));
    await tester.pump();
    expect(find.text('Open gym'), findsOneWidget);
    expect(find.text('Thursday session'), findsNothing);
  });

  testWidgets('··· deletes a session after confirming', (tester) async {
    await show(tester);

    await tester.tap(find.text('···'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(find.textContaining("Delete Stunt practice and all its videos?"),
        findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    // The request went out from the test's fake clock: let the real one
    // deliver the reply, then pump it through.
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 150)));
      await tester.pump();
    }
    expect(deleted, ['abc123']);
    expect(find.text('Stunt practice'), findsNothing);
  });
}

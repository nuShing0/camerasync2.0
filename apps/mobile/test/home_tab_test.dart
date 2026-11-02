import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/home_tab.dart';

/// Home against a tiny local server: which top card shows (live, next up or
/// none) and what This week says.
void main() {
  late HttpServer server;
  late List<Map<String, Object?>> sessions;
  final now = DateTime.now();

  Map<String, Object?> session(
          String id, String name, String status, DateTime at,
          {String groupId = 'cheer', Map<String, Object?> extra = const {}}) =>
      {
        'id': id,
        'groupId': groupId,
        'name': name,
        'status': status,
        'scheduledAt': at.toUtc().toIso8601String(),
        'activeMemberCount': 0,
        'isJoined': false,
        ...extra,
      };

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    sessions = [];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      Object body;
      if (req.uri.path == '/api/recordings/sessions') {
        body = {'sessions': sessions};
      } else if (req.uri.path == '/api/groups') {
        body = {
          'groups': [
            {
              'id': 'cheer',
              'name': 'UCF Cheer',
              'role': 'member',
              'primaryColor': '#2563eb',
            },
          ],
        };
      } else if (req.uri.path == '/api/notifications') {
        body = {'notifications': []};
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

  Future<void> show(WidgetTester tester) async {
    tester.view.physicalSize = const Size(420, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final auth = AuthService(
        ApiClient('http://${server.address.address}:${server.port}'));
    await tester.runAsync(() async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: HomeTab(
            auth: auth,
            onOpenSessions: () {},
            onOpenSettings: () {},
            onOpenGroups: () {},
            onOpenCalendar: () {},
          ),
        ),
      ));
      // Let the HTTP round trips finish, then rebuild.
      await Future<void>.delayed(const Duration(milliseconds: 500));
      await tester.pump();
      await tester.pump();
    });
  }

  bool inThisWeek(DateTime at) {
    final monday = DateTime(now.year, now.month, now.day - (now.weekday - 1));
    return !at.isBefore(monday) &&
        at.isBefore(DateTime(monday.year, monday.month, monday.day + 7));
  }

  testWidgets('a live session gets the live card with Join', (tester) async {
    sessions = [
      session('live01', 'Thursday session', 'active',
          now.subtract(const Duration(minutes: 5)),
          extra: {
            'activeMemberCount': 3,
            'activeMemberNames': ['Cara', 'Maya', 'Jo'],
            'recordingCount': 1,
          }),
    ];
    await show(tester);

    expect(find.text('LIVE'), findsOneWidget);
    expect(find.textContaining('UCF Cheer · started'), findsOneWidget);
    expect(find.text('3 devices · 1 recording so far'), findsOneWidget);
    expect(find.text('Join'), findsOneWidget);
    expect(find.textContaining('NEXT UP'), findsNothing);
    // Listed in This week too, as happening now.
    expect(find.text('NOW'), findsOneWidget);
    // Notifications are a section of their own, not a bell up top.
    expect(find.text('Notifications'), findsOneWidget);
  });

  testWidgets('nothing live: the next scheduled session, then This week',
      (tester) async {
    final at = DateTime(now.year, now.month, now.day + 2, 18);
    sessions = [session('next01', 'Dance full run-through', 'scheduled', at)];
    await show(tester);

    expect(find.text('LIVE'), findsNothing);
    expect(find.text('NEXT UP · IN 2 DAYS'), findsOneWidget);
    expect(find.text('Dance full run-through'), findsOneWidget);
    expect(find.textContaining('6:00 PM · UCF Cheer'), findsOneWidget);
    expect(find.text('See in calendar'), findsOneWidget);
    // The card already shows it, so the list doesn't repeat it.
    expect(
      find.text(inThisWeek(at)
          ? 'Nothing else scheduled this week.'
          : 'Nothing scheduled this week.'),
      findsOneWidget,
    );
  });

  testWidgets('nothing live or scheduled: no top card', (tester) async {
    sessions = [
      session('done01', 'Old one', 'complete',
          now.subtract(const Duration(days: 40)),
          extra: {'recordingCount': 2}),
    ];
    await show(tester);

    expect(find.text('LIVE'), findsNothing);
    expect(find.textContaining('NEXT UP'), findsNothing);
    expect(find.text('Nothing scheduled this week.'), findsOneWidget);
    // The finished one is in Recent sessions.
    expect(find.text('Recent sessions'), findsOneWidget);
    expect(find.text('Old one'), findsOneWidget);
    expect(find.text('2 recordings'), findsOneWidget);
  });
}

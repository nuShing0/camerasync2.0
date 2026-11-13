import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/api/recordings_api.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/watch_screen.dart';

/// Posting and deleting comments from the watch screen, against a tiny local
/// server that keeps notes in memory like the real notes routes do.
void main() {
  const startedAt = 1790000000000;
  late HttpServer server;
  late List<Map<String, dynamic>> notes;
  late List<Map<String, dynamic>> posted;
  late bool viewer;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    HttpOverrides.global = null;
    notes = [
      {
        'id': 1,
        'body': 'Watch the left side',
        'videoTimeMs': 5000,
        'author': 'Coach',
        'canDelete': false,
      },
    ];
    posted = [];
    viewer = false;

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      Object? body;
      var status = 200;
      if (path == '/api/recordings/sessions/abc123/videos') {
        body = {
          'session': {'id': 'abc123', 'name': 'Stunt practice'},
          'recordings': [
            {
              'startedAt': startedAt,
              'number': 1,
              'videos': [
                // No url: the tile shows "Not uploaded", so the test needs
                // no video player.
                {'userId': 1, 'name': 'Ryan', 'url': null},
              ],
            },
          ],
        };
      } else if (path == '/api/recordings/sessions/abc123/notes' &&
          req.method == 'GET') {
        expect(req.uri.queryParameters['startedAt'], '$startedAt');
        body = {'notes': notes};
      } else if (path == '/api/recordings/sessions/abc123/notes' &&
          req.method == 'POST') {
        final sent = jsonDecode(await utf8.decoder.bind(req).join())
            as Map<String, dynamic>;
        if (viewer) {
          status = 403;
          body = {'error': "Viewers can't leave notes."};
        } else {
          posted.add(sent);
          notes.add({
            'id': 2,
            'body': sent['body'],
            'videoTimeMs': sent['videoTimeMs'],
            'author': 'Ryan',
            'canDelete': true,
          });
          status = 201;
          body = {'ok': true};
        }
      } else if (path == '/api/recordings/sessions/abc123/notes/2' &&
          req.method == 'DELETE') {
        notes.removeWhere((n) => n['id'] == 2);
        body = {'ok': true};
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

  /// Taps something that talks to the server. The request has to start
  /// outside the test's fake clock or it never reaches the local server.
  Future<void> tapAndWait(WidgetTester tester, Finder finder) async {
    // Typing enables the post button on the next frame.
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(finder);
      await Future<void>.delayed(const Duration(milliseconds: 300));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
  }

  Future<void> openComments(WidgetTester tester) async {
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
    await settle(tester);
    await tester.tap(find.byIcon(Icons.comment_outlined));
    // Let the sheet finish sliding up before tapping inside it.
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> openAddComment(WidgetTester tester) async {
    await openComments(tester);
    await tester.tap(find.byTooltip('Add a comment'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
  }

  Finder post() => find.widgetWithText(FilledButton, 'Post');

  testWidgets('posts a comment stamped at the paused moment', (tester) async {
    await openAddComment(tester);
    expect(find.text('Comment at 00:00'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '  Great catch  ');
    await tapAndWait(tester, post());

    expect(posted, [
      {'startedAt': startedAt, 'body': 'Great catch', 'videoTimeMs': 0},
    ]);
    // The sheet closes, and the new comment is live at the playhead.
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(TextField), findsNothing);
    expect(
        find.textContaining('Great catch', findRichText: true), findsOneWidget);
  });

  testWidgets('a comment pops up at its moment, with delete only when allowed',
      (tester) async {
    await openAddComment(tester);
    // Coach's comment is at 0:05, not at the playhead (0:00), so it isn't
    // showing, and there is no list of comments.
    expect(find.textContaining('Watch the left side', findRichText: true),
        findsNothing);
    expect(find.byTooltip('Delete comment'), findsNothing);

    await tester.enterText(find.byType(TextField), 'Mine');
    await tapAndWait(tester, post());
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('Mine', findRichText: true), findsOneWidget);
    expect(find.byTooltip('Delete comment'), findsOneWidget);

    // It asks first: Cancel keeps it...
    await tapAndWait(tester, find.byTooltip('Delete comment'));
    expect(find.text('Delete this comment?'), findsOneWidget);
    await tapAndWait(tester, find.text('Cancel'));
    expect(find.textContaining('Mine', findRichText: true), findsOneWidget);
    // ...and Delete deletes it.
    await tapAndWait(tester, find.byTooltip('Delete comment'));
    await tapAndWait(tester, find.text('Delete'));
    expect(find.textContaining('Mine', findRichText: true), findsNothing);
    expect(notes.map((n) => n['id']), [1]);
  });

  testWidgets(
      "shows the server's message and keeps the text when posting fails",
      (tester) async {
    viewer = true;
    await openAddComment(tester);

    await tester.enterText(find.byType(TextField), 'Can I comment?');
    await tapAndWait(tester, post());

    expect(find.text("Viewers can't leave notes."), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Can I comment?',
    );
  });

  testWidgets('comment icon lists comments by video timestamp', (tester) async {
    notes = [
      {
        'id': 1,
        'body': 'Later comment',
        'videoTimeMs': 5000,
        'author': 'Coach',
        'canDelete': false,
      },
      {
        'id': 3,
        'body': 'Earlier comment',
        'videoTimeMs': 2000,
        'author': 'Alex',
        'canDelete': false,
      },
    ];

    await openComments(tester);
    expect(find.text('Comments (2)'), findsOneWidget);
    expect(find.text('Alex'), findsOneWidget);
    expect(find.text('Earlier comment'), findsOneWidget);
    expect(find.text('00:02'), findsOneWidget);
    expect(find.text('Coach'), findsOneWidget);
    expect(find.text('Later comment'), findsOneWidget);
    expect(find.text('00:05'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Earlier comment')).dy,
      lessThan(tester.getTopLeft(find.text('Later comment')).dy),
    );
  });
}

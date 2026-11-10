import 'package:camerasync_mobile/api/notifications_api.dart';
import 'package:camerasync_mobile/screens/notifications_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

AppNotification parse(Map<String, dynamic> json) => AppNotification.fromJson({
      'id': 'x',
      'at': '2026-10-09T18:00:00.000Z',
      'unread': true,
      'actor': {'id': 2, 'name': 'Coach Taylor'},
      'group': {'id': 'ucfcheer', 'name': 'UCF Cheer', 'primaryColor': '#ead217'},
      ...json,
    });

void main() {
  test('timeAgo counts up from just now to days, then shows the date', () {
    final now = DateTime(2026, 10, 9, 20);
    DateTime ago(Duration d) => now.subtract(d);
    expect(timeAgo(ago(const Duration(seconds: 20)), now: now), 'just now');
    expect(timeAgo(ago(const Duration(minutes: 5)), now: now), '5m');
    expect(timeAgo(ago(const Duration(hours: 3)), now: now), '3h');
    expect(timeAgo(ago(const Duration(days: 2)), now: now), '2d');
    expect(timeAgo(ago(const Duration(days: 10)), now: now), 'Sep 29');
  });

  test('parses each kind the server sends', () {
    final comment = parse({
      'type': 'comment',
      'session': {'id': 'abc123', 'name': 'Stunt practice', 'status': 'complete'},
      'comment': {'body': 'Lock out the knees', 'videoTimeMs': 12000},
    });
    expect(comment.sessionId, 'abc123');
    expect(comment.commentBody, 'Lock out the knees');
    expect(comment.isLivePractice, isFalse);

    final join = parse({'type': 'join'});
    expect(join.sessionId, isNull);
    expect(join.groupName, 'UCF Cheer');

    final live = parse({
      'type': 'session',
      'session': {'id': 'abc123', 'name': 'Stunt practice', 'status': 'active'},
    });
    expect(live.isLivePractice, isTrue);
  });

  testWidgets('a tile says who did what, and a live practice says so',
      (tester) async {
    final live = parse({
      'type': 'session',
      'session': {'id': 'abc123', 'name': 'Stunt practice', 'status': 'active'},
    });
    var tapped = false;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: NotificationTile(notification: live, onTap: () => tapped = true),
      ),
    ));

    expect(find.textContaining('Coach Taylor started Stunt practice',
        findRichText: true), findsOneWidget);
    expect(find.textContaining('Live now', findRichText: true), findsOneWidget);

    await tester.tap(find.byType(NotificationTile));
    expect(tapped, isTrue);
  });

  testWidgets('a request to join says who asked, for which group',
      (tester) async {
    final request = parse({'type': 'request'});
    expect(request.sessionId, isNull);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: NotificationTile(notification: request, onTap: () {}),
      ),
    ));

    expect(find.textContaining('Coach Taylor asked to join UCF Cheer',
        findRichText: true), findsOneWidget);
  });
}

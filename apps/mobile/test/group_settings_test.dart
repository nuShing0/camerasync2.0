import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/api/groups_api.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/group_settings_screen.dart';
import 'package:camerasync_mobile/screens/groups_screen.dart';
import 'package:camerasync_mobile/team_accent.dart';

/// The group page opened from a group's card, against a small local server.
void main() {
  late HttpServer server;
  late List<Map<String, dynamic>> colorPatches;
  late List<String> leaves;
  late List<String> answered;
  late List<String> resets;

  const cheerAsOwner = Group(
    id: 'ucfcheer',
    name: 'UCF Cheer',
    primaryColor: '#ead217',
    owner: 1,
    role: 'admin',
    inviteCode: 'K7Q2MX',
    inviteUrl: 'https://8kount.app/join/K7Q2MX',
  );
  const pomAsViewer = Group(
    id: 'ucfpom',
    name: 'UCF Pom',
    primaryColor: '#dc2626',
    owner: 2,
    role: 'viewer',
  );
  const danceAsMember = Group(
    id: 'ucfdance',
    name: 'UCF Dance Team',
    primaryColor: '#7c3aed',
    owner: 2,
    role: 'member',
    inviteCode: 'D4NC3R',
    inviteUrl: 'https://8kount.app/join/D4NC3R',
  );

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    HttpOverrides.global = null;
    colorPatches = [];
    leaves = [];
    answered = [];
    resets = [];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      Object body;
      if (path == '/api/auth/me') {
        body = {
          'user': {
            'id': 1,
            'email': 'demo.ryan@knights.ucf.edu',
            'name': 'Ryan',
            'emailVerified': true
          },
        };
      } else if (path.endsWith('/leave') && req.method == 'POST') {
        leaves.add(path);
        body = {'ok': true};
      } else if (path == '/api/groups/ucfcheer/requests') {
        body = {
          'requests': [
            {
              'userId': 7,
              'name': 'Jordan Lee',
              'email': 'jordan@ucf.edu',
              'requestedAt': DateTime.now()
                  .subtract(const Duration(minutes: 5))
                  .toIso8601String(),
            },
          ],
        };
      } else if (path.startsWith('/api/groups/ucfcheer/requests/')) {
        answered.add('${req.method} $path');
        body = {'ok': true};
      } else if (path == '/api/groups/ucfcheer/invite/reset') {
        resets.add(path);
        body = {
          'group': {
            'id': 'ucfcheer',
            'name': 'UCF Cheer',
            'primaryColor': '#ead217',
            'owner': 1,
            'role': 'admin',
            'inviteCode': 'NEW234',
            'inviteUrl': 'https://8kount.app/join/NEW234',
          },
        };
      } else if (path.endsWith('/members')) {
        body = {
          'members': [
            {'id': 1, 'name': 'Ryan Cannon', 'role': 'admin'},
            {'id': 3, 'name': 'Maya Chen', 'role': 'member'},
          ],
        };
      } else if (path == '/api/groups/ucfcheer' && req.method == 'PATCH') {
        final sent = jsonDecode(await utf8.decoder.bind(req).join())
            as Map<String, dynamic>;
        colorPatches.add(sent);
        body = {
          'group': {
            'id': 'ucfcheer',
            'name': 'UCF Cheer',
            'primaryColor': sent['primaryColor'],
            'owner': 1,
            'role': 'admin',
            'inviteCode': 'K7Q2MX',
            'inviteUrl': 'https://8kount.app/join/K7Q2MX',
          },
        };
      } else if (path == '/api/recordings/sessions') {
        body = {
          'sessions': [
            {
              'id': 'abc123',
              'name': 'Stunt practice',
              'status': 'complete',
              'groupId': 'ucfcheer',
              'scheduledAt': '2026-10-07T22:00:00.000Z',
              'totalRecordings': 8,
              'recordingCount': 5,
              'memberCount': 4,
              'activeMemberCount': 0,
              'isJoined': false
            },
            {
              'id': 'liv789',
              'name': 'Pom run-through',
              'status': 'active',
              'groupId': 'ucfpom',
              'activeMemberCount': 3,
              'isJoined': false
            },
            {
              'id': 'def456',
              'name': 'Jazz combo',
              'status': 'complete',
              'groupId': 'ucfdance',
              'scheduledAt': '2026-10-06T22:00:00.000Z',
              'activeMemberCount': 0,
              'isJoined': false
            },
          ],
        };
      } else if (path == '/api/groups') {
        body = {
          'groups': [
            {
              'id': 'ucfcheer',
              'name': 'UCF Cheer',
              'primaryColor': '#ead217',
              'owner': 1,
              'role': 'admin'
            },
            {
              'id': 'ucfpom',
              'name': 'UCF Pom',
              'primaryColor': '#dc2626',
              'owner': 2,
              'role': 'viewer'
            },
          ],
        };
      } else {
        req.response.statusCode = 404;
        body = {'error': 'not found'};
      }
      req.response
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(body));
      await req.response.close();
    });
  });

  tearDown(() => server.close(force: true));

  Future<AuthService> signedIn() async {
    final auth = AuthService(
        ApiClient('http://${server.address.address}:${server.port}'));
    await auth.restoreSession();
    return auth;
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 400)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
  }

  Future<AuthService> open(WidgetTester tester, Group group) async {
    late AuthService auth;
    await tester.runAsync(() async {
      auth = await signedIn();
      await tester.pumpWidget(
          MaterialApp(home: GroupSettingsScreen(auth: auth, group: group)));
    });
    await settle(tester);
    return auth;
  }

  Future<void> openTab(WidgetTester tester) async {
    late AuthService auth;
    await tester.runAsync(() async {
      auth = await signedIn();
      await tester.pumpWidget(MaterialApp(
        home: TeamAccentScope(
            auth: auth, child: Scaffold(body: GroupsScreen(auth: auth))),
      ));
    });
    await settle(tester);
  }

  testWidgets('group cards show the role and the live session or count',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 4000);
    addTearDown(tester.view.resetPhysicalSize);
    await openTab(tester);

    expect(find.text('2 groups · hold to reorder'), findsOneWidget);
    expect(find.text('Join group'), findsOneWidget);
    expect(find.text('Create group'), findsOneWidget);

    // UCF Cheer: the user owns it, and it's the primary group (first one).
    expect(find.text('Owner'), findsOneWidget);
    expect(find.text('Primary'), findsOneWidget);
    expect(find.text('ID ucfcheer'), findsNothing);
    expect(find.textContaining('1 session · last Oct'), findsOneWidget);

    // UCF Pom has a session going.
    expect(find.text('Viewer'), findsOneWidget);
    expect(find.text('Live · Pom run-through'), findsOneWidget);
    expect(find.byIcon(Icons.drag_indicator), findsNWidgets(2));
  });

  testWidgets('Join group opens the invite field on its own screen',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 4000);
    addTearDown(tester.view.resetPhysicalSize);
    await openTab(tester);

    expect(find.text('Enter a code or paste a link'), findsNothing);
    await tester.tap(find.text('Join group'));
    await tester.pumpAndSettle();
    expect(find.text('Enter a code or paste a link'), findsOneWidget);
    expect(find.text('Scan QR'), findsOneWidget);
  });

  testWidgets('the primary group says so on its banner', (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.runAsync(() async {
      final auth = await signedIn();
      await tester.pumpWidget(MaterialApp(
        home: TeamAccentScope(
            auth: auth,
            child: GroupSettingsScreen(auth: auth, group: cheerAsOwner)),
      ));
    });
    await settle(tester);

    expect(find.text('Your primary group'), findsOneWidget);
    // The back pill; there's no make-primary button here any more.
    expect(find.text('Groups'), findsOneWidget);
    expect(find.text('Make this my primary group'), findsNothing);
  });

  testWidgets('a live session shows on the group page with Join',
      (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, pomAsViewer);

    expect(find.text('Pom run-through'), findsOneWidget);
    expect(find.text('3 devices connected'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Join'), findsOneWidget);
    expect(find.text('Start a session'), findsNothing);
    expect(find.textContaining('An admin starts sessions'), findsNothing);
  });

  testWidgets('finished sessions show as tiles with recordings and cameras',
      (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, cheerAsOwner);

    expect(find.text('View all'), findsOneWidget);
    expect(find.text('5 recordings'), findsOneWidget);
    expect(find.textContaining('· 4 cameras'), findsOneWidget);
  });

  testWidgets('See all lists every member, and details name the owner',
      (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, cheerAsOwner);

    expect(find.text('RC'), findsOneWidget);
    expect(find.text('MC'), findsOneWidget);
    await tester.tap(find.text('See all'));
    await tester.pumpAndSettle();
    expect(find.text('Members (2)'), findsOneWidget);
    expect(find.text('Maya Chen'), findsOneWidget);
    // Roles are managed here too.
    expect(find.byTooltip('Remove Maya Chen from group'), findsOneWidget);

    // Back to the group with the pill, then its details.
    await tester.tap(find.text('UCF Cheer'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Group details'));
    await tester.pumpAndSettle();
    expect(find.text('ucfcheer'), findsOneWidget);
    expect(find.text('Ryan Cannon'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
    expect(
        find.textContaining('make them the owner in Members'), findsOneWidget);
  });

  testWidgets('admins and owners can change the team color', (tester) async {
    // Tall enough that the list builds every section.
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, cheerAsOwner);

    expect(find.text('Team color'), findsOneWidget);
    expect(find.textContaining("You're the owner"), findsOneWidget);
    expect(find.textContaining('2 members'), findsOneWidget);
    expect(find.text('Members (2)'), findsOneWidget);
    // The owner gets a role dropdown and a red remove button for Maya.
    expect(find.byType(DropdownButton<String>), findsOneWidget);
    expect(find.byTooltip('Remove Maya Chen from group'), findsOneWidget);

    // The picker is its own screen, from the Team color row.
    await tester.tap(find.text('Team color'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Team color Navy'));
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(find.text('Save color'));
      await Future<void>.delayed(const Duration(milliseconds: 400));
    });
    await settle(tester);

    expect(colorPatches, [
      {'primaryColor': '#1e3a8a'},
    ]);
  });

  testWidgets('members do not see the color picker or member controls',
      (tester) async {
    // Tall enough that the list builds every section.
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, danceAsMember);

    expect(find.text('Team color'), findsNothing);
    expect(find.textContaining("You're a member"), findsOneWidget);
    expect(find.byIcon(Icons.remove), findsNothing);
    expect(find.byType(DropdownButton<String>), findsNothing);
    // The primary group is picked in Settings, not here.
    expect(find.text('Make this my primary group'), findsNothing);
  });

  testWidgets(
      'the owner gets group details and delete, and hands over from Members',
      (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, cheerAsOwner);

    expect(find.text('Group details'), findsOneWidget);
    // Just the button at the bottom; there's no separate hand-over box.
    expect(find.text('Delete group'), findsOneWidget);
    expect(find.text('Hand over'), findsNothing);
    expect(find.text('Leave group'), findsNothing);

    // Owner is one of the roles the owner can pick for a member.
    final before = find.text('Owner').evaluate().length;
    await tester.tap(find.text('Member').first);
    await tester.pumpAndSettle();
    expect(find.text('Owner').evaluate().length, greaterThan(before));
  });

  testWidgets('a member can leave after confirming', (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, danceAsMember);

    expect(find.text('Delete group'), findsNothing);
    // Started on the real clock, so the request after the dialog can run.
    await tester.runAsync(() async {
      await tester.tap(find.widgetWithText(TextButton, 'Leave group'));
    });
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      await tester.tap(find.widgetWithText(FilledButton, 'Leave'));
      await Future<void>.delayed(const Duration(milliseconds: 400));
    });
    await settle(tester);

    expect(leaves, ['/api/groups/ucfdance/leave']);
  });

  testWidgets('a group card opens its page by tapping it, with no gear',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 4000);
    addTearDown(tester.view.resetPhysicalSize);
    late AuthService auth;
    await tester.runAsync(() async {
      auth = await signedIn();
      await tester.pumpWidget(
          MaterialApp(home: Scaffold(body: GroupsScreen(auth: auth))));
    });
    await settle(tester);

    // The whole card is the way in: no gear, no separate Recordings button.
    expect(find.byIcon(Icons.settings_outlined), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Recordings'), findsNothing);
    expect(
        find.ancestor(
            of: find.text('UCF Cheer'), matching: find.byType(InkWell)),
        findsWidgets);
  });

  testWidgets(
      'the group page lists only its recordings and lets admins start a session',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 4000);
    addTearDown(tester.view.resetPhysicalSize);
    await open(tester, cheerAsOwner);
    await settle(tester);

    expect(find.text('Stunt practice'), findsOneWidget);
    expect(find.text('Jazz combo'), findsNothing);
    expect(find.text('Start a session'), findsOneWidget);
    expect(find.text('Everyone in UCF Cheer can join with their phone.'),
        findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Start'), findsOneWidget);
  });

  testWidgets('members are told an admin starts sessions', (tester) async {
    tester.view.physicalSize = const Size(1080, 4000);
    addTearDown(tester.view.resetPhysicalSize);
    await open(tester, danceAsMember);
    await settle(tester);

    expect(find.text('Start a session'), findsNothing);
    expect(find.textContaining('An admin starts sessions'), findsOneWidget);
  });

  testWidgets('everyone in the group sees the invite; only admins can reset it',
      (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, danceAsMember);

    // No privacy left anywhere: the banner is the ID, your role and the
    // head count.
    expect(find.textContaining('Private'), findsNothing);
    expect(find.textContaining('Public'), findsNothing);

    expect(find.text('Invite people'), findsOneWidget);
    await tester.tap(find.text('Invite people'));
    await tester.pumpAndSettle();
    expect(find.text('D4N-C3R'), findsOneWidget);
    expect(find.text('Share'), findsOneWidget);
    expect(find.text('Copy link'), findsOneWidget);
    expect(find.text('Show QR'), findsOneWidget);
    expect(find.text('Reset invite'), findsNothing);
  });

  testWidgets('an admin resets the invite after confirming', (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, cheerAsOwner);

    await tester.tap(find.text('Invite people'));
    await tester.pumpAndSettle();
    expect(find.text('K7Q-2MX'), findsOneWidget);
    // Started on the real clock, so the request after the dialog can run.
    await tester.runAsync(() async {
      await tester.tap(find.text('Reset invite'));
    });
    await tester.pumpAndSettle();
    expect(find.textContaining('The old link, code and QR stop working'),
        findsOneWidget);
    await tester.runAsync(() async {
      await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
      await Future<void>.delayed(const Duration(milliseconds: 400));
    });
    await settle(tester);

    expect(resets, ['/api/groups/ucfcheer/invite/reset']);
    expect(find.text('NEW-234'), findsOneWidget);
  });

  testWidgets('admins see requests to join and can approve them',
      (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, cheerAsOwner);

    expect(find.text('Requests to join (1)'), findsOneWidget);
    expect(find.text('Jordan Lee'), findsOneWidget);
    expect(find.text('Asked 5m ago'), findsOneWidget);

    await tester.runAsync(() async {
      await tester.tap(find.widgetWithText(FilledButton, 'Approve'));
      await Future<void>.delayed(const Duration(milliseconds: 400));
    });
    // The roster loads again with them in it, on the real clock.
    await tester.runAsync(() async {
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 400));
    });
    await settle(tester);
    expect(answered, ['POST /api/groups/ucfcheer/requests/7/approve']);
    // The last one answered, so the section goes away.
    expect(find.text('Requests to join (1)'), findsNothing);
  });

  testWidgets('members never see requests to join', (tester) async {
    tester.view.physicalSize = const Size(800, 3600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await open(tester, danceAsMember);

    expect(find.textContaining('Requests to join'), findsNothing);
  });
}

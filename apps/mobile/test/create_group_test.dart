import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:camerasync_mobile/api/api_client.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/screens/groups_screen.dart';

/// Scripted server for the groups endpoints: holds the user's groups in
/// memory and enforces the same create rules as POST /api/groups.
class _FakeApi extends ApiClient {
  _FakeApi() : super('http://test');

  final groups = <Map<String, dynamic>>[];
  final created = <Map<String, dynamic>>[];

  @override
  Future<dynamic> get(String path) async {
    if (path == '/api/groups') return {'groups': groups};
    throw ApiException(404, 'Unexpected call to $path');
  }

  @override
  Future<dynamic> post(String path, [Map<String, dynamic>? body]) async {
    if (path != '/api/groups') {
      throw ApiException(404, 'Unexpected call to $path');
    }
    if (body!['name'] == 'Broken') {
      throw ApiException(500, 'Unable to create group.');
    }
    created.add(body);
    // The server makes the ID from the name.
    final group = {
      'id': '${(body['name'] as String).toLowerCase().replaceAll(RegExp('[^a-z0-9]'), '')}k7q',
      'name': body['name'],
      'role': 'admin',
      'inviteCode': 'K7Q2MX',
      'inviteUrl': 'https://8kount.app/join/K7Q2MX',
    };
    groups.insert(0, group);
    return {'group': group};
  }
}

void main() {
  Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

  Future<_FakeApi> openDialog(WidgetTester tester) async {
    final api = _FakeApi();
    await tester.pumpWidget(wrap(GroupsScreen(auth: AuthService(api))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create a group'));
    await tester.pumpAndSettle();
    return api;
  }

  Finder field(String label) => find.descendant(
        of: find
            .ancestor(of: find.text(label), matching: find.byType(Column))
            .first,
        matching: find.byType(TextField),
      );

  testWidgets('empty groups list offers Create a group', (tester) async {
    await tester.pumpWidget(
      wrap(GroupsScreen(auth: AuthService(_FakeApi()))),
    );
    await tester.pumpAndSettle();

    expect(find.text('No groups yet'), findsOneWidget);
    expect(find.text('Create a group'), findsOneWidget);
    // And the pill at the top, beside Join group.
    expect(find.text('Create group'), findsOneWidget);
    expect(find.text('Join group'), findsOneWidget);
  });

  testWidgets('creates a group, shows its invite, and lists it',
      (tester) async {
    final api = await openDialog(tester);

    await tester.enterText(field('Group Name'), 'Team Knightro');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();

    expect(api.created.single, {
      'name': 'Team Knightro',
      'primaryColor': '#ead217',
    });
    expect(find.byType(Dialog), findsNothing);
    // Straight to inviting the team.
    expect(find.text('Invite your team'), findsOneWidget);
    expect(find.text('K7Q-2MX'), findsOneWidget);
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.text('Team Knightro'), findsOneWidget);
    expect(find.text('Admin'), findsOneWidget);
  });

  testWidgets('asks only for a name and a color, not an ID', (tester) async {
    await openDialog(tester);

    expect(find.text('Group ID'), findsNothing);
  });

  testWidgets('there is no public/private choice or password', (tester) async {
    await openDialog(tester);

    expect(find.text('Private group'), findsNothing);
    expect(find.text('Group Password'), findsNothing);
  });

  testWidgets('shows the server error and stays open', (tester) async {
    await openDialog(tester);

    await tester.enterText(field('Group Name'), 'Broken');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();

    expect(find.text('Unable to create group.'), findsOneWidget);
    expect(find.byType(Dialog), findsOneWidget);
  });
}

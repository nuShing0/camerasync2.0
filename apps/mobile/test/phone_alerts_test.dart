import 'package:camerasync_mobile/api/notifications_api.dart';
import 'package:camerasync_mobile/auth/auth_service.dart';
import 'package:camerasync_mobile/notifications/phone_alerts.dart';
import 'package:flutter_test/flutter_test.dart';

AppNotification note(String type, {String? status}) => AppNotification.fromJson({
      'id': 'x',
      'type': type,
      'at': '2026-10-09T18:00:00.000Z',
      'unread': true,
      'actor': {'id': 2, 'name': 'Coach Taylor'},
      'group': {'id': 'ucfcheer', 'name': 'UCF Cheer'},
      if (type != 'join' && type != 'request')
        'session': {'id': 'abc123', 'name': 'Stunt practice', 'status': status ?? 'complete'},
      if (type == 'comment') 'comment': {'body': 'Lock out the knees', 'videoTimeMs': 0},
    });

void main() {
  test('everything is on until a switch is turned off', () {
    final user = AppUser.fromJson({'id': 1, 'email': 'a@ucf.edu'});
    expect(wanted(note('comment'), user.notificationPrefs), isTrue);
    expect(wanted(note('join'), user.notificationPrefs), isTrue);
  });

  test('each kind has its own switch, and push turns them all off', () {
    final prefs = AppUser.fromJson({
      'id': 1,
      'email': 'a@ucf.edu',
      'notificationPrefs': {'push': true, 'comments': false, 'joins': true, 'sessions': true},
    }).notificationPrefs;
    expect(wanted(note('comment'), prefs), isFalse);
    expect(wanted(note('join'), prefs), isTrue);
    expect(wanted(note('session'), prefs), isTrue);
    expect(wanted(note('session'), {...prefs, 'push': false}), isFalse);
  });

  test('alerts say who did what', () {
    expect(alertTitle(note('comment')), 'Coach Taylor commented on Stunt practice');
    expect(alertBody(note('comment')), '"Lock out the knees"');
    expect(alertTitle(note('join')), 'Coach Taylor joined UCF Cheer');
    expect(alertTitle(note('session', status: 'active')),
        'Coach Taylor started Stunt practice. Join now');
  });

  test('requests to join follow the joins switch and read sensibly', () {
    expect(wanted(note('request'), const {}), isTrue);
    expect(wanted(note('request'), const {'joins': false}), isFalse);
    expect(wanted(note('request'), const {'sessions': false}), isTrue);
    expect(alertTitle(note('request')), 'Coach Taylor asked to join UCF Cheer');
    expect(alertBody(note('request')), "Approve or decline it on the group's page.");
  });
}

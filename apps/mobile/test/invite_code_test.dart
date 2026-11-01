import 'package:camerasync_mobile/groups/invite_code.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reads a bare code, any case, with or without the dash', () {
    expect(inviteCodeFrom('ABC-DEF'), 'ABCDEF');
    expect(inviteCodeFrom(' abcdef '), 'ABCDEF');
    expect(inviteCodeFrom('abc def'), 'ABCDEF');
  });

  test('reads the code out of web and app links', () {
    expect(inviteCodeFrom('https://8kount.app/join/K7Q2MX'), 'K7Q2MX');
    expect(inviteCodeFrom('https://8kount.app/join/k7q-2mx?utm=sms#top'),
        'K7Q2MX');
    expect(
        inviteCodeFrom(
            'Join UCF Cheer on 8kount: https://8kount.app/join/K7Q2MX'),
        'K7Q2MX');
    expect(inviteCodeFrom('eightkount://join/K7Q2MX'), 'K7Q2MX');
  });

  test('anything else is not a code', () {
    expect(inviteCodeFrom(''), isNull);
    expect(inviteCodeFrom('ABC-DE'), isNull);
    expect(inviteCodeFrom('ucfcheer'), isNull);
    expect(inviteCodeFrom('https://8kount.app/join/'), isNull);
    expect(inviteCodeFrom('https://8'), isNull);
    expect(inviteCodeFrom('8kount.app'), isNull);
  });

  test('codes show as ABC-DEF', () {
    expect(formatInviteCode('ABCDEF'), 'ABC-DEF');
  });
}

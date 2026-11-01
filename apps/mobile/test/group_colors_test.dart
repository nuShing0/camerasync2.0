import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:camerasync_mobile/api/groups_api.dart';
import 'package:camerasync_mobile/theme.dart';

void main() {
  test('parses #rrggbb team colors and rejects anything else', () {
    expect(parseHexColor('#ead217'), const Color(0xFFEAD217));
    expect(parseHexColor('#7C3AED'), const Color(0xFF7C3AED));
    expect(parseHexColor('#fff'), isNull);
    expect(parseHexColor('gold'), isNull);
    expect(parseHexColor(null), isNull);
  });

  test('puts black text on light colors and white on dark ones', () {
    expect(inkOn(const Color(0xFFEAD217)), Colors.black);
    expect(inkOn(const Color(0xFF0EA5E9)), Colors.black);
    expect(inkOn(const Color(0xFF002D72)), Colors.white);
    expect(inkOn(const Color(0xFF7C3AED)), Colors.white);
  });

  test('keeps black or white text readable on every team color', () {
    for (final (name, hex) in kTeamColors) {
      final color = parseHexColor(hex)!;
      final ink = inkOn(color);
      final hi = [color.computeLuminance(), ink.computeLuminance()]..sort();
      expect((hi[1] + 0.05) / (hi[0] + 0.05), greaterThanOrEqualTo(4.5),
          reason: name);
    }
  });

  test('reads the team color from the groups API', () {
    final group = Group.fromJson({
      'id': 'ucfcheer',
      'name': 'UCF Cheer',
      'primaryColor': '#ead217',
    });
    expect(group.primaryColor, '#ead217');
  });
}

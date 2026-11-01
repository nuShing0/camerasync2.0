import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'invite_code.dart';

/// Invite links that open the app: eightkount://join/<CODE>, from the "Open in
/// the app" button on the web's join page. The code waits in [pending]
/// until the signed-in app shows its preview (HomeShell), so a link opened
/// while signed out shows once the user has signed in. It's saved too, in
/// case the app is closed before then (say, to find the sign-up code in
/// email).
class InviteLinks {
  InviteLinks._();

  static final instance = InviteLinks._();

  static const _savedKey = 'inviteLinks.pendingCode';

  /// The invite code from the last link opened, until [take]n.
  final pending = ValueNotifier<String?>(null);

  StreamSubscription<String>? _links;

  /// Listens for links, both the one that launched the app and any opened
  /// while it runs. Call once at start-up.
  Future<void> start() async {
    if (_links != null) return;
    // Strings rather than app_links' Uris, so anything with /join/<CODE> in
    // it counts, whatever its scheme or host.
    _links = AppLinks().stringLinkStream.listen(_opened, onError: (_) {});
    try {
      final saved =
          (await SharedPreferences.getInstance()).getString(_savedKey);
      pending.value ??= saved;
    } catch (_) {
      // Nothing saved to come back to.
    }
  }

  Future<void> _opened(String link) async {
    final code = inviteCodeFrom(link);
    if (code == null) return;
    pending.value = code;
    try {
      await (await SharedPreferences.getInstance()).setString(_savedKey, code);
    } catch (_) {}
  }

  /// The waiting code, now being shown, so it's cleared.
  String? take() {
    final code = pending.value;
    if (code == null) return null;
    pending.value = null;
    SharedPreferences.getInstance()
        .then((prefs) => prefs.remove(_savedKey))
        .catchError((_) => false);
    return code;
  }
}

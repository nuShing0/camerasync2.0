import 'dart:async';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/notifications_api.dart';
import '../auth/auth_service.dart';

/// Phone notifications for what happens in the user's groups: comments on
/// recordings, people joining or asking to join, and sessions starting,
/// filtered by the switches in Settings (saved on the account).
///
/// The app checks the notifications feed every minute while it is open or
/// in the background. Alerts while the app is fully closed need push through
/// Firebase Cloud Messaging, which needs a Firebase project for the app; the
/// same saved switches will apply to it.
class PhoneAlerts {
  PhoneAlerts(this._auth);

  final AuthService _auth;
  final _plugin = FlutterLocalNotificationsPlugin();
  Timer? _timer;
  bool _ready = false;

  static const _seenKey = 'phoneAlerts.lastAlertedAt';
  static const _checkEvery = Duration(minutes: 1);

  static const _channel = AndroidNotificationDetails(
    'group-activity',
    'Group activity',
    channelDescription:
        'Comments, people joining or asking to join, and sessions starting',
    importance: Importance.high,
    priority: Priority.high,
    // The status bar needs a white-on-transparent icon; the full-color app
    // icon would show as a plain white square.
    icon: 'ic_stat_8kount',
  );

  static const _details = NotificationDetails(
    android: _channel,
    iOS: DarwinNotificationDetails(),
  );

  Future<void> start() async {
    if (!_ready) {
      await _plugin.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('ic_stat_8kount'),
          // Asked for in requestPermission, from Settings, not at launch.
          iOS: DarwinInitializationSettings(
            requestAlertPermission: false,
            requestBadgePermission: false,
            requestSoundPermission: false,
          ),
        ),
      );
      _ready = true;
    }
    _timer?.cancel();
    _timer = Timer.periodic(_checkEvery, (_) => check());
    unawaited(check());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// Asks for permission to show notifications (Android 13+ and iPhone).
  /// Returns whether they're allowed.
  Future<bool> requestPermission() async {
    final ios = _plugin.resolvePlatformSpecificImplementation<
        IOSFlutterLocalNotificationsPlugin>();
    if (ios != null) {
      return await ios.requestPermissions(
              alert: true, badge: true, sound: true) ??
          false;
    }
    final android = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    return await android?.requestNotificationsPermission() ?? true;
  }

  /// Shows anything new since the last check that the user wants to hear
  /// about. The first check only notes the time, so a fresh install doesn't
  /// replay old activity.
  Future<void> check() async {
    final user = _auth.user;
    if (user == null) return;
    final store = await SharedPreferences.getInstance();
    final last = store.getInt(_seenKey);
    final now = DateTime.now().millisecondsSinceEpoch;
    if (last == null) {
      await store.setInt(_seenKey, now);
      return;
    }

    List<AppNotification> items;
    try {
      items = await NotificationsApi(_auth.api).getNotifications(limit: 20);
    } catch (_) {
      return; // Offline or signed out; try again next minute.
    }

    final prefs = user.notificationPrefs;
    final fresh = items
        .where((n) => n.at.millisecondsSinceEpoch > last)
        .toList()
      ..sort((a, b) => a.at.compareTo(b.at));
    if (fresh.isEmpty) return;
    await store.setInt(_seenKey, fresh.last.at.millisecondsSinceEpoch);
    if (prefs['push'] == false) return;

    for (final n in fresh) {
      if (!wanted(n, prefs)) continue;
      await _plugin.show(
        id: n.id.hashCode,
        title: alertTitle(n),
        body: alertBody(n),
        notificationDetails: _details,
      );
    }
  }
}

/// Whether the user's switches let [n] through.
bool wanted(AppNotification n, Map<String, bool> prefs) {
  if (prefs['push'] == false) return false;
  final kind = switch (n.type) {
    'comment' => 'comments',
    // Requests to join go with the joins switch, as on the server.
    'join' || 'request' => 'joins',
    _ => 'sessions',
  };
  return prefs[kind] != false;
}

String alertTitle(AppNotification n) => switch (n.type) {
      'comment' => '${n.actorName} commented on ${n.sessionName ?? 'a recording'}',
      'join' => '${n.actorName} joined ${n.groupName}',
      'request' => '${n.actorName} asked to join ${n.groupName}',
      _ => n.isLivePractice
          ? '${n.actorName} started ${n.sessionName ?? 'a session'}. Join now'
          : '${n.actorName} started ${n.sessionName ?? 'a session'}',
    };

String? alertBody(AppNotification n) => switch (n.type) {
      'comment' => '"${n.commentBody}"',
      'request' => "Approve or decline it on the group's page.",
      _ => n.groupName,
    };

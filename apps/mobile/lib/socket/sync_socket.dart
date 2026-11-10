import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'events.dart';

/// A user connected to the live session room, as sent by the server's
/// `session:members` payload (the `publicUser` shape: id, email, name, plus
/// whether they're recording).
class SessionMember {
  const SessionMember({
    required this.id,
    required this.email,
    this.name,
    this.camera = true,
    this.roundTripMs,
  });

  final int id;
  final String email;
  final String? name;

  /// False for a host or admin running the session without recording.
  final bool camera;

  /// How long their connection takes to answer the server, timed by the
  /// server every few seconds (their slowest device); null until it has.
  final int? roundTripMs;

  String get displayName => (name != null && name!.isNotEmpty) ? name! : email;

  factory SessionMember.fromJson(Map json) => SessionMember(
        id: (json['id'] as num).toInt(),
        email: (json['email'] ?? '').toString(),
        name: json['name'] as String?,
        camera: json['camera'] != false,
        roundTripMs: (json['roundTripMs'] as num?)?.toInt(),
      );
}

/// A synchronized start command, expressed in both clocks.
///
/// [serverStartAtEpochMs] is the instant the server chose, on the server
/// clock. Every device in the session receives the same value, and it is the
/// key the server files uploaded videos under, so it must be passed back
/// unchanged when the recording is uploaded. [localStartAtEpochMs] is that
/// same instant on this device's clock, for scheduling the actual start.
class RecordingStartCommand {
  const RecordingStartCommand({
    required this.serverStartAtEpochMs,
    required this.localStartAtEpochMs,
    this.recordingNumber,
    this.localBeepAtEpochMs,
  });

  final int serverStartAtEpochMs;
  final int localStartAtEpochMs;

  /// When the device that started the take plays the sync beep, on this
  /// device's clock. Null from servers that predate the beep.
  final int? localBeepAtEpochMs;

  /// 1-based position of this recording within the session ("Recording 3"),
  /// as persisted by the server. Null for start commands that predate it.
  final int? recordingNumber;
}

/// A stop command. Cameras keep rolling until [localStopAtEpochMs] (this
/// device's clock), so every one of them records the end beep, which the
/// device that pressed Stop plays at [localEndBeepAtEpochMs]. Both are null
/// from servers that stop at once, and the end beep is null for a take
/// cancelled before its start.
class RecordingStopCommand {
  const RecordingStopCommand({
    this.serverStartAtEpochMs,
    this.localStopAtEpochMs,
    this.localEndBeepAtEpochMs,
  });

  /// The take being stopped, when the server said.
  final int? serverStartAtEpochMs;
  final int? localStopAtEpochMs;
  final int? localEndBeepAtEpochMs;
}

/// Result of the `session:join` ack.
class JoinResult {
  const JoinResult({
    required this.ok,
    this.error,
    this.sessionName,
    this.canControl = false,
    this.createdBy,
  });

  final bool ok;
  final String? error;
  final String? sessionName;

  /// The user who started the session (its host).
  final int? createdBy;

  /// This user may start and stop takes for everyone: the session's creator,
  /// or an admin or the owner of its group.
  final bool canControl;
}

/// Wraps the Socket.IO connection to the 8kount server and estimates this
/// device's clock offset from the shared server clock.
///
/// The server authenticates the socket handshake with the same session cookie
/// as the REST API, so [cookie] must be the logged-in `session=...` pair.
///
/// Clock sync happens over the server's HTTP `/timesync` endpoint (the same
/// one the web app uses) — NTP-style round trips, keeping the sample with the
/// lowest RTT. When the admin starts recording, the server broadcasts a single
/// future `startAtEpochMs` on the *server* clock; [serverToLocal] converts it
/// to this device's clock so every device fires at the same real instant.
class SyncSocket {
  SyncSocket(this.serverUrl, {this.cookie});

  final String serverUrl;

  /// The `session=...` cookie pair from [ApiClient]. Without it the server
  /// rejects the handshake with "Not authenticated".
  final String? cookie;

  io.Socket? _socket;

  /// localTime ≈ serverTime + _clockOffsetMs
  int _clockOffsetMs = 0;
  bool _clockSynced = false;

  int get clockOffsetMs => _clockOffsetMs;
  bool get clockSynced => _clockSynced;

  final _members = StreamController<List<SessionMember>>.broadcast();
  final _recordingStart = StreamController<RecordingStartCommand>.broadcast();
  final _recordingStop = StreamController<RecordingStopCommand>.broadcast();
  final _cameraDropped = StreamController<SessionMember>.broadcast();
  final _sessionClosed = StreamController<void>.broadcast();
  final _errors = StreamController<String>.broadcast();
  final _connection = StreamController<bool>.broadcast();

  /// Connected users in the joined session.
  Stream<List<SessionMember>> get members => _members.stream;

  /// Emits each synchronized start command, carrying the server's start time
  /// and its conversion to this device's clock.
  Stream<RecordingStartCommand> get recordingStart => _recordingStart.stream;

  /// Emits each stop command.
  Stream<RecordingStopCommand> get recordingStop => _recordingStop.stream;

  /// Emits who dropped out when another camera's app left the screen
  /// mid-take and its recording stopped.
  Stream<SessionMember> get cameraDropped => _cameraDropped.stream;

  /// Emits when the host ends the session.
  Stream<void> get sessionClosed => _sessionClosed.stream;

  /// Connection-level errors (e.g. rejected handshake).
  Stream<String> get errors => _errors.stream;

  /// After the first connect: false when the connection drops (bad Wi-Fi, a
  /// server restart) while it keeps retrying, true once it's back and has
  /// rejoined the session.
  Stream<bool> get connection => _connection.stream;

  bool get connected => _socket?.connected ?? false;

  /// The session this socket last joined, and whether as a camera. The
  /// server forgets a connection's room when it drops (bad Wi-Fi, a server
  /// restart), so it's joined again on reconnect.
  String? _sessionId;
  bool _sessionCamera = true;

  /// Connects the socket and runs the first clock sync. Completes once the
  /// socket is connected (or throws on a rejected handshake/timeout).
  Future<void> connect({
    Duration timeout = const Duration(seconds: 10),
  }) async {
    final connectCompleter = Completer<void>();

    final socket = io.io(
      serverUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          // The Dart client doesn't send cookies on its own the way a browser
          // does, so replay the API session cookie by hand.
          .setExtraHeaders({if (cookie != null) 'Cookie': cookie!})
          .disableAutoConnect()
          .build(),
    );
    _socket = socket;

    socket.onConnect((_) {
      if (!connectCompleter.isCompleted) {
        connectCompleter.complete();
        return;
      }
      // Reconnected: back into the session, falling in with a take that
      // started while the connection was down.
      final sessionId = _sessionId;
      if (sessionId == null) {
        _connection.add(true);
      } else {
        unawaited(joinSession(sessionId, camera: _sessionCamera)
            .then((result) => _connection.add(result.ok)));
      }
    });

    socket.onDisconnect((_) {
      if (connectCompleter.isCompleted) _connection.add(false);
    });

    socket.onConnectError((err) {
      final message = _connectErrorMessage(err);
      if (!connectCompleter.isCompleted) {
        _errors.add(message);
        connectCompleter.completeError(SyncSocketException(message));
        return;
      }
      // The server turned the connection away (e.g. the login expired):
      // retrying won't help. Anything else is a dropped connection that
      // socket.io keeps retrying.
      if (err is Map) {
        _errors.add(message);
      } else {
        _connection.add(false);
      }
    });

    socket.on(Events.sessionMembers, (data) {
      if (data is! List) return;
      _members.add(
        data.whereType<Map>().map(SessionMember.fromJson).toList(),
      );
    });

    socket.on(Events.recordingStarted, (data) {
      if (data is! Map) return;
      final serverStart = (data['startAtEpochMs'] as num?)?.toInt();
      if (serverStart != null) {
        _recordingStart.add(_startCommand(
          serverStart,
          recordingNumber: (data['recordingNumber'] as num?)?.toInt(),
          serverBeepAtEpochMs: (data['beepAtEpochMs'] as num?)?.toInt(),
        ));
      }
    });

    socket.on(Events.recordingStopped, (data) {
      int? field(String key) =>
          data is Map ? (data[key] as num?)?.toInt() : null;
      final stopAt = field('stopAtEpochMs');
      final endBeepAt = field('endBeepAtEpochMs');
      _recordingStop.add(RecordingStopCommand(
        serverStartAtEpochMs: field('startAtEpochMs'),
        localStopAtEpochMs: stopAt == null ? null : serverToLocal(stopAt),
        localEndBeepAtEpochMs:
            endBeepAt == null ? null : serverToLocal(endBeepAt),
      ));
    });

    socket.on(Events.cameraDropped, (data) {
      final user = data is Map ? data['user'] : null;
      if (user is Map && user['id'] is num) {
        _cameraDropped.add(SessionMember.fromJson(user));
      }
    });

    socket.on(Events.closeSession, (_) => _sessionClosed.add(null));

    socket.connect();

    // Clock sync is plain HTTP, so it can run while the socket connects.
    await Future.wait([
      connectCompleter.future.timeout(
        timeout,
        onTimeout: () =>
            throw SyncSocketException("Can't reach the server at $serverUrl."),
      ),
      syncClock(),
    ]);
  }

  static String _connectErrorMessage(dynamic err) {
    if (err is Map && err['message'] is String) return err['message'] as String;
    final text = err?.toString() ?? '';
    if (text.contains('Not authenticated')) {
      return 'Not authenticated — please sign in again.';
    }
    return text.isEmpty ? 'Unable to connect to the server.' : text;
  }

  /// NTP-style clock sync against the server's `/timesync` endpoint (the
  /// `timesync` package's JSON-RPC handler). Runs [rounds] round trips and
  /// keeps the offset from the lowest-RTT sample, assuming a symmetric path:
  /// offset = (t0 + rtt/2) - serverTime.
  Future<void> syncClock({int rounds = 5}) async {
    int? bestRtt;
    int? bestOffset;

    for (var i = 0; i < rounds; i++) {
      try {
        final t0 = DateTime.now().millisecondsSinceEpoch;
        final res = await http
            .post(
              Uri.parse('$serverUrl/timesync'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({
                'jsonrpc': '2.0',
                'id': i,
                'method': 'timesync',
              }),
            )
            .timeout(const Duration(seconds: 3));
        final t1 = DateTime.now().millisecondsSinceEpoch;

        final body = jsonDecode(res.body);
        final serverTime = (body['result'] as num?)?.toInt();
        if (serverTime == null) continue;

        final rtt = t1 - t0;
        if (bestRtt == null || rtt < bestRtt) {
          bestRtt = rtt;
          bestOffset = (t0 + rtt ~/ 2) - serverTime;
        }
      } catch (_) {
        // A dropped round just doesn't contribute a sample.
      }
    }

    if (bestOffset != null) {
      _clockOffsetMs = bestOffset;
      _clockSynced = true;
    }
  }

  int serverToLocal(int serverEpochMs) => serverEpochMs + _clockOffsetMs;

  /// The server clock is the shared reference, so a local instant maps back
  /// by subtracting the same offset [serverToLocal] adds.
  int localToServer(int localEpochMs) => localEpochMs - _clockOffsetMs;

  RecordingStartCommand _startCommand(
    int serverStartAtEpochMs, {
    int? recordingNumber,
    int? serverBeepAtEpochMs,
  }) =>
      RecordingStartCommand(
        serverStartAtEpochMs: serverStartAtEpochMs,
        localStartAtEpochMs: serverToLocal(serverStartAtEpochMs),
        recordingNumber: recordingNumber,
        localBeepAtEpochMs: serverBeepAtEpochMs == null
            ? null
            : serverToLocal(serverBeepAtEpochMs),
      );

  /// Joins the session's socket room. The server requires an ack callback and
  /// replies `{ok, error?, members?, recording?, session?}`; it identifies the
  /// user from the handshake cookie, so no device name is sent. With
  /// [camera] false this phone runs the session without recording; joining
  /// again switches it.
  /// This phone's id, made once and kept: the server allows one device per
  /// account in a session, and tells a reconnect from a second device by it.
  static Future<String> _deviceId() async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString('deviceId');
    if (id == null) {
      final random = Random.secure();
      id = List.generate(
              16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'))
          .join();
      await prefs.setString('deviceId', id);
    }
    return id;
  }

  Future<JoinResult> joinSession(String sessionId, {bool camera = true}) async {
    final socket = _socket;
    if (socket == null || !socket.connected) {
      return Future.value(
        const JoinResult(ok: false, error: 'Not connected to the server.'),
      );
    }

    final completer = Completer<JoinResult>();

    final deviceId = await _deviceId();
    socket.emitWithAck(
      Events.joinSession,
      {'sessionId': sessionId, 'camera': camera, 'deviceId': deviceId},
      ack: (reply) {
        if (completer.isCompleted) return;
        if (reply is! Map || reply['ok'] != true) {
          completer.complete(JoinResult(
            ok: false,
            error: (reply is Map ? reply['error'] : null)?.toString() ??
                'Unable to join the live session.',
          ));
          return;
        }

        _sessionId = sessionId;
        _sessionCamera = camera;

        final membersData = reply['members'];
        if (membersData is List) {
          _members.add(
            membersData.whereType<Map>().map(SessionMember.fromJson).toList(),
          );
        }

        // If a synchronized recording is already underway, schedule this
        // device to fall in rather than waiting for the next start command.
        final recording = reply['recording'];
        if (recording is Map && recording['stopAtEpochMs'] == null) {
          final serverStart = (recording['startAtEpochMs'] as num?)?.toInt();
          if (serverStart != null) {
            _recordingStart.add(_startCommand(
              serverStart,
              recordingNumber: (recording['recordingNumber'] as num?)?.toInt(),
            ));
          }
        }

        final session = reply['session'];
        completer.complete(JoinResult(
          ok: true,
          sessionName: session is Map ? session['name']?.toString() : null,
          canControl: session is Map && session['canControl'] == true,
          createdBy:
              session is Map ? (session['createdBy'] as num?)?.toInt() : null,
        ));
      },
    );

    return completer.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () => const JoinResult(
        ok: false,
        error: 'The server did not answer the join request.',
      ),
    );
  }

  /// Asks the server to start a take on every device in [sessionId], at a
  /// shared time it picks (long enough for the slowest device). Returns null
  /// when it started, or the reason it didn't.
  Future<String?> requestStart(String sessionId) =>
      _command(Events.startRecording, {'sessionId': sessionId}, 'start');

  /// Asks the server to stop the take on every device in [sessionId].
  Future<String?> requestStop(String sessionId) =>
      _command(Events.stopRecording, {'sessionId': sessionId}, 'stop');

  /// Tells the room this phone's recording stopped because the app left the
  /// screen mid-take, so whoever runs the session knows to redo it.
  void reportCameraDropped() => _socket?.emit(Events.cameraDropped);

  Future<String?> _command(
      String event, Map<String, dynamic> payload, String verb) {
    final socket = _socket;
    if (socket == null || !socket.connected) {
      return Future.value('Not connected to the server.');
    }
    final completer = Completer<String?>();
    socket.emitWithAck(event, payload, ack: (reply) {
      if (completer.isCompleted) return;
      completer.complete(reply is Map && reply['ok'] == true
          ? null
          : (reply is Map ? reply['error'] : null)?.toString() ??
              'Unable to $verb recording.');
    });
    return completer.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () => 'The server did not answer.',
    );
  }

  /// Leaves the current session room. The server tracks which room this
  /// socket is in, so no payload is needed.
  void leaveSession() {
    _sessionId = null;
    _socket?.emit(Events.leaveSession);
  }

  void dispose() {
    _socket?.dispose();
    _members.close();
    _recordingStart.close();
    _recordingStop.close();
    _cameraDropped.close();
    _sessionClosed.close();
    _errors.close();
    _connection.close();
  }
}

class SyncSocketException implements Exception {
  SyncSocketException(this.message);

  final String message;

  @override
  String toString() => message;
}

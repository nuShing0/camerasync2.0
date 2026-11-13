import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'api_client.dart';

/// A recording session, as shaped by the server's `publicSession`
/// (apps/server/src/routes/recordings.js).
class RecordingSession {
  const RecordingSession({
    required this.id,
    required this.name,
    required this.status,
    required this.activeMemberCount,
    required this.isJoined,
    this.activeMemberNames = const [],
    this.groupId,
    this.scheduledAt,
    this.memberCount,
    this.recordingCount,
    this.createdBy,
    this.thumbnailUrl,
  });

  final String id;
  final String name;
  final String status;
  final int activeMemberCount;
  final bool isJoined;

  /// Who's in the session now, earliest first (for the live card's
  /// initials). Empty from servers that don't send it.
  final List<String> activeMemberNames;
  final String? groupId;
  final DateTime? scheduledAt;

  /// Null for sessions that predate attendance tracking.
  final int? memberCount;

  /// Takes: Recording 001, 002, ...
  final int? recordingCount;

  /// Who scheduled or started it. They can end or cancel it, and so can the
  /// group's admins and owner.
  final int? createdBy;

  /// A still from the session's first take (server-relative, needs the
  /// session cookie; see [RecordingsApi.thumbnailOf]). Null until made.
  final String? thumbnailUrl;

  bool get isActive => status == 'active';
  bool get isScheduled => status == 'scheduled';
  bool get isComplete => status == 'complete';
  bool get isCancelled => status == 'cancelled';

  factory RecordingSession.fromJson(Map<String, dynamic> json) =>
      RecordingSession(
        id: json['id'] as String,
        name: (json['name'] ?? '').toString(),
        status: (json['status'] ?? '').toString(),
        activeMemberCount: (json['activeMemberCount'] as num?)?.toInt() ?? 0,
        isJoined: json['isJoined'] == true,
        activeMemberNames: [
          for (final name in json['activeMemberNames'] as List? ?? const [])
            name.toString(),
        ],
        groupId: json['groupId']?.toString(),
        scheduledAt: json['scheduledAt'] == null
            ? null
            : DateTime.tryParse(json['scheduledAt'].toString())?.toLocal(),
        memberCount: (json['memberCount'] as num?)?.toInt(),
        recordingCount: (json['recordingCount'] as num?)?.toInt(),
        createdBy: (json['createdBy'] as num?)?.toInt(),
        thumbnailUrl: json['thumbnailUrl'] as String?,
      );
}

/// One device's video within a recording. [url] is null when that member
/// saved a video but has not uploaded it yet.
class AngleVideo {
  const AngleVideo({
    required this.userId,
    required this.name,
    this.url,
    this.previewUrl,
    this.previewOnly = false,
    this.startOffsetMs,
    this.takeStartedAtMs,
    this.upload,
    this.scrub,
  });

  final int userId;
  final String name;

  /// What to play: the full video, or its preview while the full one is
  /// still uploading ([previewOnly]). Null until either has arrived.
  final String? url;

  /// A smaller copy (720p at most) for when the angle is drawn small; null
  /// until the server has made it.
  final String? previewUrl;

  /// [url] is the phone's small preview; the full video is still uploading.
  final bool previewOnly;

  /// When the take began, for telling a video still on its way from one
  /// that's not coming.
  final int? takeStartedAtMs;

  /// How far along its upload is, while the full video isn't in yet.
  final UploadProgress? upload;

  /// Stills shown while the seek bar is dragged; null until the server has
  /// made them.
  final ScrubStills? scrub;

  /// Shown as on its way for this long after the take.
  static const uploadWait = Duration(minutes: 30);

  /// Not here yet, but the take is recent enough that it's probably still
  /// uploading.
  bool get stillUploading {
    final started = takeStartedAtMs;
    return url == null &&
        started != null &&
        DateTime.now().millisecondsSinceEpoch - started <
            uploadWait.inMilliseconds;
  }

  /// How much later this camera really began than the take's shared start,
  /// or null if the device didn't report it (treated as on time).
  final int? startOffsetMs;

  factory AngleVideo.fromJson(Map<String, dynamic> json,
          {int? takeStartedAtMs}) =>
      AngleVideo(
        userId: (json['userId'] as num).toInt(),
        name: (json['name'] ?? 'Unnamed member').toString(),
        url: json['url'] as String?,
        previewUrl: json['previewUrl'] as String?,
        previewOnly: json['previewOnly'] == true,
        startOffsetMs: (json['startOffsetMs'] as num?)?.toInt(),
        takeStartedAtMs: takeStartedAtMs,
        upload: json['upload'] is Map
            ? UploadProgress.fromJson(Map<String, dynamic>.from(json['upload']))
            : null,
        scrub: json['scrub'] is Map
            ? ScrubStills.fromJson(Map<String, dynamic>.from(json['scrub']))
            : null,
      );
}

/// An angle's small stills, several a second, tiled [cols] x [rows] to a
/// sheet (see the server's recordings/scrubFrames.js): frame k of the
/// video's own timeline (k / [fps] s) is tile k % (cols * rows) of sheet
/// k ~/ (cols * rows), left to right, top to bottom.
class ScrubStills {
  const ScrubStills({
    required this.fps,
    required this.width,
    required this.height,
    required this.cols,
    required this.rows,
    required this.frames,
    required this.sheets,
  });

  final int fps;

  /// One still's size in the sheet.
  final int width;
  final int height;
  final int cols;
  final int rows;
  final int frames;

  /// Server paths of the sheets, in order.
  final List<String> sheets;

  /// Which sheet, column and row hold the still for [at] into the video.
  ({int sheet, int col, int row}) tileAt(Duration at) {
    final frame =
        (at.inMilliseconds * fps ~/ 1000).clamp(0, frames - 1).toInt();
    final perSheet = cols * rows;
    final index = frame % perSheet;
    return (sheet: frame ~/ perSheet, col: index % cols, row: index ~/ cols);
  }

  factory ScrubStills.fromJson(Map<String, dynamic> json) => ScrubStills(
        fps: (json['fps'] as num).toInt(),
        width: (json['width'] as num).toInt(),
        height: (json['height'] as num).toInt(),
        cols: (json['cols'] as num).toInt(),
        rows: (json['rows'] as num).toInt(),
        frames: (json['frames'] as num).toInt(),
        sheets: [for (final sheet in json['sheets'] as List) sheet.toString()],
      );
}

/// A signed CDN link to a stored file (see the server's storage/cdn.js),
/// which needs no login, rather than one to our server, which does.
bool isSignedLink(String url) => url.contains('Key-Pair-Id=');

/// Whether two links are to the same stored file: a CDN link is re-signed
/// every few hours, and a player handed the new one needn't load it again.
bool sameFile(String a, String b) => a.split('?').first == b.split('?').first;

/// An angle's upload as the uploading device last reported it.
class UploadProgress {
  const UploadProgress(
      {required this.stage, required this.fraction, required this.stalled});

  /// 'preview' (the small copy, sent first) or 'full'.
  final String stage;
  final double fraction;

  /// No report for a while: the device lost its connection.
  final bool stalled;

  factory UploadProgress.fromJson(Map<String, dynamic> json) => UploadProgress(
        stage: (json['stage'] ?? 'full').toString(),
        fraction: (json['fraction'] as num?)?.toDouble() ?? 0,
        stalled: json['stalled'] == true,
      );
}

/// How far to skip into each angle (by index) so a take's angles line up,
/// like angleTrims in the web app. Cameras start a moment apart, so the
/// shared timeline begins when the last one started and every earlier angle
/// skips ahead by how much earlier it began. Angles that weren't uploaded
/// are left out.
Map<int, Duration> angleTrims(List<AngleVideo> videos) {
  final offsets = <int, int>{
    for (var i = 0; i < videos.length; i++)
      if (videos[i].url != null) i: videos[i].startOffsetMs ?? 0,
  };
  if (offsets.isEmpty) return {};
  final latest = offsets.values.reduce((a, b) => a > b ? a : b);
  return {
    for (final entry in offsets.entries)
      entry.key: Duration(milliseconds: latest - entry.value),
  };
}

/// One synchronized recording within a session: every angle that shares the
/// same server-clock start.
class SessionRecording {
  const SessionRecording({
    required this.startedAtMs,
    required this.number,
    required this.videos,
  });

  final int startedAtMs;
  final int number;
  final List<AngleVideo> videos;

  factory SessionRecording.fromJson(Map<String, dynamic> json) {
    final startedAtMs = (json['startedAt'] as num).toInt();
    return SessionRecording(
      startedAtMs: startedAtMs,
      number: (json['number'] as num?)?.toInt() ?? 0,
      videos: ((json['videos'] as List?) ?? const [])
          .map((v) => AngleVideo.fromJson(Map<String, dynamic>.from(v),
              takeStartedAtMs: startedAtMs))
          .toList(),
    );
  }
}

/// The recordings of one session, as returned by GET /sessions/:id/videos.
class SessionVideos {
  const SessionVideos({
    required this.sessionId,
    required this.sessionName,
    required this.recordings,
    this.canDelete = false,
  });

  final String sessionId;
  final String sessionName;
  final List<SessionRecording> recordings;

  /// This user can delete recordings (an admin of the group).
  final bool canDelete;

  factory SessionVideos.fromJson(Map<String, dynamic> json) {
    final session = Map<String, dynamic>.from(json['session'] as Map);
    return SessionVideos(
      sessionId: session['id'].toString(),
      sessionName: (session['name'] ?? '').toString(),
      recordings: ((json['recordings'] as List?) ?? const [])
          .map((r) => SessionRecording.fromJson(Map<String, dynamic>.from(r)))
          .toList(),
      canDelete: json['canDelete'] == true,
    );
  }
}

/// A timestamped note left on a recording.
class SessionNote {
  const SessionNote({
    required this.id,
    required this.body,
    required this.videoTimeMs,
    required this.authorName,
    this.canDelete = false,
  });

  final int id;
  final String body;
  final int videoTimeMs;
  final String authorName;

  /// The server's verdict for the current user: their own note, or one by a
  /// lower group role.
  final bool canDelete;

  factory SessionNote.fromJson(Map<String, dynamic> json) => SessionNote(
        id: (json['id'] as num).toInt(),
        body: (json['body'] ?? '').toString(),
        videoTimeMs: (json['videoTimeMs'] as num?)?.toInt() ?? 0,
        authorName: (json['author'] ?? 'Unnamed member').toString(),
        canDelete: json['canDelete'] == true,
      );
}

/// REST calls for recording sessions, mirroring apps/web/src/api/recordings.js.
class RecordingsApi {
  const RecordingsApi(this._api);

  final ApiClient _api;

  /// Sessions visible to the current user's groups.
  Future<List<RecordingSession>> getSessions() async {
    final data = await _api.get('/api/recordings/sessions');
    final sessions = (data as Map)['sessions'] as List;
    return sessions
        .map((s) => RecordingSession.fromJson(Map<String, dynamic>.from(s)))
        .toList();
  }

  /// Schedule a session for one of the user's groups (admins and owner).
  Future<RecordingSession> scheduleSession({
    required String groupId,
    required String name,
    required DateTime scheduledAt,
  }) async {
    final data = await _api.post('/api/recordings/sessions', {
      'groupId': groupId,
      'name': name,
      'scheduledAt': scheduledAt.toUtc().toIso8601String(),
    });
    return RecordingSession.fromJson(
        Map<String, dynamic>.from((data as Map)['session'] as Map));
  }

  /// Start a session right now, for a group (its admins and owner).
  Future<RecordingSession> createLiveSession({
    required String groupId,
    required String name,
  }) async {
    final data = await _api.post('/api/recordings/sessions/live', {
      'groupId': groupId,
      'name': name,
    });
    return RecordingSession.fromJson(
        Map<String, dynamic>.from((data as Map)['session'] as Map));
  }

  /// Leave a live session someone else is hosting.
  Future<void> leaveSession(String id) async {
    await _api.delete('/api/recordings/sessions/$id/join');
  }

  /// End a live session for everyone (its host, or a group admin).
  Future<void> endSession(String id) async {
    await _api.patch('/api/recordings/sessions/$id/end', const {});
  }

  /// Cancel a scheduled session (its creator, or a group admin).
  Future<void> cancelSession(String id) async {
    await _api.patch('/api/recordings/sessions/$id/cancel', const {});
  }

  /// Delete a finished session and its videos (group admins and owner).
  Future<void> deleteSession(String id) async {
    await _api.delete('/api/recordings/sessions/$id');
  }

  /// Joins (or re-joins) a session, which also flips a scheduled session to
  /// active. Must succeed before the socket room will accept this user.
  Future<RecordingSession> joinSession(String id) async {
    final data = await _api.post('/api/recordings/sessions/$id/join');
    return RecordingSession.fromJson(
      Map<String, dynamic>.from((data as Map)['session'] as Map),
    );
  }

  /// Every recording of a session with each device's video. Video URLs are
  /// server-relative and need the session cookie; see [absoluteUrl].
  Future<SessionVideos> getSessionVideos(String id) async {
    final data = await _api.get('/api/recordings/sessions/$id/videos');
    return SessionVideos.fromJson(Map<String, dynamic>.from(data as Map));
  }

  /// Notes on one recording, ordered by the moment in the video they refer to.
  Future<List<SessionNote>> getSessionNotes(String id, int startedAtMs) async {
    final data = await _api.get(
      '/api/recordings/sessions/$id/notes?startedAt=$startedAtMs',
    );
    final notes = ((data as Map)['notes'] as List?) ?? const [];
    return notes
        .map((n) => SessionNote.fromJson(Map<String, dynamic>.from(n)))
        .toList();
  }

  /// Leaves a note [videoTimeMs] into the recording that started at
  /// [startedAtMs]. Viewers get a 403 with the server's message.
  Future<void> createSessionNote(
    String id,
    int startedAtMs,
    String body,
    int videoTimeMs,
  ) async {
    await _api.post('/api/recordings/sessions/$id/notes', {
      'startedAt': startedAtMs,
      'body': body,
      'videoTimeMs': videoTimeMs,
    });
  }

  /// Deletes one recording of a session: every angle, and its comments.
  /// Admins only.
  Future<void> deleteRecording(String id, int startedAtMs) async {
    await _api.delete('/api/recordings/sessions/$id/recordings/$startedAtMs');
  }

  /// Asks the server to make the session's download (every angle lined up,
  /// plus the angles side by side), and says how far along it is. Safe to
  /// repeat: ask every couple of seconds until it's ready, then fetch
  /// [downloadPath].
  Future<ExportStatus> requestSyncedDownload(String id) async {
    final data = await _api.post('/api/recordings/sessions/$id/exports');
    return ExportStatus.fromJson(Map<String, dynamic>.from(data as Map));
  }

  /// Where the session's lined-up zip is, server-relative.
  static String downloadPath(String id) =>
      '/api/recordings/sessions/$id/download?kind=synced';

  Future<void> deleteSessionNote(String id, int noteId) async {
    await _api.delete('/api/recordings/sessions/$id/notes/$noteId');
  }

  /// The picture for a session's tile in the lists, or null when the server
  /// hasn't made one.
  ImageProvider? thumbnailOf(RecordingSession session) {
    final path = session.thumbnailUrl;
    if (path == null) return null;
    final url = absoluteUrl(path);
    return NetworkImage(url, headers: mediaHeaders(url));
  }

  /// One sheet of an angle's seek-bar stills (see [ScrubStills]).
  ImageProvider scrubSheet(String path) {
    final url = absoluteUrl(path);
    return NetworkImage(url, headers: mediaHeaders(url));
  }

  /// What to send with a request for a stored file at [url]: the login
  /// cookie to this server (which checks it), nothing to the CDN (its links
  /// are signed, and the cookie is nobody else's business).
  Map<String, String> mediaHeaders(String url) {
    final cookie = _api.cookie;
    return {
      if (cookie != null && !isSignedLink(url)) 'Cookie': cookie,
    };
  }

  /// Turns a server-relative path like `/api/files/get/x.mp4` into a full
  /// URL; a full one (a signed CDN link) is left as it is.
  String absoluteUrl(String path) =>
      path.startsWith('http') ? path : '${_api.baseUrl}$path';

  /// Records that this user finished a video for the recording that started
  /// at [startedAtMs] (server clock), so the session's video counts include
  /// it even if the upload itself fails. Safe to repeat.
  ///
  /// [actualStartedAtMs] is when this phone's camera really began (server
  /// clock); playback shifts the angle by how late that was.
  ///
  /// [startClock] says what that is: 'frame' for the first frame's capture
  /// time, 'call' for when the camera was asked to start.
  Future<void> saveRecordingDetails(String id, int startedAtMs,
          {int? actualStartedAtMs, String? startClock}) =>
      _api.post('/api/recordings/sessions/$id/videos', {
        'startedAt': startedAtMs,
        if (actualStartedAtMs != null) 'actualStartedAt': actualStartedAtMs,
        if (startClock != null) 'startClock': startClock,
      });

  /// Uploads a finished recording so it appears in the session's playback.
  ///
  /// [startedAtMs] must be the server-clock start the whole session shared
  /// (see `RecordingStartCommand.serverStartAtEpochMs`); the server lines this
  /// angle up with every other device's by that value. A [preview] is a
  /// small copy sent first, played until the full video arrives.
  ///
  /// Sent in pieces ([uploadPieceBytes] each), so an upload that's cut off
  /// (no connection, a take starting) carries on later from what arrived:
  /// [resumeId] is an earlier try's upload, and [onStarted] hears the id of
  /// a new one, to keep for next time. A server without resumable uploads
  /// gets the whole file in one request, as before.
  Future<void> uploadSessionVideo(
    String id,
    int startedAtMs,
    String filePath, {
    String? filename,
    int? actualStartedAtMs,
    String? startClock,
    bool preview = false,
    Duration timeout = const Duration(minutes: 10),
    void Function(int sent, int total)? onProgress,
    String? resumeId,
    void Function(String uploadId)? onStarted,
  }) async {
    final name = filename ?? filePath.split('/').last;
    final query =
        '?sessionId=${Uri.encodeQueryComponent(id)}&startedAt=$startedAtMs'
        '${actualStartedAtMs == null ? '' : '&actualStartedAt=$actualStartedAtMs'}'
        '${startClock == null ? '' : '&startClock=$startClock'}'
        '${preview ? '&kind=preview' : ''}';
    final file = File(filePath);
    final size = await file.length();

    var uploadId = resumeId;
    var offset = 0;
    if (uploadId != null) {
      try {
        final status = await _api.get('/api/files/uploads/$uploadId');
        offset = (status['offset'] as num).toInt();
        if ((status['size'] as num).toInt() != size) uploadId = null;
      } on ApiException catch (e) {
        // Finished already, or cleared away: start again.
        if (e.statusCode != 404) rethrow;
        uploadId = null;
      }
    }
    if (uploadId == null) {
      try {
        final started = await _api.post('/api/files/uploads$query'
            '&size=$size&name=${Uri.encodeQueryComponent(name)}');
        uploadId = started['uploadId'] as String;
      } on ApiException catch (e) {
        if (e.statusCode != 404) rethrow;
        // An older server: the whole file at once.
        await _api.postFile('/api/files/upload$query',
            filePath: filePath,
            filename: filename,
            timeout: timeout,
            onProgress: onProgress);
        return;
      }
      offset = 0;
      onStarted?.call(uploadId);
    }

    while (offset < size) {
      final end = math.min(offset + uploadPieceBytes, size);
      final from = offset;
      try {
        final sent = await _api.putBytes(
          '/api/files/uploads/$uploadId?offset=$from',
          file.openRead(from, end),
          end - from,
          onProgress: (bytes) => onProgress?.call(from + bytes, size),
        );
        offset = (sent['offset'] as num).toInt();
      } on ApiException catch (e) {
        // The server has a different amount than we thought (a piece that
        // half arrived): carry on from what it has.
        if (e.statusCode != 409) rethrow;
        final status = await _api.get('/api/files/uploads/$uploadId');
        offset = (status['offset'] as num).toInt();
      }
    }
    // Finishing stores and checks the whole video, which takes a while.
    await _api.postSlow(
        '/api/files/uploads/$uploadId/complete', const Duration(minutes: 5));
  }

  /// How much of a recording goes up in one request: small enough that a
  /// dropped connection loses little, big enough not to waste time on
  /// requests.
  static const uploadPieceBytes = 4 * 1024 * 1024;

  /// How far along this device's upload of one angle is, for the bars
  /// viewers see under it. [stage] is 'preview' or 'full'.
  Future<void> reportUploadProgress(
          String id, int startedAtMs, String stage, double fraction) =>
      _api.post('/api/recordings/sessions/$id/upload-progress', {
        'startedAt': startedAtMs,
        'stage': stage,
        'fraction': fraction,
      });
}

/// How far along the server is with a session's download.
class ExportStatus {
  const ExportStatus({
    required this.state,
    required this.progress,
    required this.waiting,
    this.error,
  });

  /// 'queued', 'working', 'ready' or 'failed'.
  final String state;

  /// 0 to 1.
  final double progress;

  /// Other people's downloads the server is making first.
  final int waiting;
  final String? error;

  bool get isReady => state == 'ready';
  bool get isFailed => state == 'failed';

  factory ExportStatus.fromJson(Map<String, dynamic> json) => ExportStatus(
        state: json['state'] as String? ?? 'queued',
        progress: (json['progress'] as num?)?.toDouble() ?? 0,
        waiting: (json['waiting'] as num?)?.toInt() ?? 0,
        error: json['error'] as String?,
      );

  /// What to show while it's made. Mirrors downloadStatusText on the web.
  String describe() {
    if (isFailed) return error ?? "Couldn't make the download.";
    if (isReady) return 'Ready. Downloading…';
    if (state == 'queued' && waiting > 0) {
      return 'Waiting for $waiting other download${waiting == 1 ? '' : 's'} to finish…';
    }
    return 'Lining up the videos… ${(progress * 100).floor()}%';
  }
}

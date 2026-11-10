import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import '../playback/angle_sync.dart';
import '../api/api_client.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../recordings/angle_layout.dart';
import '../recordings/names.dart';
import '../team_accent.dart';
import '../theme.dart';
import '../tv/tv_link.dart';
import '../tv/tv_protocol.dart';
import '../widgets/auto_refresh.dart';
import '../widgets/empty_state.dart';

/// A screen at least this big (a TV, a monitor, a tablet on its side) shows
/// every angle at once like the desktop app. Phones, even turned sideways,
/// show one camera at a time and decode only that one video.
bool isBigScreen(Size size) => size.width >= 900 && size.height >= 500;

/// One session's recordings. A session with more than one recording (take)
/// opens on the list of them; tapping one plays it. Upright, the chosen
/// angle plays big with stills of the others underneath; sideways or on a
/// big screen the angles play together in a grid. One shared transport
/// keeps the players on the same clock, and comments pop up as they come.
///
/// Previous / next move between the session's recordings (Recording 001,
/// 002, ...); back returns to the list.
class WatchScreen extends StatefulWidget {
  const WatchScreen({super.key, required this.auth, required this.session});

  final AuthService auth;
  final RecordingSession session;

  @override
  State<WatchScreen> createState() => _WatchScreenState();
}

class _WatchScreenState extends State<WatchScreen> {
  late final RecordingsApi _recordings = RecordingsApi(widget.auth.api);

  SessionVideos? _videos;
  int _index = 0;

  /// Showing the list of recordings rather than playing one.
  bool _picking = false;
  bool get _hasList => (_videos?.recordings.length ?? 0) > 1;
  bool _loading = true;
  String? _error;

  /// Open players by angle index in the current recording. On a phone only
  /// the selected angle is open; on a big screen every uploaded one is.
  final Map<int, VideoPlayerController> _players = {};

  /// Which copy each open player is playing (see [_urlFor]).
  final Map<int, String> _playerUrls = {};

  /// How far into each angle the shared timeline starts, so every angle
  /// shows the same moment. [_position], [_duration] and comment times are
  /// all on that shared timeline.
  Map<int, Duration> _trims = {};
  Duration _trimOf(int i) => _trims[i] ?? Duration.zero;

  /// A TV is plugged in: the angles play there and this screen is the
  /// remote (see TvLink). The TV reports its position, which drives the
  /// timeline and comments here as the players normally would.
  bool _onTv = false;
  StreamSubscription<TvState>? _tvStates;
  int _tvPage = 0;
  int _tvPageCount = 0;
  int? _tvFocused;

  /// The angle heard on the TV, or null when muted.
  int? _tvSound = 0;
  int? _tvCommentId;

  /// Where angle [i]'s player is on the shared timeline.
  Duration _timelineAt(int i, VideoPlayerController player) {
    final at = player.value.position - _trimOf(i);
    return at < Duration.zero ? Duration.zero : at;
  }

  /// The angle index of the clock player, if it's open.
  int? get _clockIndex {
    for (final entry in _players.entries) {
      if (entry.value == _clockPlayer) return entry.key;
    }
    return null;
  }

  /// The shared-timeline position of the clock, or [_position] without one.
  Duration get _clockAt {
    final i = _clockIndex;
    final clock = _clockPlayer;
    return i == null || clock == null ? _position : _timelineAt(i, clock);
  }

  int _selected = 0;
  bool _bigScreen = false;

  /// Held sideways: the angles show as a grid, like on a big screen.
  bool _landscape = false;
  bool get _gridMode => _bigScreen || _landscape;

  /// Grid pages: 4 angles on a phone; on a TV or tablet as many as fit at a
  /// watchable size (up to 9: each angle is its own video decoder).
  int _page = 0;
  int _bigPerPage = 6;
  int get _perPage => _bigScreen ? _bigPerPage : 4;
  int get _pageCount => (_uploadedAngles.length / _perPage).ceil();
  List<int> get _pageAngles =>
      _uploadedAngles.skip(_page * _perPage).take(_perPage).toList();

  /// Upright, the selected angle plays big and up to this many others show
  /// as stills underneath (each still is a paused player, so they're kept
  /// few on a phone).
  static const _maxStills = 3;
  List<int> get _stillAngles =>
      _uploadedAngles.where((i) => i != _selected).take(_maxStills).toList();

  /// In the grid, the angle tapped to fill the space (tap again, or back,
  /// to return to the grid); null shows the whole page.
  int? _focused;

  /// The angles that play: the expanded one, the grid page, or just the
  /// selected one.
  Set<int> get _liveAngles {
    final focused = _focused;
    if (focused != null) return {focused};
    return _gridMode ? _pageAngles.toSet() : {_selected};
  }

  VideoPlayerController? _clockPlayer;
  int _syncGeneration = 0;

  bool _ready = false;
  bool _playing = false;

  /// Played and not yet through to the end. Meanwhile an angle whose full
  /// video arrives keeps playing its preview rather than loading again; the
  /// switch happens once the take ends.
  bool _midTake = false;
  Duration _position = Duration.zero;

  /// The playhead to the frame while playing, for the scrub bar alone
  /// ([_position] moves the rest of the screen once a second).
  final _barAt = ValueNotifier(Duration.zero);

  /// How far ahead every angle on screen has loaded, on the shared
  /// timeline: the scrub bar's light grey part, like YouTube's. The slowest
  /// angle sets it, since playback waits for that one.
  final _loadedTo = ValueNotifier(Duration.zero);

  /// Whether every angle on screen has [at] (on the shared timeline)
  /// loaded already.
  bool _loadedAt(Duration at) {
    for (final entry in _players.entries) {
      if (!_liveAngles.contains(entry.key)) continue;
      final target = at + _trimOf(entry.key);
      if (!entry.value.value.buffered
          .any((range) => range.start <= target && target <= range.end)) {
        return false;
      }
    }
    return true;
  }

  Duration _loadedAhead() {
    Duration? least;
    for (final entry in _players.entries) {
      if (!_liveAngles.contains(entry.key)) continue;
      final value = entry.value.value;
      final trim = _trimOf(entry.key);
      var end = value.position;
      for (final range in value.buffered) {
        if (range.start <= value.position + const Duration(milliseconds: 500) &&
            range.end > end) {
          end = range.end;
        }
      }
      final ahead = end - trim;
      if (least == null || ahead < least) least = ahead;
    }
    return least ?? Duration.zero;
  }

  /// Where the scrub bar's handle is held while it's dragged, and whether
  /// playback picks up again when it's let go.
  Duration? _dragTo;
  bool _dragWasPlaying = false;

  /// The moment every angle's still shows, from the start of a drag until
  /// the videos have landed where it was let go (see [_stillFor]).
  Duration? _stillsAt;

  /// Every angle being watched has its stills, so a drag shows those
  /// rather than moving the videos.
  bool get _haveStills {
    final recording = _recording;
    final live = _liveAngles;
    return recording != null &&
        live.isNotEmpty &&
        live.every((i) => recording.videos[i].scrub != null);
  }

  /// Every angle drawn on screen: the ones playing and, beside the big one
  /// on a phone, the paused ones in the strip. While the seek bar is
  /// dragged they all show the same instant.
  Set<int> get _shownAngles => {
        ..._liveAngles,
        if (!_gridMode) ..._stillAngles,
      };

  /// Still sheets (by path) that have downloaded, and ones downloading.
  final Set<String> _loadedSheets = {};
  final Set<String> _fetchingSheets = {};

  /// The sheet angle [i] needs for [at], or null without stills.
  String? _sheetFor(int i, Duration at) {
    final scrub = _recording?.videos[i].scrub;
    if (scrub == null) return null;
    return scrub.sheets[scrub.tileAt(at + _trimOf(i)).sheet];
  }

  /// Whether every angle on screen with stills has its sheet for [at]: they
  /// switch to their stills together, as one angle moving while another
  /// sits on the old moment would look out of sync.
  bool _stillsReadyAt(Duration at) => _shownAngles.every((i) {
        final sheet = _sheetFor(i, at);
        return sheet == null || _loadedSheets.contains(sheet);
      });

  /// Starts downloading, for every angle on screen, the still sheets
  /// for [at] and a little past it (each sheet is 20 s of one angle), so
  /// only the parts a drag reaches are fetched.
  void _fetchSheetsNear(Duration at) {
    final recording = _recording;
    if (recording == null) return;
    for (final i in _shownAngles) {
      for (final ahead in const [Duration.zero, Duration(seconds: 5)]) {
        final sheet = _sheetFor(i, at + ahead);
        if (sheet == null ||
            _loadedSheets.contains(sheet) ||
            !_fetchingSheets.add(sheet)) {
          continue;
        }
        var failed = false;
        precacheImage(_recordings.scrubSheet(sheet), context,
            onError: (_, __) => failed = true).then((_) {
          _fetchingSheets.remove(sheet);
          // A failed one is asked for again on the next move.
          if (failed) return;
          _loadedSheets.add(sheet);
          if (mounted && _stillsAt != null) setState(() {});
        });
      }
    }
  }

  /// Angle [i]'s still for [_stillsAt], over its tile; null when not
  /// dragging, it has none, or not every angle's sheet is here yet.
  Widget? _stillFor(int i, BoxFit fit) {
    final at = _stillsAt;
    final scrub = _recording?.videos[i].scrub;
    if (at == null ||
        scrub == null ||
        !_shownAngles.contains(i) ||
        !_stillsReadyAt(at)) {
      return null;
    }
    final tile = scrub.tileAt(at + _trimOf(i));
    return _ScrubStill(
      scrub: scrub,
      sheet: _recordings.scrubSheet(scrub.sheets[tile.sheet]),
      col: tile.col,
      row: tile.row,
      fit: fit,
    );
  }

  /// Waits (up to [within]) until every angle being watched can play from
  /// where it is.
  Future<void> _untilPlayable({
    Duration within = const Duration(seconds: 10),
  }) async {
    final deadline = DateTime.now().add(within);
    while (mounted && DateTime.now().isBefore(deadline)) {
      final live = [
        for (final entry in _players.entries)
          if (_liveAngles.contains(entry.key)) entry.value,
      ];
      if (live.every((p) => p.value.isInitialized && !p.value.isBuffering)) {
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
  }

  DateTime _dragSeekAt = DateTime(0);
  Duration _duration = Duration.zero;
  List<SessionNote> _notes = [];

  SessionRecording? get _recording {
    final list = _videos?.recordings;
    if (list == null || list.isEmpty) return null;
    return list[_index.clamp(0, list.length - 1)];
  }

  List<int> get _uploadedAngles => [
        for (var i = 0; i < (_recording?.videos.length ?? 0); i++)
          if (_recording!.videos[i].url != null) i,
      ];

  @override
  void initState() {
    super.initState();
    _onTv = TvLink.instance.connected;
    TvLink.instance.addListener(_onTvChanged);
    _tvStates = TvLink.instance.states.listen(_onTvState);
    // A live session's takes show up as their uploads finish.
    // Every 3 s, so upload bars move; anything other than an open take
    // filling in still only every 10 s (see _refreshList).
    _refresher = AutoRefresher(const Duration(seconds: 3), _refreshList);
    _load();
  }

  // ---- TV mode -----------------------------------------------------------

  /// Plugged in or unplugged mid-recording: hand playback over.
  Future<void> _onTvChanged() async {
    final now = TvLink.instance.connected;
    if (now == _onTv || !mounted) return;
    setState(() => _onTv = now);
    if (_picking || _recording == null) return;
    if (now) {
      _keepInLine?.cancel();
      _position = _clockAt;
      await _closeAllPlayers();
      _sendToTv();
    } else {
      // Back on the phone where the TV left off.
      final wasPlaying = _playing;
      setState(() => _playing = false);
      await _syncPlayers();
      if (wasPlaying && mounted) _play();
    }
  }

  /// The angles of the open recording, as the TV numbers them.
  List<int> get _tvAngles => _uploadedAngles;

  void _sendToTv() {
    final recording = _recording;
    if (recording == null) return;
    _tvCommentId = null;
    TvLink.instance.send(TvAction.load, {
      'session': widget.session.name,
      'recording': 'Recording ${recording.number.toString().padLeft(3, '0')}',
      'cookie': widget.auth.api.cookie,
      'atMs': _position.inMilliseconds,
      'playing': _playing,
      'angles': [
        for (final i in _tvAngles)
          {
            'name': recording.videos[i].name,
            'url': _recordings.absoluteUrl(recording.videos[i].url!),
            if (recording.videos[i].previewUrl != null)
              'previewUrl':
                  _recordings.absoluteUrl(recording.videos[i].previewUrl!),
            'trimMs': _trimOf(i).inMilliseconds,
          }
      ],
    });
  }

  void _onTvState(TvState state) {
    if (!_onTv || !mounted || _picking) return;
    setState(() {
      _position = state.position;
      if (state.duration > Duration.zero) _duration = state.duration;
      _playing = state.playing;
      _tvPage = state.page;
      _tvPageCount = state.pageCount;
      _tvFocused = state.focused;
      _tvSound = state.sound;
      _ready = true;
    });
    // The comment at this moment, up on the TV too.
    SessionNote? live;
    for (final n in _notes) {
      final at = Duration(milliseconds: n.videoTimeMs);
      if (_position >= at && _position < at + const Duration(seconds: 3)) {
        live = n;
      }
    }
    if (live?.id != _tvCommentId) {
      _tvCommentId = live?.id;
      TvLink.instance.send(
        TvAction.comment,
        live == null ? null : {'author': live.authorName, 'body': live.body},
      );
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final size = MediaQuery.sizeOf(context);
    final big = isBigScreen(size);
    final landscape = size.width > size.height;
    // The grid's space on a big screen: the window less its side padding
    // and the title, timeline and controls above and below it.
    final perPage = anglesPerPage(
      Size(size.width - 42, size.height - 260),
      16 / 9,
    );
    if (big != _bigScreen ||
        landscape != _landscape ||
        (big && perPage != _bigPerPage)) {
      _bigScreen = big;
      _landscape = landscape;
      _bigPerPage = perPage;
      _page = 0;
      _focused = null;
      // Rotating, plugging into a TV, or resizing its window changes which
      // angles show, which opens and closes players.
      if (_recording != null && !_loading) _syncPlayers();
    }
  }

  late final AutoRefresher _refresher;
  DateTime? _lastListRefresh;

  /// Picks up a live session's takes as their uploads finish: while the
  /// list is showing, while there's nothing to show yet, or while the open
  /// recording has no angle uploaded. A recording being watched fills in
  /// angles still on their way (and swaps previews for full videos) in
  /// place, each joining at the current moment.
  Future<void> _refreshList() async {
    if (_loading) return;
    final waiting = _recording == null || _uploadedAngles.isEmpty;
    final filling = !waiting &&
        _recording!.videos.any((v) => v.stillUploading || v.previewOnly);
    if (!_picking && !waiting && !filling) return;
    final now = DateTime.now();
    final last = _lastListRefresh;
    if (!filling && last != null && now.difference(last).inSeconds < 10) return;
    _lastListRefresh = now;
    try {
      final videos = await _recordings.getSessionVideos(widget.session.id);
      if (!mounted || _loading) return;
      if (_picking) {
        setState(() => _videos = videos);
        return;
      }
      if (videos.recordings.isEmpty) return;
      if (filling) {
        await _fillIn(videos);
        return;
      }
      final hadNone = _recording == null;
      _videos = videos;
      if (hadNone && videos.recordings.length > 1) {
        setState(() => _picking = true);
      } else {
        _index = _index.clamp(0, videos.recordings.length - 1);
        if (_uploadedAngles.isNotEmpty || hadNone) await _openRecording();
      }
    } catch (_) {}
  }

  /// Takes the open recording's newly arrived angles from [videos] without
  /// stopping playback. Skipped if its cameras changed, since players are
  /// kept by position in the list.
  Future<void> _fillIn(SessionVideos videos) async {
    final current = _recording!;
    final index = videos.recordings
        .indexWhere((r) => r.startedAtMs == current.startedAtMs);
    if (index < 0) return;
    final fresh = videos.recordings[index];
    String cameras(SessionRecording r) =>
        r.videos.map((v) => v.userId).join(',');
    if (cameras(fresh) != cameras(current)) return;
    setState(() {
      _videos = videos;
      _index = index;
      _trims = angleTrims(fresh.videos);
    });
    await _syncPlayers(keepSources: _midTake);
  }

  /// Deletes the open recording (after asking), then reloads the session.
  Future<void> _deleteRecording() async {
    final recording = _recording;
    if (recording == null) return;
    final name = 'Recording ${recording.number.toString().padLeft(3, '0')}';
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete $name?'),
        content: const Text(
            "Every angle of it and its comments go too. This can't be undone."),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            style:
                TextButton.styleFrom(foregroundColor: const Color(0xFFE5484D)),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    try {
      await _closeAllPlayers();
      await _recordings.deleteRecording(
          widget.session.id, recording.startedAtMs);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('$name deleted')));
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.message)));
      await _openRecording();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final videos = await _recordings.getSessionVideos(widget.session.id);
      if (!mounted) return;
      _videos = videos;
      _index = 0;
      // Several recordings: list them first. One: play it straight away.
      if (videos.recordings.length > 1) {
        setState(() {
          _picking = true;
          _loading = false;
        });
        return;
      }
      await _openRecording();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  /// Closes the current players and opens the new recording on its first
  /// uploaded angle.
  Future<void> _openRecording() async {
    await _closeAllPlayers();
    final recording = _recording;
    final uploaded = _uploadedAngles;
    setState(() {
      _loading = recording != null;
      _ready = false;
      _playing = false;
      _midTake = false;
      _position = Duration.zero;
      _duration = Duration.zero;
      _notes = [];
      _focused = null;
      _selected = uploaded.isEmpty ? 0 : uploaded.first;
      _trims = recording == null ? {} : angleTrims(recording.videos);
    });
    if (recording == null) return;
    if (_onTv) {
      _sendToTv();
      setState(() => _loading = false);
      _loadNotes(recording);
      return;
    }
    await _syncPlayers();
    if (!mounted) return;
    setState(() => _loading = false);
    _loadNotes(recording);
  }

  /// Opens the players this screen size needs and closes the rest. A new
  /// player joins at the current position, playing if the others are.
  /// [keepSources] leaves open players on the copy they're playing, even if
  /// a better one has arrived.
  Future<void> _syncPlayers({bool keepSources = false}) async {
    final recording = _recording;
    if (recording == null || _onTv) return;
    final generation = ++_syncGeneration;
    final wanted =
        _gridMode ? _pageAngles.toSet() : {_selected, ..._stillAngles};

    _position = _clockAt;
    for (final i in _players.keys.toList()) {
      // Closed when it's no longer shown, or to switch between its preview
      // and the original (the grid grew or shrank around it).
      final url = _urlFor(recording, i);
      if (!wanted.contains(i) ||
          (!keepSources && (url == null || !sameFile(_playerUrls[i]!, url)))) {
        final player = _players.remove(i)!;
        _playerUrls.remove(i);
        _bufferingSince.remove(player);
        if (player == _clockPlayer) _setClock(null);
        await player.dispose();
      }
    }

    final missing = wanted.where((i) => !_players.containsKey(i)).toList();
    final opened =
        await Future.wait(missing.map((i) => _openPlayer(recording, i)));
    if (!mounted || generation != _syncGeneration || recording != _recording) {
      for (final player in opened) {
        await player?.dispose();
      }
      return;
    }

    for (var k = 0; k < missing.length; k++) {
      final player = opened[k];
      if (player == null) continue;
      _players[missing[k]] = player;
      _playerUrls[missing[k]] = _urlFor(recording, missing[k])!;
      await player.seekTo(_position + _trimOf(missing[k]));
    }

    // Only the live angles play; stills stay paused on the current moment.
    final live = _liveAngles;
    for (final entry in _players.entries) {
      if (_playing && live.contains(entry.key)) {
        entry.value.play();
      } else {
        entry.value.pause();
      }
    }

    final clockIndex = live.contains(_selected)
        ? _selected
        : _players.keys.where(live.contains).firstOrNull;
    _setClock(_players[clockIndex] ??
        (_players.isEmpty ? null : _players.values.first));
    final durations = [
      for (final entry in _players.entries)
        entry.value.value.duration - _trimOf(entry.key),
    ];
    setState(() {
      _duration = durations.isEmpty
          ? Duration.zero
          : durations.reduce((a, b) => a > b ? a : b);
      _ready = _players.isNotEmpty;
    });
  }

  /// The copy angle [i] plays, as an absolute URL: its preview while the
  /// grid draws it small, so many can play at once; the original when it's
  /// expanded, or the one big angle upright.
  String? _urlFor(SessionRecording recording, int i) {
    final video = recording.videos[i];
    final preview = video.previewUrl;
    var url = video.url;
    if (preview != null && _gridMode && i != _focused) {
      final screen = MediaQuery.of(context);
      if (usePreviews(
          screen.size, _pageAngles.length, screen.devicePixelRatio)) {
        url = preview;
      }
    }
    return url == null ? null : _recordings.absoluteUrl(url);
  }

  /// One angle's player, or null if it fails to load (the tile then shows
  /// "Not uploaded" rather than blocking the other angles).
  ///
  /// If the video won't play here (a laptop's VP9 on an iPhone), its
  /// preview is tried instead: the server always makes that an H.264 copy
  /// every phone can play.
  Future<VideoPlayerController?> _openPlayer(
      SessionRecording recording, int i) async {
    final url = _urlFor(recording, i);
    if (url == null) return null;
    final preview = recording.videos[i].previewUrl;
    final fallback = preview == null ? null : _recordings.absoluteUrl(preview);
    for (final candidate in {url, if (fallback != null) fallback}) {
      final player = await _tryPlayer(candidate);
      if (player != null) return player;
    }
    return null;
  }

  Future<VideoPlayerController?> _tryPlayer(String url) async {
    final player = VideoPlayerController.networkUrl(
      Uri.parse(url),
      httpHeaders: _recordings.mediaHeaders(url),
    );
    try {
      await player.initialize();
      // An iPhone opens a laptop's VP9 video without complaint but has no
      // picture for it (size zero): count that as not playable, so the
      // H.264 preview is tried instead.
      final size = player.value.size;
      if (size.width == 0 || size.height == 0) {
        await player.dispose();
        return null;
      }
      return player;
    } catch (_) {
      await player.dispose();
      return null;
    }
  }

  /// The player that drives the on-screen clock: the camera being watched,
  /// or on a big screen the first open one.
  void _setClock(VideoPlayerController? player) {
    if (player == _clockPlayer) return;
    _clockPlayer?.removeListener(_onTick);
    _clockPlayer = player;
    _clockPlayer?.addListener(_onTick);
  }

  void _onTick() {
    final clock = _clockPlayer;
    if (clock == null || !mounted) return;
    final value = clock.value;
    final ended =
        value.position >= value.duration && value.duration > Duration.zero;
    if (ended && _playing) {
      _pause();
      if (_midTake) {
        // Through to the end: angles held on a preview take the full video.
        _midTake = false;
        unawaited(_syncPlayers());
      }
      return;
    }
    final at = _clockAt;
    _barAt.value = at;
    _loadedTo.value = _loadedAhead();
    if (at.inSeconds != _position.inSeconds) {
      setState(() => _position = at);
    }
  }

  Future<void> _selectAngle(int i) async {
    if (i == _selected) return;
    setState(() => _selected = i);
    if (_gridMode) {
      _setClock(_players[i] ?? _clockPlayer);
    } else {
      await _syncPlayers();
    }
  }

  Future<void> _changePage(int delta) async {
    final next = _page + delta;
    if (next < 0 || next >= _pageCount) return;
    setState(() {
      _page = next;
      _focused = null;
    });
    await _syncPlayers();
  }

  /// Expands angle [i] in the grid, or with null goes back to the grid. The
  /// other angles pause while one is expanded and catch up when it closes.
  Future<void> _setFocus(int? i) async {
    if (i == _focused) return;
    final at = _clockAt;
    setState(() {
      _focused = i;
      if (i != null) _selected = i;
    });
    // The expanded angle switches to its original, and back to its preview
    // when it rejoins the grid.
    await _syncPlayers();
    if (!mounted) return;
    await _seek(at);
    if (!mounted) return;
    final live = _liveAngles;
    for (final entry in _players.entries) {
      if (_playing && live.contains(entry.key)) {
        entry.value.play();
      } else {
        entry.value.pause();
      }
    }
    final clockIndex = live.contains(_selected) ? _selected : live.firstOrNull;
    _setClock(_players[clockIndex] ?? _clockPlayer);
  }

  Future<void> _loadNotes(SessionRecording recording) async {
    try {
      final notes = await _recordings.getSessionNotes(
        widget.session.id,
        recording.startedAtMs,
      );
      if (mounted && _recording == recording) setState(() => _notes = notes);
    } catch (_) {
      // Notes are optional; the player still works without them.
    }
  }

  Future<void> _closeAllPlayers() async {
    _syncGeneration++;
    _setClock(null);
    final old = _players.values.toList();
    _players.clear();
    _playerUrls.clear();
    _bufferingSince.clear();
    for (final p in old) {
      await p.dispose();
    }
  }

  void _play() {
    if (_onTv) {
      TvLink.instance.send(TvAction.play, {'atMs': _position.inMilliseconds});
      setState(() => _playing = true);
      return;
    }
    final live = _liveAngles;
    for (final entry in _players.entries) {
      if (live.contains(entry.key)) entry.value.play();
    }
    setState(() {
      _playing = true;
      _midTake = true;
    });
    _keepInLine?.cancel();
    _keepInLine =
        Timer.periodic(const Duration(milliseconds: 250), (_) => _realign());
  }

  void _pause() {
    if (_onTv) {
      TvLink.instance.send(TvAction.pause, {'atMs': _position.inMilliseconds});
      setState(() => _playing = false);
      return;
    }
    _keepInLine?.cancel();
    _holding = false;
    for (final p in _players.values) {
      p.pause();
    }
    setState(() => _playing = false);
    // Every angle, stills included, is put on the exact moment playback
    // stopped, so a paused frame compares like with like.
    unawaited(AngleSync.resetSpeeds(_players.values));
    _seek(_clockAt);
  }

  /// While several angles play (a big screen), keeps every one on the
  /// clock angle's moment (see AngleSync). One angle on a phone has nothing
  /// to drift from.
  Timer? _keepInLine;
  bool _realigning = false;

  /// The other angles are paused for one that ran out of video to play,
  /// so they carry on together once it has loaded (it shows Loading).
  bool _holding = false;

  /// When each player started buffering. A jump, even to a part that's
  /// loaded already, reports a moment of buffering while it decodes; only
  /// one that lasts counts as loading.
  final Map<VideoPlayerController, DateTime> _bufferingSince = {};
  static const _loadingAfter = Duration(milliseconds: 500);

  bool _reallyLoading(VideoPlayerController p) {
    if (!p.value.isBuffering) {
      _bufferingSince.remove(p);
      return false;
    }
    final since = _bufferingSince.putIfAbsent(p, DateTime.now);
    return DateTime.now().difference(since) >= _loadingAfter;
  }

  Future<void> _realign() async {
    final clockIndex = _clockIndex;
    final clock = _clockPlayer;
    if (_realigning ||
        !_playing ||
        clockIndex == null ||
        clock == null ||
        _players.length < 2) {
      return;
    }
    final live = [
      for (final entry in _players.entries)
        if (_liveAngles.contains(entry.key)) entry.value,
    ];
    final loading = [for (final p in live) _reallyLoading(p)];
    if (loading.contains(true)) {
      if (!_holding) {
        _holding = true;
        for (var i = 0; i < live.length; i++) {
          if (!loading[i]) live[i].pause();
        }
      }
      return;
    }
    if (_holding) {
      _holding = false;
      for (final p in live) {
        p.play();
      }
    }
    _realigning = true;
    try {
      await AngleSync.keepInLine(
        clock: clock,
        clockTrim: _trimOf(clockIndex),
        others: {
          for (final entry in _players.entries)
            if (entry.key != clockIndex && _liveAngles.contains(entry.key))
              entry.value: _trimOf(entry.key),
        },
      );
    } finally {
      _realigning = false;
    }
  }

  Future<void> _seek(Duration to) async {
    final target =
        to < Duration.zero ? Duration.zero : (to > _duration ? _duration : to);
    if (_onTv) {
      TvLink.instance.send(TvAction.seek, {'atMs': target.inMilliseconds});
      setState(() => _position = target);
      return;
    }
    await Future.wait([
      for (final entry in _players.entries)
        entry.value.seekTo(target + _trimOf(entry.key)),
      AngleSync.resetSpeeds(_players.values),
    ]);
    if (mounted) setState(() => _position = target);
  }

  void _step(int delta) => _goTo(_index + delta);

  void _goTo(int index) {
    final list = _videos?.recordings;
    if (list == null || index == _index) return;
    if (index < 0 || index >= list.length) return;
    _index = index;
    _openRecording();
  }

  void _openTake(int index) {
    setState(() => _picking = false);
    _index = index;
    _openRecording();
  }

  Future<void> _backToList() async {
    if (_onTv) TvLink.instance.send(TvAction.idle);
    _keepInLine?.cancel();
    await _closeAllPlayers();
    if (!mounted) return;
    setState(() {
      _picking = true;
      _playing = false;
      _midTake = false;
      _focused = null;
    });
  }

  @override
  void dispose() {
    TvLink.instance.removeListener(_onTvChanged);
    _tvStates?.cancel();
    _refresher.dispose();
    if (_onTv) TvLink.instance.send(TvAction.idle);
    _keepInLine?.cancel();
    _closeAllPlayers();
    _barAt.dispose();
    _loadedTo.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Back closes an expanded angle, then returns from a recording to the
    // list, before leaving the screen.
    final playingFromList = _hasList && !_picking;
    return PopScope(
      canPop: _focused == null && !playingFromList,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (_focused != null) {
          _setFocus(null);
        } else if (playingFromList) {
          _backToList();
        }
      },
      child: _picking ? _recordingList() : _screen(),
    );
  }

  /// The session's recordings, one card each: its number, when it started
  /// and how many angles it has.
  Widget _recordingList() {
    final team = TeamAccent.of(context);
    final list = _videos?.recordings ?? const <SessionRecording>[];
    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: Column(
          children: [
            _header(),
            Expanded(
              child: GridView.builder(
                padding: const EdgeInsets.fromLTRB(21, 4, 21, 21),
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 420,
                  mainAxisExtent: 84,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                ),
                itemCount: list.length,
                itemBuilder: (context, i) {
                  final r = list[i];
                  final angles = r.videos.where((v) => v.url != null).length;
                  final at = DateTime.fromMillisecondsSinceEpoch(r.startedAtMs);
                  return Material(
                    color: kSurface,
                    borderRadius: BorderRadius.circular(14),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(14),
                      onTap: () => _openTake(i),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Row(
                          children: [
                            Container(
                              width: 48,
                              height: 48,
                              decoration: BoxDecoration(
                                color: team.fill,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Icon(Icons.play_arrow,
                                  color: team.ink, size: 28),
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Recording ${r.number.toString().padLeft(3, '0')}',
                                    style: const TextStyle(
                                      color: Colors.white,
                                      fontSize: 17,
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${_clockTime(at)} · $angles ${angles == 1 ? 'angle' : 'angles'}',
                                    style: const TextStyle(
                                        color: kMuted, fontSize: 13),
                                  ),
                                ],
                              ),
                            ),
                            const Icon(Icons.chevron_right, color: kMuted),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// TV mode: the angles play on the TV, and this is the remote. Tap an
  /// angle to show it on its own there; the timeline, comments and
  /// play/skip work as usual.
  Widget _remote(SessionRecording recording) {
    final team = TeamAccent.of(context);
    final angles = _tvAngles;
    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: Column(
          children: [
            _header(),
            Padding(
              padding: const EdgeInsets.fromLTRB(21, 0, 21, 8),
              child: Text(
                recordingDisplayName(recording.startedAtMs, recording.number),
                style: const TextStyle(color: kMuted, fontSize: 13),
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(21, 0, 21, 8),
                children: [
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: kSurface,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.tv, color: team.accent, size: 32),
                        const SizedBox(width: 14),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Playing on your TV',
                                  style: TextStyle(
                                      color: Colors.white,
                                      fontSize: 17,
                                      fontWeight: FontWeight.w700)),
                              SizedBox(height: 2),
                              Text(
                                  'Tap an angle to show it on its own, or its '
                                  'speaker to hear it.',
                                  style: TextStyle(color: kMuted)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (_tvFocused == null && _tvPageCount > 1)
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        IconButton(
                          onPressed: _tvPage > 0
                              ? () => TvLink.instance
                                  .send(TvAction.page, {'page': _tvPage - 1})
                              : null,
                          tooltip: 'Previous angles',
                          color: team.accent,
                          icon: const Icon(Icons.chevron_left),
                        ),
                        Text('Page ${_tvPage + 1} of $_tvPageCount',
                            style: const TextStyle(color: kMuted)),
                        IconButton(
                          onPressed: _tvPage < _tvPageCount - 1
                              ? () => TvLink.instance
                                  .send(TvAction.page, {'page': _tvPage + 1})
                              : null,
                          tooltip: 'More angles',
                          color: team.accent,
                          icon: const Icon(Icons.chevron_right),
                        ),
                      ],
                    )
                  else
                    const SizedBox(height: 12),
                  for (final (k, i) in angles.indexed)
                    ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                      leading: Icon(
                        _tvFocused == k
                            ? Icons.fullscreen_exit
                            : Icons.videocam_outlined,
                        color: _tvFocused == k ? team.accent : kMuted,
                      ),
                      title: Text(recording.videos[i].name,
                          style: TextStyle(
                              color:
                                  _tvFocused == k ? team.accent : Colors.white,
                              fontWeight: _tvFocused == k
                                  ? FontWeight.w700
                                  : FontWeight.w500)),
                      subtitle: _tvFocused == k
                          ? const Text('On its own. Tap for every angle.',
                              style: TextStyle(color: kMuted))
                          : null,
                      // One angle's sound plays on the TV; tap another to
                      // switch, or the playing one to mute.
                      trailing: IconButton(
                        onPressed: () => TvLink.instance.send(
                            TvAction.sound, {'angle': _tvSound == k ? -1 : k}),
                        tooltip: _tvSound == k
                            ? 'Mute'
                            : 'Hear this angle on the TV',
                        icon: Icon(
                          _tvSound == k
                              ? Icons.volume_up
                              : Icons.volume_off_outlined,
                          color: _tvSound == k ? team.accent : kMuted,
                        ),
                      ),
                      onTap: () => TvLink.instance.send(
                          TvAction.focus, {'angle': _tvFocused == k ? -1 : k}),
                    ),
                ],
              ),
            ),
            _liveComment(recording),
            _timeline(),
            _transport(),
          ],
        ),
      ),
    );
  }

  /// "5:10 PM"
  static String _clockTime(DateTime at) {
    final hour = at.hour % 12 == 0 ? 12 : at.hour % 12;
    final minute = at.minute.toString().padLeft(2, '0');
    return '$hour:$minute ${at.hour < 12 ? 'AM' : 'PM'}';
  }

  Widget _screen() {
    final recording = _recording;
    if (_onTv && recording != null) return _remote(recording);

    // Sideways on a phone: the angles take the screen, with the controls in
    // one slim bar, since a tall header and footer would leave them no room.
    if (_landscape && !_bigScreen) return _sidewaysLayout(recording);

    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: Column(
          children: [
            _header(),
            if (recording != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(21, 0, 21, 8),
                child: Text(
                  recordingDisplayName(recording.startedAtMs, recording.number),
                  style: const TextStyle(color: kMuted, fontSize: 13),
                ),
              ),
            Expanded(child: _body()),
            if (recording != null) ...[
              _liveComment(recording),
              _timeline(),
            ],
            if (recording != null && !_gridMode && _uploadedAngles.length > 1)
              _stillStrip(recording),
            if (_gridMode && _pageCount > 1 && _focused == null) _pageBar(),
            _transport(),
          ],
        ),
      ),
    );
  }

  Widget _header() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
      child: Row(
        children: [
          IconButton(
            onPressed: () => Navigator.of(context).maybePop(),
            icon: const Icon(Icons.arrow_back, color: Colors.white, size: 28),
            tooltip: 'Back',
          ),
          Expanded(
            child: Text(
              widget.session.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: TeamAccent.of(context).accent,
                fontSize: 24,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.24,
              ),
            ),
          ),
          if (_recording != null && (_videos?.canDelete ?? false))
            IconButton(
              onPressed: _deleteRecording,
              tooltip: 'Delete this recording',
              color: const Color(0xFFE5484D),
              icon: const Icon(Icons.delete_outline, size: 24),
            ),
          if (_recording != null)
            IconButton(
              onPressed: _downloading ? null : _download,
              tooltip: 'Download session',
              color: Colors.white,
              icon: _downloading
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.download, size: 24),
            ),
          if (_recording != null && !_picking)
            IconButton(
              onPressed: _showComments,
              tooltip: 'Show comments',
              color: Colors.white,
              icon: const Icon(Icons.comment_outlined, size: 24),
            ),
        ],
      ),
    );
  }

  /// Comment dots are blue, like the web's.
  static const _commentBlue = Color(0xFF3B82F6);

  /// The comment playback is passing, shown for a few seconds from the
  /// moment it was left; the commenter (or an admin) can delete it here.
  Widget _liveComment(SessionRecording recording) {
    SessionNote? live;
    for (final n in _notes) {
      final at = Duration(milliseconds: n.videoTimeMs);
      if (_position >= at && _position < at + const Duration(seconds: 3)) {
        live = n;
      }
    }
    return SizedBox(
      height: 40,
      child: live == null
          ? null
          : Padding(
              padding: const EdgeInsets.symmetric(horizontal: 21),
              child: Row(
                children: [
                  const Icon(Icons.circle, size: 10, color: _commentBlue),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text.rich(
                      TextSpan(children: [
                        TextSpan(
                          text: '${live.authorName}: ',
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        TextSpan(text: live.body),
                      ]),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.white, fontSize: 14),
                    ),
                  ),
                  if (live.canDelete)
                    IconButton(
                      onPressed: () => _deleteNote(recording, live!),
                      tooltip: 'Delete comment',
                      color: const Color(0xFFFF6B6B),
                      icon: const Icon(Icons.close, size: 20),
                    ),
                ],
              ),
            ),
    );
  }

  /// A scrub bar with a blue dot wherever someone left a comment. Tap the
  /// bar to jump there, drag the handle to scrub (the angles follow a few
  /// times a second; letting go lands exactly there, playing again if it
  /// was), or tap a dot to jump to its comment.
  Widget _timeline() {
    final team = TeamAccent.of(context);
    final total = _duration.inMilliseconds;
    return Padding(
      padding: const EdgeInsets.fromLTRB(21, 0, 21, 4),
      child: SizedBox(
        height: 32,
        child: LayoutBuilder(builder: (context, constraints) {
          final width = constraints.maxWidth;
          double xOf(int ms) =>
              total <= 0 ? 0 : (ms / total).clamp(0.0, 1.0) * width;
          Duration at(double dx) => Duration(
              milliseconds: (dx / width * total).round().clamp(0, total));
          return GestureDetector(
            behavior: HitTestBehavior.opaque,
            // On lifting a tap, so a press that turns into a drag doesn't
            // move the videos first.
            onTapUp: total <= 0 ? null : (d) => _seek(at(d.localPosition.dx)),
            onHorizontalDragStart: total <= 0
                ? null
                : (d) {
                    _dragWasPlaying = _playing;
                    if (_playing) _pause();
                    final to = at(d.localPosition.dx);
                    _fetchSheetsNear(to);
                    setState(() {
                      _dragTo = to;
                      if (_haveStills) _stillsAt = to;
                    });
                  },
            onHorizontalDragUpdate: total <= 0
                ? null
                : (d) {
                    final to = at(d.localPosition.dx);
                    // With stills, every angle shows this instant at once;
                    // the videos stay put until it's let go.
                    if (_haveStills) {
                      setState(() => _dragTo = _stillsAt = to);
                      _fetchSheetsNear(to);
                      return;
                    }
                    setState(() => _dragTo = to);
                    final now = DateTime.now();
                    // Shown as it moves only where it's loaded already;
                    // elsewhere the angles hold still until let go, rather
                    // than start downloads thrown away a moment later.
                    if (now.difference(_dragSeekAt).inMilliseconds >= 200 &&
                        _loadedAt(to)) {
                      _dragSeekAt = now;
                      unawaited(_seek(to));
                    }
                  },
            onHorizontalDragEnd: total <= 0
                ? null
                : (_) async {
                    final to = _dragTo;
                    setState(() => _dragTo = null);
                    if (to != null) await _seek(to);
                    // The stills stay up until every angle can play from
                    // there, then they all start together.
                    if (_stillsAt != null) {
                      await _untilPlayable();
                      if (!mounted) return;
                      setState(() => _stillsAt = null);
                    }
                    if (_dragWasPlaying && mounted) _play();
                  },
            child: ListenableBuilder(
              listenable: Listenable.merge([_barAt, _loadedTo]),
              builder: (context, _) {
                final barAt = _barAt.value;
                final shown =
                    _dragTo ?? (_playing && !_onTv ? barAt : _position);
                final x = xOf(shown.inMilliseconds);
                final handle = _dragTo != null ? 22.0 : 16.0;
                return Stack(
                  alignment: Alignment.centerLeft,
                  clipBehavior: Clip.none,
                  children: [
                    Container(
                      height: 5,
                      decoration: BoxDecoration(
                        color: const Color(0xFF3A3A3A),
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                    Container(
                      width: xOf(_loadedTo.value.inMilliseconds),
                      height: 5,
                      decoration: BoxDecoration(
                        color: const Color(0xFF8A8A8A),
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                    Container(
                      width: x,
                      height: 5,
                      decoration: BoxDecoration(
                        color: team.accent,
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                    for (final n in _notes)
                      Positioned(
                        left: xOf(n.videoTimeMs) - 7,
                        child: GestureDetector(
                          onTap: () =>
                              _seek(Duration(milliseconds: n.videoTimeMs)),
                          child: Container(
                            width: 14,
                            height: 14,
                            decoration: BoxDecoration(
                              color: _commentBlue,
                              shape: BoxShape.circle,
                              border: Border.all(color: kBackground, width: 2),
                            ),
                          ),
                        ),
                      ),
                    if (total > 0)
                      Positioned(
                        left: x - handle / 2,
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 100),
                          width: handle,
                          height: handle,
                          decoration: const BoxDecoration(
                            color: Colors.white,
                            shape: BoxShape.circle,
                            boxShadow: [
                              BoxShadow(blurRadius: 3, color: Colors.black54),
                            ],
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
          );
        }),
      ),
    );
  }

  Widget _body() {
    final team = TeamAccent.of(context);
    if (_loading) {
      return Center(child: CircularProgressIndicator(color: team.accent));
    }
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: EmptyState(
          title: "Couldn't load this session",
          message: _error!,
          actionLabel: 'Retry',
          onAction: _load,
        ),
      );
    }
    final recording = _recording;
    if (recording == null) {
      return const Padding(
        padding: EdgeInsets.all(20),
        child: EmptyState(
          title: 'No videos uploaded yet',
          message: 'Videos from this session appear here as each phone '
              'finishes uploading.',
        ),
      );
    }

    if (!_gridMode) {
      // One camera, as large as the screen allows, edge to edge in its own
      // shape (the selected still in the strip below marks which one it is).
      final player = _players[_selected];
      final ratio = player != null && player.value.isInitialized
          ? player.value.aspectRatio
          : 16 / 9;
      return Padding(
        padding: const EdgeInsets.fromLTRB(21, 0, 21, 12),
        child: Center(
          child: AspectRatio(
            aspectRatio: ratio,
            child: _AngleTile(
              video: recording.videos[_selected],
              player: player,
              fit: BoxFit.contain,
              still: _stillFor(_selected, BoxFit.contain),
            ),
          ),
        ),
      );
    }

    // The best-fit grid for this page: each angle in its own shape, as
    // large as the screen allows, rows centered (like the web). Tapping one
    // expands it to fill the space; tapping it again goes back.
    final focused = _focused;
    final angles = focused != null ? [focused] : _pageAngles;
    final aspect = commonAspect([
      for (final i in angles)
        if (_players[i]?.value.isInitialized ?? false)
          _players[i]!.value.aspectRatio
    ]);
    return Padding(
      padding: _landscape && !_bigScreen
          ? const EdgeInsets.all(4)
          : const EdgeInsets.fromLTRB(21, 0, 21, 12),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final rects = gridLayout(constraints.biggest, angles.length, aspect);
          return Stack(
            children: [
              for (var k = 0; k < rects.length; k++)
                Positioned.fromRect(
                  rect: rects[k],
                  child: Semantics(
                    button: true,
                    label: focused != null
                        ? 'Back to all angles'
                        : 'Expand ${recording.videos[angles[k]].name}',
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () =>
                          _setFocus(focused != null ? null : angles[k]),
                      child: _AngleTile(
                        video: recording.videos[angles[k]],
                        player: _players[angles[k]],
                        fit: BoxFit.contain,
                        still: _stillFor(angles[k], BoxFit.contain),
                      ),
                    ),
                  ),
                ),
              if (focused != null && rects.isNotEmpty)
                Positioned(
                  top: rects.first.top + 6,
                  right: constraints.maxWidth - rects.first.right + 6,
                  child: const IgnorePointer(
                    child: Icon(Icons.fullscreen_exit,
                        color: Colors.white,
                        shadows: [Shadow(blurRadius: 6, color: Colors.black)]),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  /// Upright: the other angles under the big one, as stills of the current
  /// moment (or name cards past the first few). Tap one to make it the big
  /// angle.
  Widget _stillStrip(SessionRecording recording) {
    final team = TeamAccent.of(context);
    final angles = _uploadedAngles;
    return SizedBox(
      height: 86,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(21, 4, 21, 6),
        itemCount: angles.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, k) {
          final i = angles[k];
          final selected = i == _selected;
          return Semantics(
            button: true,
            selected: selected,
            label: 'Show ${recording.videos[i].name}',
            child: GestureDetector(
              onTap: () => _selectAngle(i),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                width: 76 * 16 / 9,
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(
                  color: selected ? team.fill : Colors.transparent,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: _AngleTile(
                  video: recording.videos[i],
                  player: _players[i],
                  fit: BoxFit.cover,
                  missingLabel: 'Tap to show',
                  still: _stillFor(i, BoxFit.cover),
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  /// Grid pages: which page of angles is showing, with arrows.
  Widget _pageBar() {
    final team = TeamAccent.of(context);
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        IconButton(
          onPressed: _page > 0 ? () => _changePage(-1) : null,
          tooltip: 'Previous angles',
          color: team.accent,
          icon: const Icon(Icons.chevron_left),
        ),
        Text('${_page + 1} / $_pageCount',
            style: const TextStyle(color: kMuted)),
        IconButton(
          onPressed: _page < _pageCount - 1 ? () => _changePage(1) : null,
          tooltip: 'More angles',
          color: team.accent,
          icon: const Icon(Icons.chevron_right),
        ),
      ],
    );
  }

  /// Sideways on a phone: the grid fills the screen; back, the page and the
  /// comment pop-up sit over it, and one slim bar holds the controls.
  Widget _sidewaysLayout(SessionRecording? recording) {
    final team = TeamAccent.of(context);
    final enabled = _ready;
    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Stack(
                children: [
                  Positioned.fill(child: _body()),
                  Positioned(
                    top: 0,
                    left: 0,
                    child: IconButton(
                      onPressed: () => Navigator.of(context).maybePop(),
                      icon: const Icon(Icons.arrow_back,
                          color: Colors.white,
                          shadows: [
                            Shadow(blurRadius: 6, color: Colors.black)
                          ]),
                      tooltip: _focused != null ? 'Back to all angles' : 'Back',
                    ),
                  ),
                  if (_pageCount > 1 && _focused == null)
                    Positioned(
                      top: 0,
                      right: 0,
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.black54,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: _pageBar(),
                      ),
                    ),
                  if (recording != null)
                    Positioned(
                      left: 40,
                      right: 40,
                      bottom: 4,
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.black54,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: _liveComment(recording),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 2),
              child: Row(
                children: [
                  IconButton(
                    onPressed: enabled ? (_playing ? _pause : _play) : null,
                    tooltip: _playing ? 'Pause' : 'Play',
                    color: team.accent,
                    icon: Icon(_playing ? Icons.pause : Icons.play_arrow),
                  ),
                  Expanded(child: _timeline()),
                  Text(
                    '${formatClock(_dragTo ?? _position)} / ${formatClock(_duration)}',
                    style: TextStyle(color: team.accent, fontSize: 13),
                  ),
                  if (recording != null)
                    IconButton(
                      onPressed: _showComments,
                      tooltip: 'Show comments',
                      color: Colors.white,
                      icon: const Icon(Icons.comment_outlined),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _transport() {
    final team = TeamAccent.of(context);
    final count = _videos?.recordings.length ?? 0;
    final enabled = _ready;

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 4, 21, 16),
      child: Row(
        children: [
          IconButton(
            onPressed: _index > 0 ? () => _step(-1) : null,
            tooltip: 'Previous recording',
            icon: const Icon(Icons.skip_previous),
            color: team.accent,
            disabledColor: kFaint,
            iconSize: 30,
          ),
          Material(
            color: enabled ? team.fill : kFaint,
            shape: const CircleBorder(),
            child: InkWell(
              onTap: enabled ? (_playing ? _pause : _play) : null,
              customBorder: const CircleBorder(),
              child: SizedBox(
                width: 44,
                height: 44,
                child: Icon(
                  _playing ? Icons.pause : Icons.play_arrow,
                  color: enabled ? team.ink : Colors.black,
                  size: 28,
                ),
              ),
            ),
          ),
          IconButton(
            onPressed: _index < count - 1 ? () => _step(1) : null,
            tooltip: 'Next recording',
            icon: const Icon(Icons.skip_next),
            color: team.accent,
            disabledColor: kFaint,
            iconSize: 30,
          ),
          const Spacer(),
          GestureDetector(
            // Tapping the clock nudges back ten seconds; the web has a scrub
            // bar, which can come once thumbnails land.
            onTap: enabled
                ? () => _seek(_position - const Duration(seconds: 10))
                : null,
            child: Text(
              '${formatClock(_dragTo ?? _position)} / ${formatClock(_duration)}',
              style: TextStyle(
                color: team.accent.withValues(alpha: 0.8),
                fontSize: 22,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        ],
      ),
    );
  }

  bool _downloading = false;

  /// Downloads the whole session as one zip (a folder per recording, an
  /// angle per member) and opens the share sheet, so it can go to Files,
  /// Drive, a computer or a USB stick plugged into the phone.
  Future<void> _download() async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _downloading = true);
    messenger
        .showSnackBar(const SnackBar(content: Text('Preparing the download…')));
    File? file;
    try {
      final api = widget.auth.api;
      final cookie = api.cookie;
      final request = http.Request(
        'GET',
        Uri.parse('${api.baseUrl}/api/recordings/sessions/'
            '${widget.session.id}/download'),
      );
      if (cookie != null) request.headers['Cookie'] = cookie;
      final response = await http.Client().send(request);
      if (response.statusCode != 200) {
        throw ApiException(response.statusCode,
            'The download is not available right now (${response.statusCode}).');
      }
      final name = _zipName(response.headers['content-disposition']) ??
          '${widget.session.name}.zip';
      final dir = await getTemporaryDirectory();
      file = File('${dir.path}/$name');
      final sink = file.openWrite();
      await response.stream.pipe(sink);
      if (!mounted) return;
      messenger.hideCurrentSnackBar();
      await SharePlus.instance.share(ShareParams(
        files: [XFile(file.path, mimeType: 'application/zip')],
        subject: widget.session.name,
      ));
    } on ApiException catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } catch (_) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(const SnackBar(
          content: Text("Couldn't download the session. Try again.")));
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  /// The file name the server suggests, e.g. "Stunt practice 2026-10-07.zip".
  static String? _zipName(String? disposition) {
    final match = RegExp(r'filename="([^"]+)"').firstMatch(disposition ?? '');
    final name = match?.group(1)?.replaceAll(RegExp(r'[/\\]'), '');
    return name == null || name.isEmpty ? null : name;
  }

  void _showAddComment() {
    final recording = _recording;
    if (recording == null) return;
    // Typing takes a while, so hold the picture still: the comment is
    // stamped with the moment on screen when the sheet opened, and its dot
    // lands there.
    if (_playing) _pause();
    final at = _clockAt;

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: TeamAccent.of(context).fillLight,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) => _AddCommentSheet(
        at: at,
        onAdd: (body) => _addNote(recording, body, at),
      ),
    );
  }

  void _showComments() {
    final recording = _recording;
    if (recording == null) return;
    final notes = [..._notes]
      ..sort((a, b) => a.videoTimeMs.compareTo(b.videoTimeMs));
    SessionNote? selected;
    var addingComment = false;
    final team = TeamAccent.of(context);

    // Dark like the rest of the app, and no taller than it needs (half the
    // screen at most), with a light scrim so the video stays in view.
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: kSurface,
      barrierColor: Colors.black38,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => _CommentsSheet(
        notes: notes,
        at: _clockAt,
        accent: team.accent,
        fill: team.fill,
        onSelect: (note) {
          selected = note;
          Navigator.of(sheetContext).pop();
        },
        onAdd: () {
          addingComment = true;
          Navigator.of(sheetContext).pop();
        },
      ),
    ).whenComplete(() {
      if (!mounted) return;
      if (selected != null) {
        unawaited(_seek(Duration(milliseconds: selected!.videoTimeMs)));
      } else if (addingComment) {
        _showAddComment();
      }
    });
  }

  Future<List<SessionNote>> _addNote(
    SessionRecording recording,
    String body,
    Duration at,
  ) async {
    await _recordings.createSessionNote(
      widget.session.id,
      recording.startedAtMs,
      body,
      at.inMilliseconds,
    );
    final notes = await _recordings.getSessionNotes(
      widget.session.id,
      recording.startedAtMs,
    );
    if (mounted && _recording == recording) setState(() => _notes = notes);
    return notes;
  }

  Future<List<SessionNote>> _deleteNote(
    SessionRecording recording,
    SessionNote note,
  ) async {
    await _recordings.deleteSessionNote(widget.session.id, note.id);
    final notes = [
      for (final n in _notes)
        if (n.id != note.id) n,
    ];
    if (mounted && _recording == recording) setState(() => _notes = notes);
    return notes;
  }
}

class _CommentsSheet extends StatelessWidget {
  const _CommentsSheet({
    required this.notes,
    required this.at,
    required this.accent,
    required this.fill,
    required this.onSelect,
    required this.onAdd,
  });

  final List<SessionNote> notes;

  /// Where the video is: a new comment is stamped there.
  final Duration at;

  /// The team color as text on dark, and as a button's fill.
  final Color accent;
  final Color fill;
  final ValueChanged<SessionNote> onSelect;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final maxHeight = MediaQuery.sizeOf(context).height * 0.5;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 6),
                  decoration: BoxDecoration(
                    color: kSurfaceLight,
                    borderRadius: BorderRadius.circular(4),
                  ),
                ),
              ),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Comments (${notes.length})',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    tooltip: 'Close comments',
                    icon: const Icon(Icons.close, color: kMuted),
                  ),
                ],
              ),
              if (notes.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 18),
                  child: Text(
                    'No comments on this recording yet.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: kMuted),
                  ),
                )
              else
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    padding: EdgeInsets.zero,
                    itemCount: notes.length,
                    itemBuilder: (context, index) => _commentRow(notes[index]),
                  ),
                ),
              const SizedBox(height: 10),
              Tooltip(
                message: 'Add a comment',
                child: FilledButton.icon(
                  onPressed: onAdd,
                  style: FilledButton.styleFrom(
                    backgroundColor: fill,
                    foregroundColor: inkOn(fill),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  icon: const Icon(Icons.add_comment_outlined, size: 20),
                  label: Text('Add a comment at ${formatClock(at)}'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// One comment: its moment as a team-colored tag, then who and what.
  /// Tapping it jumps the video there.
  Widget _commentRow(SessionNote note) {
    return InkWell(
      onTap: () => onSelect(note),
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                formatClock(Duration(milliseconds: note.videoTimeMs)),
                style: TextStyle(
                  color: accent,
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    note.authorName,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    note.body,
                    style: const TextStyle(color: Colors.white70, height: 1.3),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AngleTile extends StatelessWidget {
  const _AngleTile({
    required this.video,
    required this.player,
    this.fit = BoxFit.cover,
    this.missingLabel = 'Not uploaded',
    this.still,
  });

  final AngleVideo video;

  /// Over the video while the seek bar is dragged: its still for the moment
  /// under the finger.
  final Widget? still;
  final VideoPlayerController? player;
  final BoxFit fit;

  /// Shown when there's no player: not uploaded, or (in the stills strip)
  /// an angle past the first few that only loads when picked.
  final String missingLabel;

  static const _panel = Color(0xFF49454F);

  /// Beside the name: the upload's stage and how far along, "Waiting for
  /// connection" when it stopped, or "Preview" while one plays.
  String? get _uploadLabel {
    final upload = video.upload;
    if (upload == null) return video.previewOnly ? 'Preview' : null;
    if (upload.stalled) return 'Waiting for connection';
    final percent = (upload.fraction * 100).round();
    return upload.stage == 'preview'
        ? 'Preview $percent%'
        : 'Full quality $percent%';
  }

  @override
  Widget build(BuildContext context) {
    final p = player;
    return ClipRRect(
      borderRadius: BorderRadius.circular(4),
      child: Container(
        color: _panel,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (p != null && p.value.isInitialized)
              FittedBox(
                fit: fit,
                child: SizedBox(
                  width: p.value.size.width,
                  height: p.value.size.height,
                  child: VideoPlayer(p),
                ),
              )
            // The upload's stage and percent once the device reports it.
            // No spinner: the only one is on an angle that's loading to
            // play, so it's clear which that is.
            else if (video.upload != null && _uploadLabel != null)
              Center(
                child: Text(
                  _uploadLabel!,
                  style: TextStyle(
                    color: video.upload!.stalled
                        ? const Color(0xFF8A8A8A)
                        : const Color(0xFFE8E8E8),
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              )
            else if (video.stillUploading)
              const Center(
                child: Text('Uploading…',
                    style: TextStyle(color: Color(0xFFCFCBD6), fontSize: 12)),
              )
            else
              Center(
                child: Text(
                  video.url == null ? 'Not uploaded' : missingLabel,
                  style:
                      const TextStyle(color: Color(0xFFCFCBD6), fontSize: 12),
                ),
              ),
            if (still case final still?) Positioned.fill(child: still),
            // This angle is loading to play: marked on its own tile, so it's
            // clear which one everything's waiting on.
            if (p != null && p.value.isInitialized)
              _LoadingAfterDelay(
                player: p,
                child: const ColoredBox(
                  color: Color(0x73000000),
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox.square(
                          dimension: 22,
                          child: CircularProgressIndicator(
                              strokeWidth: 2.5, color: Colors.white),
                        ),
                        SizedBox(height: 8),
                        Text('Loading',
                            style: TextStyle(
                                color: Colors.white,
                                fontSize: 12,
                                fontWeight: FontWeight.w600)),
                      ],
                    ),
                  ),
                ),
              ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                color: Colors.black45,
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        video.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            const TextStyle(color: Colors.white, fontSize: 11),
                      ),
                    ),
                    // With a preview playing, its upload's stage goes
                    // here; with nothing playing yet, it's in the middle.
                    if (p != null && p.value.isInitialized)
                      if (_uploadLabel case final label?)
                        Text(label,
                            style: const TextStyle(
                                color: Color(0xFFFFCC66), fontSize: 10)),
                  ],
                ),
              ),
            ),
            // How far along the upload is, along the bottom edge.
            if (video.upload case final upload?)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: LinearProgressIndicator(
                  value: upload.fraction,
                  minHeight: 3,
                  backgroundColor: Colors.white12,
                  color: upload.stalled
                      ? const Color(0xFF8A8A8A)
                      : TeamAccent.of(context).accent,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Adds one comment at [at]. There's no list: comments show as dots on the
/// timeline and pop up as playback reaches them.
class _AddCommentSheet extends StatefulWidget {
  const _AddCommentSheet({required this.at, required this.onAdd});

  final Duration at;

  /// Saves the comment and returns the recording's refreshed comments.
  final Future<List<SessionNote>> Function(String body) onAdd;

  @override
  State<_AddCommentSheet> createState() => _AddCommentSheetState();
}

class _AddCommentSheetState extends State<_AddCommentSheet> {
  final _text = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _post() async {
    final body = _text.text.trim();
    if (body.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onAdd(body);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      // The text stays so it can be sent again.
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException
              ? e.message
              : 'Something went wrong. Try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // The sheet is a light tint of the team color; text is black or white,
    // whichever reads on it.
    final sheet = TeamAccent.of(context).fillLight;
    final ink = inkOn(sheet);
    return SafeArea(
      child: Padding(
        // Keeps the comment box above the keyboard.
        padding: EdgeInsets.fromLTRB(
            20, 16, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Comment at ${formatClock(widget.at)}',
              style: TextStyle(
                  color: ink, fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _text,
                    autofocus: true,
                    maxLength: 500,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _post(),
                    decoration: const InputDecoration(
                      hintText: 'What should they look at?',
                      counterText: '',
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _busy ? null : _post,
                  style: FilledButton.styleFrom(
                      backgroundColor: ink, foregroundColor: sheet),
                  child: Text(_busy ? 'Posting…' : 'Post'),
                ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(color: ink)),
            ],
          ],
        ),
      ),
    );
  }
}

/// Shows [child] while [player] is loading, but only once it has been for
/// a moment: a jump reports a blip of buffering even into a part that's
/// loaded already, which would otherwise flash "Loading".
class _LoadingAfterDelay extends StatefulWidget {
  const _LoadingAfterDelay({required this.player, required this.child});

  final VideoPlayerController player;
  final Widget child;

  @override
  State<_LoadingAfterDelay> createState() => _LoadingAfterDelayState();
}

class _LoadingAfterDelayState extends State<_LoadingAfterDelay> {
  Timer? _timer;
  bool _shown = false;

  @override
  void initState() {
    super.initState();
    widget.player.addListener(_changed);
    _changed();
  }

  @override
  void didUpdateWidget(_LoadingAfterDelay old) {
    super.didUpdateWidget(old);
    if (old.player != widget.player) {
      old.player.removeListener(_changed);
      widget.player.addListener(_changed);
      _changed();
    }
  }

  void _changed() {
    if (!widget.player.value.isBuffering) {
      _timer?.cancel();
      _timer = null;
      if (_shown) setState(() => _shown = false);
      return;
    }
    _timer ??= Timer(const Duration(milliseconds: 500), () {
      if (mounted) setState(() => _shown = true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.player.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      _shown ? widget.child : const SizedBox.shrink();
}

/// One still out of a sheet of them (see [ScrubStills]), fitted to its tile
/// like the video under it. Nothing until its sheet has downloaded: the
/// paused video shows meanwhile.
class _ScrubStill extends StatelessWidget {
  const _ScrubStill({
    required this.scrub,
    required this.sheet,
    required this.col,
    required this.row,
    required this.fit,
  });

  final ScrubStills scrub;
  final ImageProvider sheet;
  final int col;
  final int row;
  final BoxFit fit;

  @override
  Widget build(BuildContext context) {
    final w = scrub.width.toDouble();
    final h = scrub.height.toDouble();
    return Image(
      image: sheet,
      width: w * scrub.cols,
      height: h * scrub.rows,
      fit: BoxFit.fill,
      frameBuilder: (context, image, frame, _) => frame == null
          ? const SizedBox.shrink()
          : ColoredBox(
              color: Colors.black,
              child: FittedBox(
                fit: fit,
                clipBehavior: Clip.hardEdge,
                child: SizedBox(
                  width: w,
                  height: h,
                  child: ClipRect(
                    child: OverflowBox(
                      alignment: Alignment.topLeft,
                      minWidth: w * scrub.cols,
                      maxWidth: w * scrub.cols,
                      minHeight: h * scrub.rows,
                      maxHeight: h * scrub.rows,
                      child: Transform.translate(
                        offset: Offset(-col * w, -row * h),
                        child: image,
                      ),
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}

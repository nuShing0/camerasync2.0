import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Thrown for non-2xx responses so callers can show the server's message.
class ApiException implements Exception {
  ApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  @override
  String toString() => message;
}

/// Minimal HTTP client that carries the server's session cookie.
///
/// The browser does this automatically, but Dart's http package does not — so
/// we capture `Set-Cookie` from responses and replay it as a `Cookie` header on
/// later requests. The value is persisted so a session survives app restarts.
class ApiClient {
  ApiClient(this.baseUrl);

  final String baseUrl;

  static const _cookiePrefsKey = 'session_cookie';

  String? _cookie;

  /// The stored `session=...` pair, for callers that open their own
  /// authenticated connections (e.g. the Socket.IO handshake).
  String? get cookie => _cookie;

  /// Load any persisted cookie. Call once during app start-up.
  Future<void> loadPersistedCookie() async {
    final prefs = await SharedPreferences.getInstance();
    _cookie = prefs.getString(_cookiePrefsKey);
  }

  Future<void> _persistCookie(String? value) async {
    _cookie = value;
    final prefs = await SharedPreferences.getInstance();
    if (value == null) {
      await prefs.remove(_cookiePrefsKey);
    } else {
      await prefs.setString(_cookiePrefsKey, value);
    }
  }

  Map<String, String> _headers({bool json = false}) => {
        if (json) 'Content-Type': 'application/json',
        if (_cookie != null) 'Cookie': _cookie!,
      };

  /// Pull the session cookie out of `Set-Cookie` and store it. We only keep the
  /// `name=value` pair — attributes like Path/HttpOnly aren't sent back.
  Future<void> _captureCookie(http.Response res) async {
    final raw = res.headers['set-cookie'];
    if (raw == null || raw.isEmpty) return;
    final pair = raw.split(';').first.trim();
    if (pair.isEmpty) return;
    if (pair.startsWith('session=')) {
      // An empty value means the server cleared it (logout).
      final value = pair.substring('session='.length);
      await _persistCookie(value.isEmpty ? null : pair);
    }
  }

  Future<dynamic> get(String path) => _send('GET', path);

  Future<dynamic> post(String path, [Map<String, dynamic>? body]) =>
      _send('POST', path, body);

  /// A POST the server takes a while to answer (it waits on [timeout]
  /// rather than the usual 15 seconds).
  Future<dynamic> postSlow(String path, Duration timeout) =>
      _send('POST', path, null, timeout);

  Future<dynamic> patch(String path, Map<String, dynamic> body) =>
      _send('PATCH', path, body);

  Future<dynamic> delete(String path, [Map<String, dynamic>? body]) =>
      _send('DELETE', path, body);

  Future<dynamic> _send(
    String method,
    String path, [
    Map<String, dynamic>? body,
    // Without a timeout an unreachable host can hang a request forever and
    // leave the UI stuck in its submitting state.
    Duration timeout = const Duration(seconds: 15),
  ]) async {
    final uri = Uri.parse('$baseUrl$path');
    late http.Response res;

    try {
      res = switch (method) {
        'POST' => await http
            .post(
              uri,
              headers: _headers(json: body != null),
              body: body == null ? null : jsonEncode(body),
            )
            .timeout(timeout),
        'PATCH' => await http
            .patch(
              uri,
              headers: _headers(json: true),
              body: jsonEncode(body),
            )
            .timeout(timeout),
        'DELETE' => await http
            .delete(
              uri,
              headers: _headers(json: body != null),
              body: body == null ? null : jsonEncode(body),
            )
            .timeout(timeout),
        _ => await http.get(uri, headers: _headers()).timeout(timeout),
      };
    } catch (_) {
      throw ApiException(0, "Can't reach the server at $baseUrl.");
    }

    await _captureCookie(res);
    return _decode(res);
  }

  /// Sends [length] bytes from [body] as the request body of a PUT (one
  /// piece of a resumable upload) and returns the decoded JSON reply.
  /// [onProgress] hears how many bytes of this piece have gone; throwing
  /// from it stops the request.
  Future<dynamic> putBytes(
    String path,
    Stream<List<int>> body,
    int length, {
    Duration timeout = const Duration(minutes: 5),
    void Function(int sent)? onProgress,
  }) async {
    final request = http.StreamedRequest('PUT', Uri.parse('$baseUrl$path'))
      ..headers.addAll(_headers())
      ..headers['Content-Type'] = 'application/octet-stream'
      ..contentLength = length;
    var sent = 0;
    unawaited(body
        .map((chunk) {
          sent += chunk.length;
          onProgress?.call(sent);
          return chunk;
        })
        .pipe(request.sink)
        .catchError((Object _) {}));
    late http.Response res;
    try {
      final streamed = await request.send().timeout(timeout);
      res = await http.Response.fromStream(streamed).timeout(timeout);
    } catch (_) {
      throw ApiException(0, "Can't reach the server at $baseUrl.");
    }
    await _captureCookie(res);
    return _decode(res);
  }

  /// Uploads one file from disk as a multipart form and returns the decoded
  /// JSON reply. A 1080p recording can take minutes on a phone connection, so
  /// this gets its own generous [timeout] rather than the 15 seconds used for
  /// ordinary JSON requests.
  ///
  /// The server identifies the media type from the filename's extension and
  /// the file's own header, so [filename] must keep the recording's extension
  /// (`.mp4`, `.mov`, ...).
  Future<dynamic> postFile(
    String path, {
    required String filePath,
    String field = 'file',
    String? filename,
    Duration timeout = const Duration(minutes: 10),
    void Function(int sent, int total)? onProgress,
  }) async {
    // The file is streamed from disk; counting the bytes as they're read
    // gives the upload's progress without holding the file in memory.
    final file = File(filePath);
    final total = await file.length();
    var sent = 0;
    final body = file.openRead().map((chunk) {
      sent += chunk.length;
      onProgress?.call(sent, total);
      return chunk;
    });
    final request = http.MultipartRequest('POST', Uri.parse('$baseUrl$path'))
      ..headers.addAll(_headers())
      ..files.add(http.MultipartFile(field, body, total,
          filename: filename ?? filePath.split('/').last));

    late http.Response res;
    try {
      final streamed = await request.send().timeout(timeout);
      res = await http.Response.fromStream(streamed).timeout(timeout);
    } catch (_) {
      throw ApiException(0, "Can't reach the server at $baseUrl.");
    }

    await _captureCookie(res);
    return _decode(res);
  }

  /// Turns a response into its JSON payload, or throws [ApiException] with
  /// the server's `error` message for a 4xx/5xx.
  dynamic _decode(http.Response res) {
    if (res.statusCode == 204 || res.body.isEmpty) {
      if (res.statusCode >= 400) {
        throw ApiException(
            res.statusCode, 'Request failed (${res.statusCode})');
      }
      return null;
    }

    dynamic data;
    try {
      data = jsonDecode(res.body);
    } catch (_) {
      data = null;
    }

    if (res.statusCode >= 400) {
      final message = data is Map && data['error'] is String
          ? data['error'] as String
          : 'Request failed (${res.statusCode})';
      throw ApiException(res.statusCode, message);
    }

    return data;
  }

  /// Forget the session locally (used on logout).
  Future<void> clearCookie() => _persistCookie(null);
}

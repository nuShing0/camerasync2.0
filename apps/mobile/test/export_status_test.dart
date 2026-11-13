import 'package:camerasync_mobile/api/recordings_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ExportStatus', () {
    ExportStatus status(Map<String, dynamic> json) =>
        ExportStatus.fromJson(json);

    test('shows the percentage while the videos are lined up', () {
      final s = status({'state': 'working', 'progress': 0.427});
      expect(s.describe(), 'Lining up the videos… 42%');
      expect(s.isReady, isFalse);
    });

    test('says when other downloads are ahead in line', () {
      final s = status({'state': 'queued', 'progress': 0, 'waiting': 1});
      expect(s.describe(), 'Waiting for 1 other download to finish…');
    });

    test("passes the server's reason on when it fails", () {
      final s =
          status({'state': 'failed', 'error': "These angles don't overlap."});
      expect(s.isFailed, isTrue);
      expect(s.describe(), "These angles don't overlap.");
    });
  });

  test('downloadPath asks for the lined-up zip', () {
    expect(RecordingsApi.downloadPath('abc123'),
        '/api/recordings/sessions/abc123/download?kind=synced');
  });

  test("downloadPath asks for one recording's video", () {
    expect(RecordingsApi.downloadPath('abc123', startedAtMs: 1794528943050),
        '/api/recordings/sessions/abc123/download?kind=synced&startedAt=1794528943050');
  });
}

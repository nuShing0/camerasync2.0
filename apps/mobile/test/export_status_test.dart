import 'package:camerasync_mobile/api/recordings_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ExportStatus', () {
    ExportStatus status(Map<String, dynamic> json) =>
        ExportStatus.fromJson(json);

    test('shows the percentage while a recording is lined up', () {
      final s = status(
          {'state': 'working', 'progress': 0.427, 'ready': 0, 'total': 1});
      expect(s.describe('synced'), 'Lining up the angles… 42%');
      expect(s.isReady, isFalse);
    });

    test('says when other downloads are ahead in line', () {
      final s =
          status({'state': 'queued', 'progress': 0, 'waiting': 1, 'total': 1});
      expect(s.describe('grid'), 'Waiting for 1 other download to finish…');
    });

    test("passes the server's reason on when it fails", () {
      final s =
          status({'state': 'failed', 'error': "These angles don't overlap."});
      expect(s.isFailed, isTrue);
      expect(s.describe('grid'), "These angles don't overlap.");
    });
  });

  test('downloadPath asks for the kind and recording', () {
    expect(RecordingsApi.downloadPath('abc123', 'original', null),
        '/api/recordings/sessions/abc123/download');
    expect(RecordingsApi.downloadPath('abc123', 'grid', 1790000000000),
        '/api/recordings/sessions/abc123/download?kind=grid&startedAt=1790000000000');
  });
}

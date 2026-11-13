import 'package:camerasync_mobile/api/recordings_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('an angle says whether this viewer may delete it', () {
    final mine = AngleVideo.fromJson(
        {'userId': 7, 'name': 'Ryan', 'url': '/a.mp4', 'canDelete': true});
    final theirs =
        AngleVideo.fromJson({'userId': 8, 'name': 'Parker', 'url': '/b.mp4'});
    expect(mine.canDelete, isTrue);
    // Older servers don't send it: not deletable.
    expect(theirs.canDelete, isFalse);
  });
}

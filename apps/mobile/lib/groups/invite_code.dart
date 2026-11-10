/// Invite codes are six letters and numbers, shown as ABC-DEF (see
/// newInviteCode in apps/server/src/routes/groups.js).
const kInviteCodeLength = 6;

/// The invite code in what someone typed, pasted or scanned: a bare code
/// (ABC-DEF, abcdef) or any link with `/join/<CODE>` in it, like the web's
/// https://8kount.app/join/ABCDEF or the app's eightkount://join/ABCDEF. Returns
/// it in capitals without the dash, or null when there isn't one. The server
/// reads look-alike letters (O for 0) itself, so they're left as typed.
String? inviteCodeFrom(String text) {
  var code = text.trim();
  final join = code.indexOf('/join/');
  if (join >= 0) {
    code = code.substring(join + '/join/'.length).split(RegExp('[/?#]')).first;
  } else if (code.contains(RegExp('[/:.]'))) {
    // Some other link, or one still being typed ("https://8" isn't a code).
    return null;
  }
  code = code.toUpperCase().replaceAll(RegExp('[^A-Z0-9]'), '');
  return code.length == kInviteCodeLength ? code : null;
}

/// ABCDEF as ABC-DEF, the way codes are read out.
String formatInviteCode(String code) => code.length == kInviteCodeLength
    ? '${code.substring(0, 3)}-${code.substring(3)}'
    : code;

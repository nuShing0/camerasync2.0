import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../api/recordings_api.dart';
import '../auth/auth_service.dart';
import '../config.dart';
import '../screens/session_screen.dart';
import '../team_accent.dart';
import '../theme.dart';

// The + button: start a session now, schedule one, or join one with its
// code. Each ends in the live session screen (or a "Scheduled" note).

const _shortMonths = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

void _toast(BuildContext context, String message) =>
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));

/// Opens a live session's recording screen.
Future<void> openLiveSession(
    BuildContext context, AuthService auth, RecordingSession session) {
  return Navigator.of(context).push(
    MaterialPageRoute(
      builder: (_) => SessionScreen(
        serverUrl: kServerUrl,
        auth: auth,
        sessionId: session.id,
        sessionName: session.name,
      ),
    ),
  );
}

/// Joins [sessionId] (which starts a scheduled one) and opens it. The REST
/// join records membership, which the socket room checks before letting
/// this phone in.
Future<void> joinAndOpen(
    BuildContext context, AuthService auth, String sessionId) async {
  try {
    final joined = await RecordingsApi(auth.api).joinSession(sessionId);
    if (context.mounted) await openLiveSession(context, auth, joined);
  } on ApiException catch (e) {
    if (context.mounted) _toast(context, e.message);
  }
}

/// What the + offers, nearest the button first. The nav bar grows into a
/// panel of these (see home_shell.dart).
const newSessionChoices = [
  (
    value: 'start',
    icon: Icons.fiber_manual_record,
    title: 'Start a session now',
    detail: 'Go live and record with your team.',
  ),
  (
    value: 'schedule',
    icon: Icons.event,
    title: 'Schedule a session',
    detail: 'Put one on the calendar for later.',
  ),
  (
    value: 'code',
    icon: Icons.pin_outlined,
    title: 'Join with a code',
    detail: 'Enter the 6-character code someone shared.',
  ),
];

/// Carries out one of [newSessionChoices]. True when a session was started
/// or scheduled.
Future<bool> runNewSessionChoice(
    BuildContext context, AuthService auth, String choice) async {
  if (choice == 'code') {
    await _joinWithCode(context, auth);
    return false;
  }
  return _newSession(context, auth, live: choice == 'start');
}

Future<bool> _newSession(BuildContext context, AuthService auth,
    {required bool live}) async {
  final recordings = RecordingsApi(auth.api);
  List<Group> adminGroups;
  try {
    adminGroups = [
      for (final g in await GroupsApi(auth.api).getMyGroups())
        if (g.role == 'admin') g
    ];
  } on ApiException catch (e) {
    if (context.mounted) _toast(context, e.message);
    return false;
  }
  if (!context.mounted) return false;
  // Anyone can start a session without a group (and share its code); only
  // a group's admins can put one on the calendar.
  if (!live && adminGroups.isEmpty) {
    _toast(context, 'Only group admins can schedule sessions.');
    return false;
  }
  final created = await showModalBottomSheet<RecordingSession>(
    context: context,
    isScrollControlled: true,
    backgroundColor: kSurface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (_) => NewSessionSheet(
      groups: adminGroups,
      live: live,
      recordings: recordings,
    ),
  );
  if (created == null || !context.mounted) return false;
  if (live) {
    // Starting a session makes you its host: straight into the room.
    await joinAndOpen(context, auth, created.id);
  } else {
    _toast(context, 'Scheduled ${created.name}');
  }
  return true;
}

/// Joins any live session by its 6-character code: how people get into a
/// session that has no group.
Future<void> _joinWithCode(BuildContext context, AuthService auth) async {
  final controller = TextEditingController();
  final code = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      backgroundColor: kSurface,
      title: const Text('Join with a code'),
      content: TextField(
        controller: controller,
        autofocus: true,
        maxLength: 6,
        textCapitalization: TextCapitalization.none,
        decoration: const InputDecoration(hintText: 'abc123'),
        onSubmitted: (value) => Navigator.of(context).pop(value),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel')),
        FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text),
            child: const Text('Join')),
      ],
    ),
  );
  controller.dispose();
  final id = code?.trim().toLowerCase() ?? '';
  if (id.isEmpty || !context.mounted) return;
  await joinAndOpen(context, auth, id);
}

/// Schedule a session for later, or start one now ([live]). Pops with the
/// created session.
class NewSessionSheet extends StatefulWidget {
  const NewSessionSheet({
    super.key,
    required this.groups,
    required this.live,
    required this.recordings,
  });

  final List<Group> groups;
  final bool live;
  final RecordingsApi recordings;

  @override
  State<NewSessionSheet> createState() => NewSessionSheetState();
}

class NewSessionSheetState extends State<NewSessionSheet> {
  final _name = TextEditingController();
  // '' means no group, which only a live session can have.
  late String _groupId = widget.groups.isEmpty ? '' : widget.groups.first.id;
  late DateTime _when = DateTime.now()
      .add(const Duration(hours: 1))
      .copyWith(minute: 0, second: 0, millisecond: 0, microsecond: 0);
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _when,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (date != null) {
      setState(() => _when =
          DateTime(date.year, date.month, date.day, _when.hour, _when.minute));
    }
  }

  Future<void> _pickTime() async {
    final time = await showTimePicker(
        context: context, initialTime: TimeOfDay.fromDateTime(_when));
    if (time != null) {
      setState(() => _when =
          DateTime(_when.year, _when.month, _when.day, time.hour, time.minute));
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Give the session a name.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final session = widget.live
          ? await widget.recordings.createLiveSession(
              groupId: _groupId.isEmpty ? null : _groupId, name: name)
          : await widget.recordings.scheduleSession(
              groupId: _groupId, name: name, scheduledAt: _when);
      if (mounted) Navigator.of(context).pop(session);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final team = TeamAccent.of(context);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
            20, 18, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.live ? 'Start a session now' : 'Schedule a session',
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 20,
                  fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _groupId,
              decoration: const InputDecoration(labelText: 'Group'),
              dropdownColor: kSurfaceLight,
              items: [
                for (final g in widget.groups)
                  DropdownMenuItem(value: g.id, child: Text(g.name)),
                if (widget.live)
                  const DropdownMenuItem(
                      value: '', child: Text('No group (share the code)')),
              ],
              onChanged: _saving
                  ? null
                  : (id) => setState(() => _groupId = id ?? _groupId),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _name,
              enabled: !_saving,
              autofocus: true,
              maxLength: 100,
              decoration: const InputDecoration(
                  labelText: 'Session name', counterText: ''),
            ),
            if (!widget.live) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _saving ? null : _pickDate,
                      icon: const Icon(Icons.calendar_today, size: 18),
                      label:
                          Text('${_shortMonths[_when.month - 1]} ${_when.day}'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _saving ? null : _pickTime,
                      icon: const Icon(Icons.schedule, size: 18),
                      label:
                          Text(TimeOfDay.fromDateTime(_when).format(context)),
                    ),
                  ),
                ],
              ),
            ],
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(_error!, style: const TextStyle(color: kLiveRed)),
              ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _saving ? null : _save,
              style: FilledButton.styleFrom(
                backgroundColor: team.fill,
                foregroundColor: team.ink,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              child: Text(_saving
                  ? 'Saving…'
                  : widget.live
                      ? 'Start session'
                      : 'Schedule'),
            ),
          ],
        ),
      ),
    );
  }
}

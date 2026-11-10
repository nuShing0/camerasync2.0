import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/api_client.dart';
import '../api/groups_api.dart';
import '../team_accent.dart';
import '../theme.dart';

/// The "new group" overlay from the Create A Group design: a name and a
/// team color (the server makes the group's ID from the name). Groups are invite-only, so there's no privacy to pick. Pops
/// with the created [Group], or null if cancelled.
class CreateGroupDialog extends StatefulWidget {
  const CreateGroupDialog({super.key, required this.groupsApi});

  final GroupsApi groupsApi;

  @override
  State<CreateGroupDialog> createState() => _CreateGroupDialogState();
}

class _CreateGroupDialogState extends State<CreateGroupDialog> {
  final _name = TextEditingController();
  String _color = kTeamColors.first.$2;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  String? _validate() {
    if (_name.text.trim().isEmpty) return 'Please enter a group name.';
    return null;
  }

  Future<void> _submit() async {
    final error = _validate();
    if (error != null) {
      setState(() => _error = error);
      return;
    }

    setState(() {
      _error = null;
      _submitting = true;
    });
    try {
      final group = await widget.groupsApi.createGroup(
        name: _name.text.trim(),
        primaryColor: _color,
      );
      if (mounted) Navigator.of(context).pop(group);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Unable to create group.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: kSurface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Create a group',
              style: TextStyle(
                color: TeamAccent.of(context).accent,
                fontSize: 20,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 16),
            if (_error != null) ...[
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFF2A1A1A),
                  border: Border.all(color: const Color(0xFF5A2A2A)),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  _error!,
                  style: const TextStyle(color: Color(0xFFFF8A80)),
                ),
              ),
              const SizedBox(height: 12),
            ],
            _field(
              label: 'Group Name',
              controller: _name,
              hint: 'Team Knightro',
            ),
            const SizedBox(height: 4),
            const Text(
              'Team color',
              style: TextStyle(
                color: Colors.white,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final (name, hex) in kTeamColors)
                  Semantics(
                    label: 'Team color $name',
                    selected: hex == _color,
                    button: true,
                    child: GestureDetector(
                      onTap: () => setState(() => _color = hex),
                      child: Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          color: parseHexColor(hex),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: hex == _color ? Colors.white : Colors.transparent,
                            width: 2.5,
                          ),
                        ),
                        child: hex == _color
                            ? Icon(Icons.check,
                                size: 18, color: inkOn(parseHexColor(hex)!))
                            : null,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _submitting ? null : () => Navigator.of(context).pop(),
                  child: const Text('Cancel', style: TextStyle(color: kMuted)),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _submitting ? null : _submit,
                  style: FilledButton.styleFrom(
                    backgroundColor: TeamAccent.of(context).fill,
                    foregroundColor: TeamAccent.of(context).ink,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  child: Text(
                    _submitting ? 'Creating…' : 'Create',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _field({
    required String label,
    required TextEditingController controller,
    required String hint,
    List<TextInputFormatter>? inputFormatters,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(height: 6),
          TextField(
            controller: controller,
            enabled: !_submitting,
            inputFormatters: inputFormatters,
            style: const TextStyle(color: Color(0xFFF0F0F0)),
            decoration: InputDecoration(
              filled: true,
              fillColor: kBackground,
              hintText: hint,
              hintStyle: const TextStyle(color: Color(0xFF5C5C5E), fontSize: 13),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 12,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: BorderSide.none,
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: BorderSide(color: TeamAccent.of(context).accent, width: 1.5),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

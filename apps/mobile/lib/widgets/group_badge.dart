import 'package:flutter/material.dart';

/// A small pill on a team-colored card or banner, like "Owner" or
/// "Primary", tinted from the card's [ink] so it reads on any team color.
class GroupBadge extends StatelessWidget {
  const GroupBadge({super.key, required this.label, required this.ink});

  final String label;
  final Color ink;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: ink.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: ink,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

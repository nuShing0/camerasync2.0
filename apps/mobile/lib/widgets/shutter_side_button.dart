import 'package:flutter/material.dart';

import 'frosted.dart';

/// A round button beside the shutter, like a camera app's gallery and
/// flip-camera buttons. Greyed out when [onPressed] is null (mid-take).
class ShutterSideButton extends StatelessWidget {
  const ShutterSideButton({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.color = Colors.white,
  });

  /// Room one of these takes up, so an empty slot can match it.
  static const double size = 52;

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null;
    return Tooltip(
      message: tooltip,
      child: Frosted(
        radius: size / 2,
        tint: Colors.black38,
        child: Material(
          type: MaterialType.transparency,
          shape: CircleBorder(
            side: BorderSide(
                color: enabled ? Colors.white70 : Colors.white24, width: 1.5),
          ),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onPressed,
            child: SizedBox(
              width: size,
              height: size,
              child: Icon(icon,
                  color: enabled ? color : Colors.white38,
                  semanticLabel: tooltip),
            ),
          ),
        ),
      ),
    );
  }
}

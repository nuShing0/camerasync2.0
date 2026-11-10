import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

/// The frosted-glass look for controls over the camera: what's behind is
/// blurred under a light dark tint, so white text and icons read over a
/// bright picture without the control turning into a solid block. [radius]
/// rounds the corners (a size past half the height makes a pill, or with a
/// square child, a circle).
class Frosted extends StatelessWidget {
  const Frosted({
    super.key,
    required this.child,
    this.radius = 18,
    this.tint = Colors.black54,
  });

  final Widget child;
  final double radius;
  final Color tint;

  /// How much the camera behind is blurred.
  static const blur = 14.0;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: ColoredBox(color: tint, child: child),
      ),
    );
  }
}

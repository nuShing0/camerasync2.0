import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../groups/invite_code.dart';
import '../widgets/frosted.dart';

/// The camera, reading the invite QR off a teammate's phone (Show QR on the
/// group page). Pops with the invite code from the first one it sees, or
/// null when closed.
class ScanInviteScreen extends StatefulWidget {
  const ScanInviteScreen({super.key});

  @override
  State<ScanInviteScreen> createState() => _ScanInviteScreenState();
}

class _ScanInviteScreenState extends State<ScanInviteScreen> {
  final _scanner = MobileScannerController(formats: [BarcodeFormat.qrCode]);
  bool _found = false;

  /// Some other QR code is in view, so the hint says that's not it.
  bool _notAnInvite = false;

  @override
  void dispose() {
    _scanner.dispose();
    super.dispose();
  }

  void _detected(BarcodeCapture capture) {
    if (_found) return;
    for (final barcode in capture.barcodes) {
      final text = barcode.rawValue ?? '';
      // Only invite links: a QR that happens to hold six letters isn't one.
      final code = text.contains('/join/') ? inviteCodeFrom(text) : null;
      if (code != null) {
        _found = true;
        Navigator.of(context).pop(code);
        return;
      }
    }
    if (!_notAnInvite) setState(() => _notAnInvite = true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _scanner,
            onDetect: _detected,
            errorBuilder: (context, error) => Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  error.errorCode == MobileScannerErrorCode.permissionDenied
                      ? '8kount needs the camera to scan the QR. Allow it in '
                          "your phone's Settings, or type the code instead."
                      : "The camera didn't start. Type the code instead.",
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white, height: 1.4),
                ),
              ),
            ),
          ),
          // Where to hold the code.
          Center(
            child: IgnorePointer(
              child: Container(
                width: 240,
                height: 240,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.white70, width: 3),
                  borderRadius: BorderRadius.circular(24),
                ),
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Frosted(
                      radius: 24,
                      child: IconButton(
                        tooltip: 'Close',
                        color: Colors.white,
                        icon: const Icon(Icons.close),
                        onPressed: () => Navigator.of(context).pop(),
                      ),
                    ),
                  ),
                  const Spacer(),
                  Frosted(
                    radius: 999,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 18, vertical: 12),
                      child: Text(
                        _notAnInvite
                            ? "That QR isn't an 8kount invite."
                            : "Point at the invite QR on a teammate's phone",
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            color: Colors.white, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

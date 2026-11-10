import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/api_client.dart';
import '../auth/auth_service.dart';
import '../theme.dart';

/// The three steps of the in-app password reset, one screen per Figma frame:
/// email ("Forgot Password"), code ("Enter Code"), password ("Reset Password").
enum _Step { email, code, password }

/// In-app password reset: request a 6-digit code by email, verify it, then
/// choose a new password. Pops with `true` once the reset succeeds so the
/// sign-in screen can show a confirmation.
class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({
    super.key,
    required this.auth,
    this.initialEmail,
    this.onResetComplete,
  });

  final AuthService auth;
  final String? initialEmail;
  final Future<void> Function()? onResetComplete;

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  _Step _step = _Step.email;
  bool _submitting = false;
  String? _error;
  String? _notice;

  late final _email = TextEditingController(text: widget.initialEmail ?? '');
  final _code = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  final _codeFocus = FocusNode();

  /// The single-use token from /verify-reset-code that authorizes the final
  /// /reset-password call.
  String? _resetToken;

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    _password.dispose();
    _confirm.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _error = null;
      _notice = null;
      _submitting = true;
    });
    try {
      await action();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Something went wrong. Please try again.');
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _sendCode() async {
    if (_email.text.trim().isEmpty) {
      setState(() => _error = 'Please enter your email.');
      return;
    }
    await _run(() async {
      await widget.auth.forgotPassword(email: _email.text.trim());
      if (!mounted) return;
      setState(() {
        _step = _Step.code;
        _code.clear();
      });
    });
  }

  Future<void> _resendCode() async {
    await _run(() async {
      await widget.auth.forgotPassword(email: _email.text.trim());
      if (!mounted) return;
      setState(() {
        _code.clear();
        _notice = 'A new code is on its way.';
      });
    });
  }

  Future<void> _verifyCode() async {
    if (_code.text.length != 6) {
      setState(() => _error = 'Please enter the 6-digit code.');
      return;
    }
    await _run(() async {
      final token = await widget.auth.verifyResetCode(
        email: _email.text.trim(),
        code: _code.text,
      );
      if (!mounted) return;
      setState(() {
        _resetToken = token;
        _step = _Step.password;
      });
    });
  }

  Future<void> _resetPassword() async {
    if (_password.text.isEmpty) {
      setState(() => _error = 'Please enter a new password.');
      return;
    }
    if (_password.text.length < 8) {
      setState(() => _error = 'Password must be at least 8 characters.');
      return;
    }
    if (_password.text != _confirm.text) {
      setState(() => _error = 'Passwords do not match.');
      return;
    }
    await _run(() async {
      await widget.auth.resetPassword(
        token: _resetToken!,
        password: _password.text,
      );
      if (!mounted) return;
      await widget.onResetComplete?.call();
      if (!mounted) return;
      Navigator.of(context).pop(true);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 36),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 76),
              Text(
                switch (_step) {
                  _Step.email => 'Forgot Password',
                  _Step.code => 'Enter Code',
                  _Step.password => 'Reset Password',
                },
                style: const TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w800,
                  color: kGold,
                ),
              ),
              const SizedBox(height: 13),
              Text(
                switch (_step) {
                  _Step.email =>
                    "Enter your email and we'll send you a code to reset your password.",
                  _Step.code => 'Enter the 6-digit code sent to your email',
                  _Step.password =>
                    'Enter and confirm your new password below.',
                },
                style: const TextStyle(fontSize: 13, color: kMuted),
              ),
              const SizedBox(height: 24),

              if (_error != null) _messageBox(_error!, isError: true),
              if (_notice != null) _messageBox(_notice!, isError: false),
              const SizedBox(height: 12),

              ...switch (_step) {
                _Step.email => _emailStep(),
                _Step.code => _codeStep(),
                _Step.password => _passwordStep(),
              },
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _emailStep() => [
        _labeledField(
          controller: _email,
          label: 'Email',
          hint: 'you@example.com',
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: 24),
        _primaryButton('Send Code', _sendCode),
        const SizedBox(height: 14),
        _linkButton(
          'Back to Sign In',
          () => Navigator.of(context).pop(),
        ),
      ];

  List<Widget> _codeStep() => [
        _codeBoxes(),
        const SizedBox(height: 28),
        _primaryButton('Verify', _verifyCode),
        const SizedBox(height: 14),
        _linkButton('Resend Code', _resendCode),
      ];

  List<Widget> _passwordStep() => [
        _labeledField(
          controller: _password,
          label: 'New Password',
          hint: '••••••••',
          obscure: true,
        ),
        const SizedBox(height: 20),
        _labeledField(
          controller: _confirm,
          label: 'Confirm Password',
          hint: '••••••••',
          obscure: true,
        ),
        const SizedBox(height: 24),
        _primaryButton('Reset Password', _resetPassword),
      ];

  /// Six display boxes over one invisible text field, so the code is a single
  /// string and the keyboard behaves normally (paste, backspace, autofill).
  Widget _codeBoxes() {
    return SizedBox(
      height: 52,
      child: Stack(
        children: [
          Positioned.fill(
            child: Opacity(
              opacity: 0,
              child: TextField(
                controller: _code,
                focusNode: _codeFocus,
                autofocus: true,
                keyboardType: TextInputType.number,
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(6),
                ],
                onChanged: (_) => setState(() {}),
              ),
            ),
          ),
          // The boxes just render the hidden field's text; taps fall through
          // to the field so the keyboard opens.
          IgnorePointer(
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: List.generate(6, (i) {
                final filled = i < _code.text.length;
                return Container(
                  width: 42,
                  height: 52,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: kSurface,
                    borderRadius: BorderRadius.circular(10),
                    border: _codeFocus.hasFocus && i == _code.text.length
                        ? Border.all(color: kGold, width: 1.5)
                        : null,
                  ),
                  child: Text(
                    filled ? _code.text[i] : '',
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      color: Colors.white,
                    ),
                  ),
                );
              }),
            ),
          ),
        ],
      ),
    );
  }

  Widget _messageBox(String text, {required bool isError}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isError ? const Color(0xFF2A1A1A) : kSurface,
        border: Border.all(
          color: isError ? const Color(0xFF5A2A2A) : kGold,
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: TextStyle(color: isError ? const Color(0xFFFF8A80) : kGold),
      ),
    );
  }

  Widget _primaryButton(String label, Future<void> Function() onPressed) {
    return FilledButton(
      onPressed: _submitting ? null : onPressed,
      style: FilledButton.styleFrom(
        backgroundColor: kGold,
        foregroundColor: kBackground,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        minimumSize: const Size.fromHeight(48),
      ),
      child: Text(
        _submitting ? 'Please wait…' : label,
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
    );
  }

  Widget _linkButton(String label, VoidCallback onPressed) {
    return Center(
      child: TextButton(
        onPressed: _submitting ? null : onPressed,
        child: Text(
          label,
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: kGold,
          ),
        ),
      ),
    );
  }

  Widget _labeledField({
    required TextEditingController controller,
    required String label,
    required String hint,
    bool obscure = false,
    TextInputType? keyboardType,
  }) {
    return Column(
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
        const SizedBox(height: 8),
        TextField(
          controller: controller,
          obscureText: obscure,
          keyboardType: keyboardType,
          style: const TextStyle(color: Color(0xFFF0F0F0)),
          decoration: InputDecoration(
            filled: true,
            fillColor: kSurface,
            hintText: hint,
            hintStyle: const TextStyle(color: Color(0xFF5C5C5E), fontSize: 13),
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 14,
              vertical: 15,
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide.none,
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: const BorderSide(color: kGold, width: 1.5),
            ),
          ),
        ),
      ],
    );
  }
}

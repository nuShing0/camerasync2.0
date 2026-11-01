import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'auth/auth_service.dart';
import 'config.dart';
import 'groups/invite_links.dart';
import 'screens/home_shell.dart';
import 'screens/login_screen.dart';
import 'screens/verify_email_screen.dart';
import 'team_accent.dart';
import 'tv/tv_screen.dart';

void main() {
  // restoreSession reads the saved cookie through a plugin, which needs the
  // binding; without this it fails and every launch starts signed out.
  WidgetsFlutterBinding.ensureInitialized();
  final auth = AuthService(ApiClient(kServerUrl));
  // Fire-and-forget: the UI shows a spinner while `loading` is true.
  auth.restoreSession();
  // An invite link (eightkount://join/<CODE>) may have opened the app; HomeShell
  // shows it once signed in.
  InviteLinks.instance.start().catchError((_) {});
  runApp(CameraSyncApp(auth: auth));
}

/// The TV screen's own entry point: the external_display plugin starts a
/// second Flutter engine here when a TV is plugged in (see TvLink).
@pragma('vm:entry-point')
void externalDisplayMain() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const TvApp());
}

class CameraSyncApp extends StatelessWidget {
  const CameraSyncApp({super.key, required this.auth});

  final AuthService auth;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '8kount',
      theme: ThemeData(
        colorScheme: schemeFor(kGold),
        scaffoldBackgroundColor: kBackground,
        useMaterial3: true,
        inputDecorationTheme: const InputDecorationTheme(
          filled: true,
          fillColor: Color(0xFF262626),
        ),
      ),
      // Above the Navigator, so pushed screens and dialogs get the team
      // color too.
      builder: (context, child) => TeamAccentScope(auth: auth, child: child!),
      home: AuthGate(auth: auth),
    );
  }
}

/// Shows the login screen until signed in, then the tabbed app shell.
class AuthGate extends StatelessWidget {
  const AuthGate({super.key, required this.auth});

  final AuthService auth;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: auth,
      builder: (context, _) {
        if (auth.loading) {
          return const Scaffold(
            backgroundColor: kBackground,
            body: Center(child: CircularProgressIndicator()),
          );
        }
        if (!auth.isAuthenticated) return LoginScreen(auth: auth);
        // The server refuses everything else until the email is confirmed.
        if (!auth.user!.emailVerified) return VerifyEmailScreen(auth: auth);
        return HomeShell(auth: auth);
      },
    );
  }
}

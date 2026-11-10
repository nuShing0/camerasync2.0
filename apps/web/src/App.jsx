import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";

import { AuthProvider, useAuth } from "./auth/AuthContext.jsx";
import { AppLayout } from "./layouts/AppLayout.jsx";
import { AuthScreen } from "./screens/AuthScreen.jsx";
import { ForgotPasswordScreen } from "./screens/ForgotPasswordScreen.jsx";
import { PrivacyScreen } from "./screens/PrivacyScreen.jsx";
import { ResetPasswordScreen } from "./screens/ResetPasswordScreen.jsx";
import {
  VerifyEmailLinkScreen,
  VerifyEmailScreen,
} from "./screens/VerifyEmailScreen.jsx";
import { PlaybackScreen } from "./screens/PlaybackScreen.jsx";
import { WatchScreen } from "./screens/WatchScreen.jsx";
import { ActiveSessionScreen } from "./screens/ActiveSessionScreen.jsx";
import { CalendarScreen } from "./screens/CalendarScreen.jsx";
import { HomeScreen } from "./screens/HomeScreen.jsx";
import { GroupSettingsScreen } from "./screens/GroupSettingsScreen.jsx";
import { JoinGroupScreen } from "./screens/JoinGroupScreen.jsx";
import { GroupsScreen } from "./screens/PlaceholderScreens.jsx";
import { NotificationsScreen } from "./screens/NotificationsScreen.jsx";
import { SettingsScreen } from "./screens/SettingsScreen.jsx";
import { DownloadAuditScreen } from "./screens/DownloadAuditScreen.jsx";

export function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

function Root() {
  const { isAuthenticated, loading, user } = useAuth();

  // Wait for the /me check so an already-signed-in user doesn't briefly see
  // the sign-in screen on refresh.
  if (loading) return <FullScreenMessage>Loading…</FullScreenMessage>;

  // Signed in but not confirmed: the confirmation screen replaces the whole
  // app (the server refuses everything else anyway) — except the emailed
  // link's page, which must still work.
  if (isAuthenticated && !user.emailVerified) {
    return (
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailLinkRoute />} />
        <Route path="/privacy" element={<PrivacyScreen />} />
        <Route path="*" element={<VerifyEmailScreen />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Reachable signed out — it's how you recover an account. */}
      <Route path="/reset-password" element={<ResetPasswordRoute />} />
      <Route path="/forgot-password" element={<ForgotPasswordScreen />} />
      <Route path="/verify-email" element={<VerifyEmailLinkRoute />} />

      <Route path="/login" element={<LoginRoute />} />
      {/* The app stores link here, so it works signed out. */}
      <Route path="/privacy" element={<PrivacyScreen />} />

      {/* Everything inside the layout requires a session. */}
      <Route element={<SignedInOnly />}>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/groups" element={<GroupsScreen />} />
        <Route path="/groups/:id" element={<GroupSettingsScreen />} />
        <Route path="/join/:code" element={<JoinGroupScreen />} />
        {/* The old Record page: starting is the sidebar's + New session. */}
        <Route path="/record" element={<Navigate to="/watch" replace />} />
        <Route path="/record/:sessionId" element={<ActiveSessionScreen />} />
        <Route path="/watch" element={<WatchScreen />} />
        <Route path="/watch/:sessionId" element={<PlaybackScreen />} />
        <Route path="/calendar" element={<CalendarScreen />} />
        <Route path="/notifications" element={<NotificationsScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/download-audit" element={<DownloadAuditScreen />} />
        <Route path="/download-audit/:groupId" element={<DownloadAuditScreen />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// Pulls ?token= out of the reset link's URL.
// Signed-out visits to an app page (an invite link, say) go to sign-in and
// come back afterwards.
function SignedInOnly() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (isAuthenticated) return <AppLayout />;
  const next = encodeURIComponent(location.pathname + location.search);
  return <Navigate to={`/login?next=${next}`} replace />;
}

function LoginRoute() {
  const { isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  const next = params.get("next") ?? "";
  // Only pages inside this app, so a crafted link can't bounce people to
  // another site after they sign in.
  const target = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return isAuthenticated ? <Navigate to={target} replace /> : <AuthScreen />;
}

function ResetPasswordRoute() {
  const [params] = useSearchParams();
  return <ResetPasswordScreen token={params.get("token")} />;
}

// Same for the sign-up confirmation link.
function VerifyEmailLinkRoute() {
  const [params] = useSearchParams();
  return <VerifyEmailLinkScreen token={params.get("token")} />;
}

function FullScreenMessage({ children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#0d0d0d",
        color: "#999",
        fontFamily: "system-ui",
      }}
    >
      {children}
    </div>
  );
}

import { Outlet } from "react-router-dom";

import { NewSessionProvider } from "../components/NewSession.jsx";
import { Sidebar, SIDEBAR_WIDTH } from "../components/Sidebar.jsx";
import { GroupThemeProvider } from "../theme/GroupThemeContext.jsx";

/// Shell for the signed-in app: fixed sidebar in the default group's color
/// (8kount yellow without one) + scrolling content.
export function AppLayout() {
  return (
    <GroupThemeProvider>
      <NewSessionProvider>
        <div style={styles.shell}>
          <Sidebar />
          <main style={styles.content}>
            <Outlet />
          </main>
        </div>
      </NewSessionProvider>
    </GroupThemeProvider>
  );
}

const styles = {
  shell: {
    minHeight: "100vh",
    //background: "#000", //original, appearance toggle below
    background: "var(--page-bg)",
    color: "var(--page-ink)",
    color: "var(--page-ink)",
    fontFamily: "system-ui, sans-serif",
  },
  content: {
    marginLeft: SIDEBAR_WIDTH,
    padding: "2.25rem 2.75rem",
    minHeight: "100vh",
    boxSizing: "border-box",
  },
};

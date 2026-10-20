import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { useAuth } from "../auth/AuthContext.jsx";
import { getGroups, getPrimaryGroupId } from "../api/groups.js";
import { DEFAULT_THEME, SURFACES, applyTheme, themeFor } from "./groupTheme.js";

// Themes the signed-in app in the user's primary group's color (saved on the
// account from Settings or a group's page). No groups falls back to 8kount
// branding. Also holds the light/dark appearance mode.
const GroupThemeContext = createContext(null);

function loadMode() {
  try {
    return localStorage.getItem("themeMode") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function GroupThemeProvider({ children }) {
  const { user } = useAuth();
  const [groups, setGroups] = useState([]);
  const [mode, setMode] = useState(loadMode);

  const refresh = useCallback(async () => {
    const loaded = await getGroups();
    setGroups(loaded);
    return loaded;
  }, []);

  useEffect(() => {
    // A failed load just leaves the 8kount branding in place.
    refresh().catch(() => { });
  }, [refresh, user.id]);

  const activeGroupId = getPrimaryGroupId(user, groups);
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null;

  // Remember the appearance mode and expose it to CSS as data-theme.
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem("themeMode", mode);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works.
    }
  }, [mode]);

  // Group colors + page surfaces for the current mode.
  useEffect(() => {
    applyTheme({ ...themeFor(activeGroup, mode), ...SURFACES[mode] });
  }, [activeGroup?.id, activeGroup?.primaryColor, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Signing out unmounts the app shell; don't leave a team's colors (or light
  // mode) behind on the sign-in screen.
  useEffect(
    () => () => {
      applyTheme({ ...DEFAULT_THEME, ...SURFACES.dark });
      document.documentElement.dataset.theme = "dark";
    },
    [],
  );

  const value = {
    activeGroup,
    refresh,
    mode,
    toggleMode: () => setMode((m) => (m === "dark" ? "light" : "dark")),
  };

  return (
    <GroupThemeContext.Provider value={value}>
      {children}
    </GroupThemeContext.Provider>
  );
}

export function useGroupTheme() {
  const ctx = useContext(GroupThemeContext);
  if (!ctx) throw new Error("useGroupTheme must be used within a <GroupThemeProvider>");
  return ctx;
}
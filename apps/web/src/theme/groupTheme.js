// Group color theming (SCRUM-71): turns a group's team color into the CSS
// variables the signed-in app is styled with.
//
//   --brand / --brand-ink       sidebar fill and the text on it
//   --brand-active              the sidebar's selected-item tile
//   --accent / --accent-ink     buttons, links and highlights on the page,
//                               and the text on an accent fill
//   --accent-hover              hover state for accent fills
//   --page-bg / --page-ink      page background and text (light/dark mode)
//   --surface / --surface-2     card and panel backgrounds (light/dark mode)
//
// The sidebar shows the team color exactly as chosen, but --accent is
// shifted until it is readable on the page: lightened on the black page,
// darkened on the white page. A navy primary makes a good sidebar and an
// unreadable link.

const PAGE_BACKGROUND = "#000000";
const LIGHT_PAGE_BACKGROUND = "#ffffff";
// WCAG AA for normal text — accents are used for links and timestamps too.
const MIN_ACCENT_CONTRAST = 4.5;

/// 8kount branding, used when no group is selected.
export const DEFAULT_THEME = {
  "--brand": "#ead217",
  "--brand-ink": "#000000",
  "--brand-active": "#ffeb4c",
  "--accent": "#ead217",
  "--accent-ink": "#0d0d0d",
  "--accent-hover": "#f0df5d",
};

/// Page surfaces for each appearance mode.
/*export const SURFACES = {
  dark: {
    "--page-bg": "#000000",
    "--page-ink": "#e8e8e8",
    "--surface": "#0d0d0d",
    "--surface-2": "#111111",
  },
  light: {
    "--page-bg": "#ffffff",
    "--page-ink": "#111111",
    "--surface": "#f4f4f5",
    "--surface-2": "#ececee",
  },
};*/

export const SURFACES = {
  dark: {
    "--page-bg": "#000000",
    "--page-ink": "#e8e8e8",
    "--surface": "#0d0d0d",
    "--surface-2": "#111111",
    "--card": "#161616",
    "--card-hover": "#1c1c1c",
    "--raised": "#292929",
    "--field": "#262626",
    "--panel": "#242424",
    "--text-strong": "#f0f0f0",
    "--text-soft": "#d0d0d0",
    "--text-muted": "#a0a0a0",
    "--text-dim": "#8a8a8a",
    "--line": "#242424",
    "--line-strong": "#444444",
    "--error-bg": "#2a1a1a",
    "--error-line": "#5a2a2a",
    "--error-ink": "#ff8a80",
  },
  light: {
    "--page-bg": "#ffffff",
    "--page-ink": "#111111",
    "--surface": "#f4f4f5",
    "--surface-2": "#ececee",
    "--card": "#f4f4f5",
    "--card-hover": "#ebebed",
    "--raised": "#e4e4e7",
    "--field": "#ffffff",
    "--panel": "#ececee",
    "--text-strong": "#111111",
    "--text-soft": "#27272a",
    "--text-muted": "#3f3f46",
    "--text-dim": "#52525b",
    "--line": "#d4d4d8",
    "--line-strong": "#a1a1aa",
    "--error-bg": "#fdecea",
    "--error-line": "#f0b4ad",
    "--error-ink": "#a01c0e",
  },
};

const HEX = /^#([0-9a-f]{6})$/i;

function rgb(hex) {
  const match = HEX.exec(hex ?? "");
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]) {
  return `#${[r, g, b]
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")}`;
}

function luminance(color) {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/// Black or white, whichever reads better on `color`.
export function inkFor(color) {
  return contrast(color, "#000000") >= contrast(color, "#ffffff")
    ? "#000000"
    : "#ffffff";
}

/// Blend `color` toward white by `amount` (0–1).
export function lighten(color, amount) {
  return hex(rgb(color).map((v) => v + (255 - v) * amount));
}

/// Blend `color` toward black by `amount` (0–1).
export function darken(color, amount) {
  return hex(rgb(color).map((v) => v * (1 - amount)));
}

/// `color` lightened just enough to be readable on the black page.
export function legibleOnDark(color) {
  let candidate = color;
  for (let step = 1; contrast(candidate, PAGE_BACKGROUND) < MIN_ACCENT_CONTRAST; step++) {
    candidate = lighten(color, step / 10);
  }
  return candidate;
}

/// `color` darkened just enough to be readable on the white page.
export function legibleOnLight(color) {
  let candidate = color;
  for (
    let step = 1;
    step <= 10 && contrast(candidate, LIGHT_PAGE_BACKGROUND) < MIN_ACCENT_CONTRAST;
    step++
  ) {
    candidate = darken(color, step / 10);
  }
  return candidate;
}

/// A group's accent as a hex string (for places that build colors from it,
/// like the calendar's tinted chips); 8kount gold when it has no valid color.
export function groupAccent(group) {
  return rgb(group?.primaryColor)
    ? legibleOnDark(group.primaryColor)
    : DEFAULT_THEME["--accent"];
}

/// Light-mode variables: the accent is darkened to read on the white page.
function lightThemeFor(group) {
  const primary = group?.primaryColor;
  const base = rgb(primary) ? primary : DEFAULT_THEME["--brand"];
  const accent = legibleOnLight(base);
  return {
    "--brand": base,
    "--brand-ink": inkFor(base),
    "--brand-active": lighten(base, 0.45),
    "--accent": accent,
    "--accent-ink": inkFor(accent),
    "--accent-hover": darken(accent, 0.2),
  };
}

/// The CSS variables for a group, or 8kount branding when there is none or
/// its colors are unusable. `mode` is "dark" (default) or "light".
export function themeFor(group, mode = "dark") {
  if (mode === "light") return lightThemeFor(group);

  const primary = group?.primaryColor;
  if (!rgb(primary)) return DEFAULT_THEME;

  const accent = legibleOnDark(primary);
  return {
    "--brand": primary,
    "--brand-ink": inkFor(primary),
    "--brand-active": lighten(primary, 0.45),
    "--accent": accent,
    // legibleOnDark guarantees 4.5:1 against black, so black text always
    // reads on an accent fill (and matches the rgba(0,0,0,…) text inside
    // accent cards).
    "--accent-ink": "#000000",
    "--accent-hover": lighten(accent, 0.3),
  };
}

/// Colors for a group's tile on the Groups page: the team color edge to edge
/// with black or white text on it. Null when the group has no usable color.
export function groupTile(group) {
  const fill = group?.primaryColor;
  if (!rgb(fill)) return null;
  const ink = inkFor(fill);
  return { fill, ink, dark: ink === "#ffffff" };
}

/// Write a theme onto the document so every stylesheet's var(...) picks it up.
export function applyTheme(theme, root = document.documentElement) {
  for (const [name, value] of Object.entries(theme)) {
    root.style.setProperty(name, value);
  }
}
"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "hub-theme";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

// Subscribe to data-theme changes on <html> so the button icon stays in sync
// regardless of who flips the theme (this button, another instance, etc.).
function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * Sun/moon button that flips `data-theme` on <html> and persists to
 * localStorage("hub-theme"). The pre-hydration script in layout.tsx applies the
 * stored theme before paint; this component reads the applied value via
 * useSyncExternalStore (server snapshot = "light", matching the SSR default) so
 * there is no hydration mismatch and no setState-in-effect.
 */
export default function ThemeToggle() {
  const theme = useSyncExternalStore<Theme>(
    subscribe,
    currentTheme,
    () => "light",
  );

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }

  const label =
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      suppressHydrationWarning
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        borderRadius: 999,
        border: "1px solid var(--hairline)",
        background: "var(--surface)",
        color: "var(--ink)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      <span suppressHydrationWarning>{theme === "dark" ? "☀" : "☾"}</span>
    </button>
  );
}

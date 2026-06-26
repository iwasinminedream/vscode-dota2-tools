import React from "react";
import { createRoot } from "react-dom/client";
import { SearchPage } from "./vendor/components/api/pages/SearchPage";
import { notifySearchChange } from "./vendor/components/api/Search";

// ── Theme ────────────────────────────────────────────────────────────────────────
// The vendored global.css keys dark mode off `data-theme="dark"` on <html>. Honor a
// previously chosen theme (localStorage), otherwise follow the VS Code color theme the
// host applies as a body class. The in-page toggle (ThemeToggle) overrides afterwards.
function initTheme() {
  let theme: string | null = null;
  try {
    theme = localStorage.getItem("theme");
  } catch {
    /* webview storage may be unavailable */
  }
  if (!theme) {
    const isDark =
      document.body.classList.contains("vscode-dark") ||
      document.body.classList.contains("vscode-high-contrast");
    theme = isDark ? "dark" : "light";
  }
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}

// ── URL normalization ──────────────────────────────────────────────────────────────
// The vendored search/router logic reads window.location (?search=…). The webview boots
// with its own vscode-webview://…?id=… URL; normalize it to a clean /api/search path so
// getSearchFromUrl() starts empty and replaceState updates stay same-origin.
function normalizeUrl() {
  try {
    history.replaceState({}, "", "/api/search");
  } catch {
    /* ignore — some webview origins disallow path replaceState */
  }
}

// ── Internal-link backstop ──────────────────────────────────────────────────────────
// Most vendored links already preventDefault + pushState, but a few (e.g. ReferencesLink)
// are plain <a href="/api/…">. In a webview a real navigation would blank the panel, so we
// intercept internal /api links: if they carry a ?search=, apply it; otherwise no-op.
function installLinkInterceptor() {
  document.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as HTMLElement)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // Let external links (new-tab Google/GitHub search etc.) work normally.
      if (anchor.target === "_blank" || /^https?:\/\//.test(href)) return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || !url.pathname.includes("/api")) return;

      event.preventDefault();
      const search = url.searchParams.get("search");
      try {
        history.replaceState({}, "", search ? `/api/search?search=${encodeURIComponent(search)}` : "/api/search");
      } catch {
        /* ignore */
      }
      notifySearchChange();
    },
    true,
  );
}

// Surface any runtime error into the page instead of failing to a blank panel.
function showError(message: string) {
  const el = document.getElementById("root");
  if (el) {
    el.innerHTML =
      '<div style="padding:16px;font-family:monospace;font-size:12px;color:var(--color-text,#ccc);white-space:pre-wrap;word-break:break-word">' +
      "Dota2 API failed to load:\n\n" +
      message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string)) +
      "</div>";
  }
}
window.addEventListener("error", (e) => showError((e.error && e.error.stack) || e.message));
window.addEventListener("unhandledrejection", (e) => showError(String((e as PromiseRejectionEvent).reason)));

try {
  initTheme();
  normalizeUrl();
  installLinkInterceptor();

  const container = document.getElementById("root");
  if (container) {
    createRoot(container).render(<SearchPage />);
  }
} catch (err) {
  showError(err instanceof Error ? err.stack || err.message : String(err));
}

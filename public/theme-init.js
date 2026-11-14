// Runs synchronously from <head> (before first paint) so the page never flashes
// the wrong theme. It must be an external file, not inline: the app's CSP is
// `script-src 'self'`. Keep the logic in step with src/lib/theme.ts
// (`resolveTheme`); src/lib/theme.test.ts evaluates this file to pin that.
(function () {
  var pref = "dark";
  try {
    var raw = localStorage.getItem("settings.theme");
    if (raw != null) {
      var v = JSON.parse(raw);
      if (v === "dark" || v === "light" || v === "system") pref = v;
    }
  } catch {
    // Storage unavailable or corrupt: stay on the default (dark).
  }
  var theme = pref;
  if (pref === "system") {
    var prefersDark =
      typeof matchMedia !== "function" ||
      matchMedia("(prefers-color-scheme: dark)").matches;
    theme = prefersDark ? "dark" : "light";
  }
  var root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
})();

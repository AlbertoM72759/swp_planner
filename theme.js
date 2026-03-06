// theme.js — global V1/V2 toggle (persist across pages)
(function () {
  const KEY = "SAD_THEME"; // "v1" | "v2"

  function applyTheme(theme) {
    const t = (theme === "v2") ? "v2" : "v1";
    document.body.dataset.theme = t;

    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = (t === "v2") ? "V2" : "V1";

    try { localStorage.setItem(KEY, t); } catch {}
  }

  function getSavedTheme() {
    try { return localStorage.getItem(KEY); } catch {}
    return null;
  }

  document.addEventListener("DOMContentLoaded", () => {
    // apply saved theme on every page load
    applyTheme(getSavedTheme() || "v1");

    const btn = document.getElementById("themeToggle");
    if (!btn) return;

    btn.addEventListener("click", () => {
      const cur = document.body.dataset.theme || "v1";
      applyTheme(cur === "v1" ? "v2" : "v1");
    });
  });
})();
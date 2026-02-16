// query.js — ONLY runs on query.html
// Wiring-only: no core logic, no constants, no storage schema.
// Assumes app.js provides populateTimes() + queryAllSavedSchedulesDayRange().

(function () {
  function $(id) { return document.getElementById(id); }
  console.log("QUERY.JS LOADED v2026-02-11a");

  function escapeHTML(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function initTimes() {
    const qs = $("queryStart");
    const qe = $("queryEnd");

    if (typeof window.populateTimes === "function") {
      window.populateTimes(qs, { startMin: 6 * 60, endMin: 22 * 60, stepMin: 30 });
      window.populateTimes(qe, { startMin: 6 * 60, endMin: 22 * 60, stepMin: 30 });

    } else {
      console.warn("query.js: populateTimes() missing (expected from app.js)");
    }
  }

  function render(res) {
    const root = $("resultsContainer");
    if (!root) return;

    if (!res?.ok) {
      root.innerHTML = `<div class="warn">Query failed: ${escapeHTML(res?.reason || "unknown")}</div>`;
      return;
    }

    const available = Array.isArray(res.available) ? res.available : [];
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];

    if (!available.length) {
      root.innerHTML = `
        <div class="results-head">
          <div><b>${escapeHTML(res.day)}</b> ${escapeHTML(res.startStr)} → ${escapeHTML(res.endStr)}</div>
          <div class="muted">Listed: 0 • Skipped: ${skipped.length}</div>
        </div>

        <div class="muted">No one has free or placement time in that window.</div>

        ${skipped.length ? `
          <details class="skipped">
            <summary>Skipped (${skipped.length})</summary>
            <ul>
              ${skipped.map(s => `<li><b>${escapeHTML(s.person)}</b>: ${escapeHTML(s.reason)}</li>`).join("")}
            </ul>
          </details>
        ` : ``}
      `;
      return;
    }

    root.innerHTML = `
      <div class="results-head">
        <div><b>${escapeHTML(res.day)}</b> ${escapeHTML(res.startStr)} → ${escapeHTML(res.endStr)}</div>
        <div class="muted">Listed: ${available.length} • Skipped: ${skipped.length}</div>
      </div>

      ${available.map(p => {
        const person = escapeHTML(p?.person || "(unnamed)");

        const freeRanges = Array.isArray(p?.freeRanges) ? p.freeRanges : [];
        const workRanges = Array.isArray(p?.workRanges) ? p.workRanges : [];

        const freeHTML = freeRanges.length
          ? freeRanges.map(r => `
              <span class="pill">${escapeHTML(r.start)} – ${escapeHTML(r.end)}</span>
            `).join("")
          : `<span class="muted">No free time in this window.</span>`;

        const workHTML = workRanges.length
          ? workRanges.map(r => `
              <span class="pill pill-work">${escapeHTML(r.start)} – ${escapeHTML(r.end)}</span>
            `).join("")
          : "";

        return `
          <div class="result-bubble">
            <div class="result-name">${person}</div>

            <div class="result-ranges">
              ${freeHTML}
            </div>

            ${workRanges.length ? `
              <div class="result-work">
                <div class="result-work-label">Work:</div>
                <div class="result-work-ranges">
                  ${workHTML}
                </div>
              </div>
            ` : ``}
          </div>
        `;
      }).join("")}

      ${skipped.length ? `
        <details class="skipped">
          <summary>Skipped (${skipped.length})</summary>
          <ul>
            ${skipped.map(s => `<li><b>${escapeHTML(s.person)}</b>: ${escapeHTML(s.reason)}</li>`).join("")}
          </ul>
        </details>
      ` : ``}
    `;
  }

  function runQuery() {
    const day = $("queryDay")?.value || "Monday";
    const startStr = $("queryStart")?.value || "8:00 AM";
    const endStr = $("queryEnd")?.value || "9:00 AM";

    if (typeof window.queryAllSavedSchedulesDayRange !== "function") {
      render({
        ok: false,
        reason: "Missing core query function (queryAllSavedSchedulesDayRange) in app.js"
      });
      return;
    }

    const res = window.queryAllSavedSchedulesDayRange(day, startStr, endStr);
    render(res);
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTimes();

    const btn = $("queryButton");
    if (btn) btn.addEventListener("click", runQuery);
  });
})();

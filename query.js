// query.js — ONLY runs on query.html
// Wiring-only: no core logic, no constants, no storage schema.
// Assumes time.js provides populateTimes() and storage.js provides
// queryAllSavedSchedulesDayRange().

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

  // Renders one result card. `variant` controls the styling:
  //   "free"  -> pure Available card (green-tier)
  //   "mixed" -> Available + Placement card (both free + work pills shown)
  //   "work"  -> Placement-only row (compact, lives inside the collapsed bar)
  function renderCard(p, variant) {
    const person = escapeHTML(p?.person || "(unnamed)");
    const freeRanges = Array.isArray(p?.freeRanges) ? p.freeRanges : [];
    const workRanges = Array.isArray(p?.workRanges) ? p.workRanges : [];

    const freeHTML = freeRanges.length
      ? freeRanges.map(r => `<span class="pill">${escapeHTML(r.start)} – ${escapeHTML(r.end)}</span>`).join("")
      : "";

    const workHTML = workRanges.length
      ? workRanges.map(r => `<span class="pill pill-work">${escapeHTML(r.start)} – ${escapeHTML(r.end)}</span>`).join("")
      : "";

    if (variant === "work") {
      // Compact row used inside the collapsed Placement bar
      return `
        <div class="result-bubble result-bubble-placement">
          <div class="result-name">${person}</div>
          <div class="result-ranges">${workHTML}</div>
        </div>
      `;
    }

    return `
      <div class="result-bubble${variant === "mixed" ? " result-bubble-mixed" : ""}">
        <div class="result-name">${person}</div>

        <div class="result-ranges">
          ${freeHTML}
        </div>

        ${workRanges.length ? `
          <div class="result-work">
            <div class="result-work-label">Also at placement:</div>
            <div class="result-work-ranges">${workHTML}</div>
          </div>
        ` : ``}
      </div>
    `;
  }

  function render(res) {
    const root = $("resultsContainer");
    if (!root) return;

    if (!res?.ok) {
      root.innerHTML = `<div class="warn">Query failed: ${escapeHTML(res?.reason || "unknown")}</div>`;
      return;
    }

    const available = Array.isArray(res.available) ? res.available : [];
    const availablePlacement = Array.isArray(res.availablePlacement) ? res.availablePlacement : [];
    const placement = Array.isArray(res.placement) ? res.placement : [];
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];

    const totalListed = available.length + availablePlacement.length + placement.length;

    const headHTML = `
      <div class="results-head">
        <div><b>${escapeHTML(res.day)}</b> ${escapeHTML(res.startStr)} → ${escapeHTML(res.endStr)}</div>
        <div class="muted">Listed: ${totalListed} • Skipped: ${skipped.length}</div>
      </div>
    `;

    if (!totalListed) {
      root.innerHTML = `
        ${headHTML}
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

    // --- Tier 1: Available ---
    const tier1HTML = available.length ? `
      <div class="tier-section tier-available">
        <div class="tier-heading">Available for Crew Jobs (${available.length})</div>
        <div class="tier-grid">
          ${available.map(p => renderCard(p, "free")).join("")}
        </div>
      </div>
    ` : "";

    // --- Tier 2: Available + Placement (mixed) ---
    const tier2HTML = availablePlacement.length ? `
      <div class="tier-section tier-mixed">
        <div class="tier-heading">Available &amp; At Placement (${availablePlacement.length})</div>
        <div class="tier-grid">
          ${availablePlacement.map(p => renderCard(p, "mixed")).join("")}
        </div>
      </div>
    ` : "";

    // --- Tier 3: Placement only (collapsed bar) ---
    const tier3HTML = placement.length ? `
      <details class="tier-placement-bar">
        <summary>Placement (${placement.length}) — fully at placement, backup option only</summary>
        <div class="tier-grid tier-grid-compact">
          ${placement.map(p => renderCard(p, "work")).join("")}
        </div>
      </details>
    ` : "";

    root.innerHTML = `
      ${headHTML}
      ${tier1HTML}
      ${tier2HTML}
      ${tier3HTML}
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

    // ✅ Default window: 6:00 AM → 6:30 AM
    const qs = $("queryStart");
    const qe = $("queryEnd");

    if (qs && !qs.value) qs.value = "6:00 AM";
    if (qe && !qe.value) qe.value = "6:30 AM";

    const btn = $("queryButton");
    if (btn) btn.addEventListener("click", runQuery);
  });
})();
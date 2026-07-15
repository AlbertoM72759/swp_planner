/*************************
 * UI-UPLOAD.JS — Layer M: the 'Saved schedules' sidebar list,
 * preview modal, and their click/delegation bindings
 * Depends on: session.js (publishSession/__SAD_SESSION__),
 *             storage.js (loadSchedulesList/deleteScheduleById/
 *             clearAllSchedules/addScheduleFromCurrentSession/
 *             resetAfterAddScheduleUI)
 * Loaded on: upload.html ONLY
 *************************/

/*************************
 * ✅ LAYER M — UI (B+-aligned, SINGLE-BIND, READY-GATED)
 *
 * GOALS (LOCKED):
 * - NO duplicate listeners (bind once by “clone-nuke” strategy)
 * - Add Schedule ONLY when __SAD_SESSION__.ready === true
 * - Sidebar list renders from B+ storage (loadSchedulesList)
 * - Preview uses STORED thumbnail only
 * - Delete + Clear All route through B+ storage
 * - Visibility toggle (if present) stays synced
 *
 * IMPORTANT:
 * - Layer M is UI-only orchestration.
 * - It NEVER recomputes pixels, navigation, or semantics.
 *************************/
/* -------------------------------------------
 * M0 — DOM (soft refs; do not crash if missing)
 * ----------------------------------------- */
const M = {
  personNameInput: document.getElementById("personName"),
  addScheduleButton: document.getElementById("addScheduleButton"),
  imageInput: document.getElementById("imageInput"),

  clearAllButton: document.getElementById("clearAllButton"),
  schedulesList: document.getElementById("schedulesList"),
  schedulesCount: document.getElementById("schedulesCount"),
  toggleListButton: document.getElementById("toggleListButton"),
  debugToggle: document.getElementById("debugToggle"),

  previewModal: document.getElementById("previewModal"),
  previewImg: document.getElementById("previewImg"),
  previewTitle: document.getElementById("previewTitle"),
  previewClose: document.getElementById("previewClose"),
};

/* -------------------------------------------
 * M1 — Tiny UI helpers
 * ----------------------------------------- */
function M_escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function M_setDisabled(el, on, title = "") {
  if (!el) return;
  el.disabled = !!on;
  el.title = title || "";
}

const M_LIST_VIS_KEY = "SAD_UI_LIST_VISIBLE_V1";

function M_setListVisible(on) {
  const visible = !!on;

  if (M.schedulesList) {
    M.schedulesList.style.display = visible ? "" : "none";
  }

  if (M.toggleListButton) {
    M.toggleListButton.textContent = visible ? "Hide" : "Show";
    M.toggleListButton.title = visible ? "Hide saved schedules" : "Show saved schedules";
  }

  try { localStorage.setItem(M_LIST_VIS_KEY, visible ? "1" : "0"); } catch {}
}

function M_getListVisibleDefaultTrue() {
  try {
    const v = localStorage.getItem(M_LIST_VIS_KEY);
    if (v === "0") return false;
  } catch {}
  return true; // default: visible
}

function M_toast(msg) {
  if (typeof window.toast === "function") return window.toast(msg);
  console.warn("UI:", msg);
  alert(msg);
}

function M_lockBodyScroll(on) {
  if (!document?.body) return;
  document.body.style.overflow = on ? "hidden" : "";
}

function M_openModalWithThumb(dataUrl, title = "") {
  if (!M.previewModal || !M.previewImg) return;
  M.previewImg.src = dataUrl || "";
  if (M.previewTitle) M.previewTitle.textContent = title || "";
  M.previewModal.style.display = "flex";
  M_lockBodyScroll(true);
}

function M_closeModal() {
  if (!M.previewModal) return;

  if (__M_PREVIEW_REVOKE__) { try { __M_PREVIEW_REVOKE__(); } catch {} }
  __M_PREVIEW_REVOKE__ = null;

  M.previewModal.style.display = "none";
  if (M.previewImg) M.previewImg.src = "";
  if (M.previewTitle) M.previewTitle.textContent = "";
  M_lockBodyScroll(false);
}

let __M_PREVIEW_REVOKE__ = null;

async function M_openModalForScheduleId(id, fallbackThumbDataUrl = "", title = "") {
  if (!M.previewModal || !M.previewImg) return;

  // reset any prior objectURL
  if (__M_PREVIEW_REVOKE__) { try { __M_PREVIEW_REVOKE__(); } catch {} }
  __M_PREVIEW_REVOKE__ = null;

  // Prefer full-res blob from IndexedDB
  try {
    if (typeof window.SAD_getPreviewObjectURL === "function") {
      const r = await window.SAD_getPreviewObjectURL(id);
      if (r?.ok && r.url) {
        M.previewImg.src = r.url;
        __M_PREVIEW_REVOKE__ = r.revoke || null;
      } else {
        M.previewImg.src = fallbackThumbDataUrl || "";
      }
    } else {
      M.previewImg.src = fallbackThumbDataUrl || "";
    }
  } catch {
    M.previewImg.src = fallbackThumbDataUrl || "";
  }

  if (M.previewTitle) M.previewTitle.textContent = title || "";
  M.previewModal.style.display = "flex";
  M_lockBodyScroll(true);
}

/* -------------------------------------------
 * M2 — READY gate (single source of truth)
 * ----------------------------------------- */
function M_getSessionGate() {
  const sess = window.__SAD_SESSION__;  

  // Session must exist and be explicitly ready
  if (!sess) return { ok: false, missing: ["SESSION_MISSING"], sess: null };
  if (!sess.ready) {
    const reason = typeof sess.reason === "string" && sess.reason.startsWith("missing:")
      ? sess.reason.replace("missing:", "").split(",").map(s => s.trim())
      : ["SESSION_NOT_READY"];
    return { ok: false, missing: reason, sess };
  }

  // Strict key checks for Add Schedule
  const missing = [];
  if (!sess.nav) missing.push("nav");
  if (!sess.nav?.dayRegions) missing.push("dayRegions");
  if (!sess.nav?.slotBands) missing.push("slotBands");
  if (!sess.nav?.bgWhite && !sess.nav?.bg) missing.push("bg/bgWhite");
  if (!sess.nav?.ticksForMap) missing.push("ticksForMap");

  if (missing.length) return { ok: false, missing, sess };

  return { ok: true, missing: [], sess };
}

function M_updateAddButtonGate() {
  if (!M.addScheduleButton) return;

  const g = M_getSessionGate();
  if (!g.ok) {
    const friendly = (typeof window.SAD_explainMissingCodes === "function")
      ? window.SAD_explainMissingCodes(g.missing)
      : "We're still missing something — check the preview above.";

    M_setDisabled(M.addScheduleButton, true, friendly);
  } else {
    M_setDisabled(M.addScheduleButton, false, "");
  }
}

// --- M2B: called by upload-time after publishSession() ---
function M_onSessionPublished() {
  M_updateAddButtonGate();
  // optional: if you want the UI to reflect thumb/name changes immediately
  // M_renderSchedulesList();
}

// expose for upload-time (safe no-op if Layer M loads after)
window.M_onSessionPublished = M_onSessionPublished;
// ✅ Option A: upload.js is the ONLY binder.
// It pings this whenever session gate might change (reset/publish).
window.M_onSessionGateChanged = function () {
  try { M_updateAddButtonGate(); } catch {}
};

/* -------------------------------------------
 * M3 — B+ wrappers (storage is authority)
 * ----------------------------------------- */
function M_safeLoadSchedulesList() {
  const fn = window.loadSchedulesList || (typeof loadSchedulesList === "function" ? loadSchedulesList : null);
  if (!fn) return [];
  const out = fn();
  return Array.isArray(out) ? out : [];
}

function M_safeDeleteScheduleById(id) {
  const fn = window.deleteScheduleById || (typeof deleteScheduleById === "function" ? deleteScheduleById : null);
  if (!fn) throw new Error("B+ deleteScheduleById() missing");
  return fn(id);
}

function M_safeClearAllSchedules() {
  const fn = window.clearAllSchedules || (typeof clearAllSchedules === "function" ? clearAllSchedules : null);
  if (!fn) throw new Error("B+ clearAllSchedules() missing");
  return fn();
}

/* -------------------------------------------
 * M4 — Sidebar render (from B+ list)
 * ----------------------------------------- */
function M_renderSchedulesList() {
  if (!M.schedulesList) return;

  const arr = M_safeLoadSchedulesList();

  if (M.schedulesCount) M.schedulesCount.textContent = String(arr.length);

  if (!arr.length) {
    M.schedulesList.innerHTML = `
      <div class="schedule-empty">
        <div class="schedule-empty-title">No schedules saved</div>
        <div class="schedule-empty-sub">Upload an image, then click Add Schedule.</div>
      </div>
    `;
    return;
  }

  M.schedulesList.innerHTML = arr.map((s) => {
    const id = M_escapeHTML(s?.id ?? "");
    const name = M_escapeHTML(s?.person ?? s?.name ?? "Unnamed");

    // tolerate a few historical thumb shapes
    const thumb =
      s?.thumb?.dataURL ||
      (typeof s?.thumb === "string" ? s.thumb : "") ||
      s?.thumbDataUrl ||
      "";

    const hasThumb = !!thumb;

    return `
      <div class="schedule-row" data-id="${id}">
        <div class="schedule-row-left">
          ${hasThumb
            ? `<img class="schedule-thumb" src="${thumb}" alt="thumb" />`
            : `<div class="schedule-thumb" aria-hidden="true"></div>`
          }
          <div class="schedule-row-name">${name}</div>
        </div>

        <div class="schedule-row-actions">
          <button class="btn-small btn-preview"
            title="Preview"
            data-action="preview"
            data-id="${id}">
            Preview
          </button>

          <button class="btn-small btn-danger"
            data-action="delete"
            data-id="${id}">
            Delete
          </button>
        </div>
      </div>
    `;
  }).join("");
}

function M_onSchedulesListClick(e) {
  const btn = e.target?.closest?.("button[data-action]");
  if (!btn) return;

  const action = btn.getAttribute("data-action");
  const id = btn.getAttribute("data-id") || "";
  if (!id) return;

  const row = btn.closest(".schedule-row");
  const name = row?.querySelector?.(".schedule-row-name")?.textContent || "";

  if (action === "preview") {
    // fallback thumb (if present)
    const rec = (M_safeLoadSchedulesList?.() || []).find(r => r?.id === id);
    const thumb =
      rec?.thumb?.dataURL ||
      (typeof rec?.thumb === "string" ? rec.thumb : "") ||
      rec?.thumbDataUrl ||
      "";
    M_openModalForScheduleId(id, thumb, name);
    return;
  }

  if (action === "delete") {
    // your existing delete flow (whatever you already have)
    if (typeof window.deleteScheduleById === "function") {
      window.deleteScheduleById(id);
      M_renderSchedulesList();
    }
  }
}

/* -------------------------------------------
 * M5 — Add Schedule click (READY-gated)
 *
 * Contract (locked):
 * - addScheduleFromCurrentSession() does compute+store+return ONLY
 * - Layer M handles UI updates + reset exactly once
 * ----------------------------------------- */
function M_getPersonName() {
  return (M.personNameInput?.value ?? "").trim();
}

function M_callAddSchedulePipeline() {
  const fn = window.addScheduleFromCurrentSession;
  if (typeof fn !== "function") {
    throw new Error("addScheduleFromCurrentSession() is missing. Layer M only calls this pipeline.");
  }
  return fn();
}

function M_resetAfterAddScheduleUIOnce() {
  const fn = window.resetAfterAddScheduleUI;
  if (typeof fn === "function") fn();
  else {
    // fallback minimal reset (should never happen now)
    if (M.personNameInput) M.personNameInput.value = "";
    if (M.imageInput) M.imageInput.value = "";
  }
}

async function M_onAddScheduleClick() {
  try {
    // ✅ pipeline is now async (IndexedDB), so we must await
    const r = await window.addScheduleFromCurrentSession();

    if (!r?.ok) {
      throw new Error(r?.reason || "save failed");
    }
    M_renderSchedulesList();

    // exactly once
    if (typeof window.resetAfterAddScheduleUI === "function") {
      window.resetAfterAddScheduleUI();
    }

    // keep your existing success status/UI if you have it
    console.log("UI: Add Schedule ok", { id: r.id, count: r.count });
  } catch (e) {
    console.error("UI: Add Schedule failed:", e);

    const friendly = (typeof window.SAD_explainSaveError === "function")
      ? window.SAD_explainSaveError(e?.message || String(e))
      : "This schedule could not be saved. Please try again.";

    if (typeof window.setUploadStatus === "function") {
      window.setUploadStatus("error", friendly);
    }
  }
}

window.M_onAddScheduleClick = M_onAddScheduleClick;

/* -------------------------------------------
 * M6 — Single-bind strategy (NO DUPES)
 * - clone-nuke removes unknown anonymous handlers
 * ----------------------------------------- */
function M_rebindClickOnce(btn, handler) {
  if (!btn) return null;
  const clone = btn.cloneNode(true);
  btn.replaceWith(clone);
  clone.addEventListener("click", handler);
  return clone;
}

function M_rebindListDelegationOnce(listEl) {
  if (!listEl) return null;

  const clone = listEl.cloneNode(true);
  listEl.replaceWith(clone);
  M.schedulesList = clone;

  clone.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const action = t.getAttribute("data-action");
    const id = t.getAttribute("data-id");
    if (!action || !id) return;

    if (action === "preview") {
      const list = M_safeLoadSchedulesList();
      const s = list.find(x => String(x?.id) === String(id));
      if (!s) return;

      const thumb =
        s?.thumb?.dataURL ||
        (typeof s?.thumb === "string" ? s.thumb : "") ||
        s?.thumbDataUrl ||
        "";

      const title = (s?.person ?? s?.name ?? "").toString();

      // ✅ Prefer crisp original for THIS session if we have it
      const live = (typeof window.SAD_getLiveSrc === "function")
        ? window.SAD_getLiveSrc(id)
        : null;

      const src = live || thumb;
      if (!src) return;

      M_openModalForScheduleId(id, thumb, title);
      return;
    }

    if (action === "delete") {
      try {
        M_safeDeleteScheduleById(id);
        M_renderSchedulesList();
      } catch (err) {
        console.error("Delete failed:", err);
        M_toast(`Delete failed: ${err?.message || err}`);
      }
      return;
    }
  });

  return clone;
}

function M_bindModalOnce() {
  if (M.previewModal && !M.previewModal.__M_BOUND__) {
    M.previewModal.__M_BOUND__ = true;
    M.previewModal.addEventListener("click", (e) => {
      if (e.target === M.previewModal) M_closeModal();
    });
  }

  if (M.previewClose && !M.previewClose.__M_BOUND__) {
    M.previewClose.__M_BOUND__ = true;
    M.previewClose.addEventListener("click", M_closeModal);
  }
}

function M_bindClearAllOnce() {
  if (!M.clearAllButton) return;
  M.clearAllButton = M_rebindClickOnce(M.clearAllButton, () => {
    try {
      M_safeClearAllSchedules();
      M_renderSchedulesList();
      M_closeModal();
      M_toast("Cleared all schedules.");
    } catch (err) {
      console.error("Clear all failed:", err);
      M_toast(`Clear all failed: ${err?.message || err}`);
    }
  });
}

function M_bindToggleListOnce() {
  if (!M.toggleListButton) return;

  M.toggleListButton = M_rebindClickOnce(M.toggleListButton, () => {
    const currentlyVisible = (M.schedulesList && M.schedulesList.style.display !== "none");
    M_setListVisible(!currentlyVisible);
  });
}

/* -------------------------------------------
 * M7 — Init (call once)
 * ----------------------------------------- */
function initLayerM_UI() {
  console.log("STACK M0: init UI layer");

  if (window.__STACK_M_INIT__) {
    console.warn("STACK M0: init skipped (already initialized)");
    return;
  }
  window.__STACK_M_INIT__ = true;

  // Bind once (nuke dupes)
  if (M.addScheduleButton) {
    M.addScheduleButton = M_rebindClickOnce(M.addScheduleButton, M_onAddScheduleClick);
  }
  M_bindClearAllOnce();
  M_bindToggleListOnce();
  if (M.schedulesList) M_rebindListDelegationOnce(M.schedulesList);
  M_bindModalOnce();

  // Render from storage + apply gate
  M_renderSchedulesList();
  M_updateAddButtonGate();
  M_setListVisible(M_getListVisibleDefaultTrue());

  console.log("STACK M1: UI ready", {
    hasAdd: !!M.addScheduleButton,
    hasList: !!M.schedulesList,
    hasClearAll: !!M.clearAllButton,
    hasModal: !!M.previewModal
  });
}

/*************************
 * ✅ LAYER M — BOOTSTRAP (Pattern A)
 * Ensure Layer M actually runs and binds its listeners exactly once.
 *************************/
(function bootLayerM() {
  function shouldInitM() {
    // Only init on pages that actually have the Upload UI pieces.
    return !!document.getElementById("addScheduleButton") ||
           !!document.getElementById("schedulesList") ||
           !!document.getElementById("clearAllButton");
  }

  function start() {
    if (!shouldInitM()) return; // safe on index/query pages
    if (typeof initLayerM_UI === "function") {
      initLayerM_UI();
    } else {
      console.warn("Layer M bootstrap: initLayerM_UI() missing");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
/************************************************************
 * upload.js — Upload page wiring (Two-phase upload-time compute)
 *
 * PHASE 1 (image selected):
 *   - have compute ONCE (nav gemetry + bg + slots)
 *   - does NOT publish __SAD_SESSION__.ready yet
 *   - shows status bubble + "Start time is live"
 *
 * PHASE 2 (start time changed):
 *   - cheap finalize (anchorStartTime + timeIndex if available)
 *   - publishSession() -> __SAD_SESSION__.ready === true
 *   - Layer M gate updates
 ************************************************************/

(function () {
  const elPerson = document.getElementById("personName");
  const elStart = document.getElementById("startTime");
  const elFile = document.getElementById("imageInput");
  const elConfirm = document.getElementById("confirmStartTimeButton");
  const elPreviewWrap = document.getElementById("phase1PreviewWrap");
  const elPreviewImg  = document.getElementById("phase1PreviewImg");


  // status elements (you already have these)
  const elStatusText = document.getElementById("statusText");
  const elUploadStatus = document.getElementById("uploadStatus");

  // two-phase stash (Phase 1 outputs live here until finalized)
  let __PHASE1__ = null;

  // Live (in-memory) original image URL for crisp preview during this session.
  // Not stored; revoked on next file selection.
  let __LIVE_ORIG_URL__ = null;

  function setLiveOrigURL(file) {
    // revoke previous
    if (__LIVE_ORIG_URL__) {
      try { URL.revokeObjectURL(__LIVE_ORIG_URL__); } catch {}
      __LIVE_ORIG_URL__ = null;
    }
    if (file) {
      __LIVE_ORIG_URL__ = URL.createObjectURL(file);
    }
    return __LIVE_ORIG_URL__;
  }

  if (elConfirm) elConfirm.disabled = true;
  showPhase1Preview(null);

  function showStatus(mode, msg, sub = "") {
    // Prefer your app.js helper if present
    if (typeof window.setUploadStatus === "function") {
      window.setUploadStatus(mode, msg, sub);
      return;
    }

    // Fallback
    if (!elUploadStatus) return;
    if (!mode || mode === "hide") {
      elUploadStatus.style.display = "none";
      elUploadStatus.className = "status-bubble status-idle";
      elUploadStatus.innerHTML = "";
      return;
    }

    elUploadStatus.style.display = "block";
    elUploadStatus.className = `status-bubble ${mode === "working" ? "status-working" : "status-idle"}`;
    elUploadStatus.innerHTML = `
      <div>${escapeHTML(msg)}</div>
      ${sub ? `<div class="status-sub">${escapeHTML(sub)}</div>` : ""}
    `;
  }

  function setInlineText(s) {
    if (!elStatusText) return;
    elStatusText.textContent = s || "";
  }

  function escapeHTML(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Try to create a thumb using your helper (preferred).
  function tryBuildThumb() {
    try {
      if (typeof window.buildThumbFromCanvas === "function") {
        return window.buildThumbFromCanvas({ maxW: 320, jpegQuality: 0.72 });
      }
    } catch {}
    return null;
  }

  // Cheap finalize: anchorStartTime + timeIndex (if supported)
  function tryFinalizeNavWithStartTime(navCore, anchorStartTime) {
    const nav = { ...(navCore || {}) };

    // Always set anchorStartTime in final nav
    nav.anchorStartTime = anchorStartTime || nav.anchorStartTime || "8:00 AM";

    // If you have a builder for timeIndex, call it (optional)
    // This keeps your "O(1) lookup: day → time → rect" promise.
    try {
      if (typeof window.buildTimeIndexFromNav === "function") {
        nav.timeIndex = window.buildTimeIndexFromNav(nav);
      } else if (typeof window.buildTimeIndexFromTicks === "function") {
        // Some builds have this flavor; if present, use it.
        nav.timeIndex = window.buildTimeIndexFromTicks(nav.ticksForMap, nav.slotBands, nav.dayRegions, nav.anchorStartTime);
      }
    } catch (e) {
      console.warn("Finalize: timeIndex build failed (non-fatal)", e);
    }

    return nav;
  }

  async function awaitMaybePromise(x) {
    if (x && typeof x.then === "function") return await x;
    return x;
  }

  // Wait until LAST_PRE exists (or timeout) — this is the real “image is ready” signal
  async function waitForPreReady(timeoutMs = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const pre = window.LAST_PRE || window.__LAST_PRE__ || null;
      if (pre && pre.imgData && Number.isFinite(pre.w) && Number.isFinite(pre.h)) return pre;
      await new Promise(r => setTimeout(r, 30));
    }
    return null;
  }

  function showPhase1Preview(src) {
    if (!elPreviewWrap || !elPreviewImg) return;
    if (!src) {
      elPreviewWrap.style.display = "none";
      elPreviewImg.src = "";
      return;
    }
    elPreviewImg.src = src;      // can be objectURL or dataURL
    elPreviewWrap.style.display = "block";
  }

  async function drawFileToCanvas(file) {
    const canvas = document.getElementById("canvas");
    const ctx = canvas ? canvas.getContext("2d") : null;
    if (!canvas || !ctx) throw new Error("Missing #canvas or 2D context");

    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("Image decode failed"));
        im.src = url;
      });

      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      return { ok: true, w: canvas.width, h: canvas.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // -------------------------
  // PHASE 1: Heavy compute ONCE
  // -------------------------
  async function runPhase1FromFile(file) {
    // Reset global session (exists in your app.js)
    if (typeof window.resetSession === "function") {
      window.resetSession("upload file selected");
    }

    // ✅ Option A: upload.js owns wiring; tell Layer M to refresh Add gate after reset
    if (typeof window.M_onSessionGateChanged === "function") {
      try { window.M_onSessionGateChanged(); } catch {}
    }

    __PHASE1__ = null;
    showStatus("working", "Processing schedule image…", "Phase 1: scanning grid, slots, and background");
    setInlineText("");

    // ✅ Human preview must be crisp: use original file URL (NOT lossy thumb)
    const liveSrc = setLiveOrigURL(file);
    showPhase1Preview(liveSrc);


    // 1) Draw image to canvas + build precompute/nav (your stack should do this)
    // We support two common setups:
    //   A) You have a single upload-time pipeline function
    //   B) You have captureCurrentImageForSave() + snapshotNavState() + computeAvailFromFrozenNav()

    let navCore = null;
    let thumb = null;

    // --- A) One-shot pipeline (if you add one later) ---
    if (typeof window.uploadPhase1Compute === "function") {
      const r = await window.uploadPhase1Compute(file, {
        onStatus: (msg, sub) => showStatus("working", msg, sub || ""),
      });

      if (!r?.ok) throw new Error(r?.reason || "uploadPhase1Compute failed");
      navCore = r.navCore || r.nav;
      thumb = r.thumb || null;
    } else {
      // Always draw the image into the canvas (independent of app.js helpers)
      await drawFileToCanvas(file);
      // 🔹 Layer E: build and publish pixel precompute (ONCE per upload)
      if (typeof window.buildAndPublishPrecompute === "function") {
        const r = window.buildAndPublishPrecompute();
        if (!r?.ok) {
          throw new Error(`Precompute build failed: ${r?.reason || "unknown"}`);
        }
      } else {
        throw new Error("buildAndPublishPrecompute() missing — Layer E not implemented");
      }

      // ✅ HARD WAIT: ensure LAST_PRE exists and canvas draw is effectively done
      const preReady = await waitForPreReady(6000);
      if (!preReady) throw new Error("Timed out waiting for image precompute (LAST_PRE not ready).");

      // ✅ get the actual pre object
      const pre = window.LAST_PRE;
      if (!pre) throw new Error("LAST_PRE missing after waitForPreReady()");
      // DEBUG: expose pre for console diagnostics (read-only)
      try {
        window.__LAST_PRE__ = pre;
        console.log("DEBUG: __LAST_PRE__ exported", {
          w: pre?.w,
          h: pre?.h,
          imgLen: pre?.imgData?.length,
          hasImgData: !!pre?.imgData
        });
      } catch (e) {
        console.warn("DEBUG: failed exporting __LAST_PRE__", e);
      }

      // 🔹 NAV builder must run in Phase 1
      if (typeof window.buildAndPublishNav === "function") {
        // 🔹 NAV builder (Phase 1 responsibility)
        const nr = window.buildAndPublishNav(pre);
        if (!nr?.ok) {
          throw new Error(`Nav build failed: ${nr?.reason || "unknown"}`);
        }

        // 🔹 Build preview thumb AFTER nav/precompute
        thumb = tryBuildThumb();

        // 🔹 Stash Phase 1 results ONLY (do NOT publish)
        __PHASE1__ = {
          fileName: file?.name || "",
          personName: (elPerson?.value || "").trim(),
          navCore: nr.nav,
          thumb,
          liveSrc
        };

        // 🔹 UI updates only
        showPhase1Preview(liveSrc || "");
        showStatus(
          "idle",
          "Phase 1 complete.",
          "Start time is live — change it if needed."
        );

      if (elConfirm) elConfirm.disabled = false;

      // 🔹 Phase 1 ENDS HERE
      return;
      }
    }   
  }
  // -------------------------
  // PHASE 2: Cheap finalize
  // -------------------------
  function runPhase2Finalize() {
    if (!__PHASE1__?.navCore) return;

    const personName =
      (elPerson?.value || "").trim() ||
      (__PHASE1__?.personName || "").trim();

    const startTime = (elStart?.value || "").trim() || "8:00 AM";

    showStatus("working", "Finalizing…", "Phase 2: applying start time + building time mapping");

    // Final nav = navCore + anchor + optional timeIndex
    const navFinal = tryFinalizeNavWithStartTime(__PHASE1__.navCore, startTime);
        // DEBUG: minimal Phase 2 snapshot (for 6:00 AM + random fails)
    try {
      const t = navFinal?.ticksForMap;
      const tickCount = Array.isArray(t) ? t.length : -1;
      const firstTickY = (Array.isArray(t) && t.length) ? t[0] : null;
      const lastTickY  = (Array.isArray(t) && t.length) ? t[t.length - 1] : null;

      console.log("STACK UPLOAD: PHASE2 SNAPSHOT", {
        personName,
        startTime,
        tickCount,
        firstTickY,
        lastTickY,
        hasDayRegions: !!navFinal?.dayRegions,
        hasSlotBands: !!navFinal?.slotBands,
        hasBg: !!(navFinal?.bgWhite || navFinal?.bg),
        slotBandsN: Array.isArray(navFinal?.slotBands) ? navFinal.slotBands.length : -1,
      });
    } catch (e) {
      console.warn("STACK UPLOAD: PHASE2 SNAPSHOT failed", e);
    }
    const pre = window.LAST_PRE;
    if (!pre) {
      console.warn("LAST_PRE missing — cannot finalize");
      showStatus("idle", "Finalize failed.", "Missing LAST_PRE (Phase 1 precompute not ready).");
      return;
    }

    if (typeof window.computeAvailFromFrozenNav !== "function") {
      console.warn("computeAvailFromFrozenNav() missing — cannot finalize");
      showStatus("idle", "Finalize failed.", "Missing computeAvailFromFrozenNav() in app.js.");
      return;
    }

    const a = window.computeAvailFromFrozenNav(pre, navFinal, {
      spillPolicy: "softFree",
      classify: {}
    });

    if (!a?.ok || !a?.avail) {
      console.warn("Availability compute failed", a);
      showStatus("idle", "Finalize failed.", a?.reason || "Availability compute failed (see console).");
      return;
    }

    const availFinal = a.avail;
    availFinal.anchorStartTime = startTime;

    // --- Phase 2 guarantee: ensure thumb exists at publish time ---
    // Phase 1 can run before the canvas is fully drawn (async image decode),
    // so build the thumb again here if needed.
    let thumbFinal = __PHASE1__.thumb || null;
    if (!thumbFinal) {
      thumbFinal = tryBuildThumb();
      if (thumbFinal) __PHASE1__.thumb = thumbFinal; // keep stash consistent
    }

    // Publish ready session (this is what unblocks Add Schedule)
    if (typeof window.publishSession !== "function") {
      console.warn("publishSession() missing — cannot mark session ready.");
      showStatus("idle", "Finalize complete (local only).", "Missing publishSession(), so Add Schedule may remain disabled.");
      return;
    }

    const sess = window.publishSession({
      personName: personName || "",
      fileName: __PHASE1__.fileName || "",
      thumb: thumbFinal,
      nav: navFinal,
      avail: availFinal,
      meta: { phase1: true, phase2: true, liveSrc: (__PHASE1__?.liveSrc || null) }
    });

    console.log("DEBUG: publishSession returned", {
      ready: sess?.ready,
      hasSess: !!sess,
      hasNav: !!sess?.nav,
      hasAvail: !!sess?.avail,
      hasThumb: !!sess?.thumb,
      personName: sess?.personName,
    });
    console.log("DEBUG: __SAD_SESSION__", window.__SAD_SESSION__);

    // Ping Layer M gate updater (if present)
    if (typeof window.M_onSessionPublished === "function") {
      try { window.M_onSessionPublished(); } catch {}
    }

    showStatus(
      "idle",
      sess?.ready ? "Ready to Add Schedule." : "Finalize done, but session is not ready.",
      sess?.ready
        ? "Click Add Schedule to save. (No recompute will happen.)"
        : "Check console — READY gate is missing required keys."
    );
  }

  // -------------------------
  // Wire events
  // -------------------------
  function rebindOnce(inputEl) {
    if (!inputEl) return null;
    const clone = inputEl.cloneNode(true);
    inputEl.replaceWith(clone);
    return clone;
  }

  function bind() {
    if(window.__SAD_UPLOAD_BOUND__) return;
    window.__SAD_UPLOAD_BOUND__ = true;
    // Re-grab live nodes (in case Layer M re-rendered)
    const file0    = document.getElementById("imageInput");
    const startEl  = document.getElementById("startTime");
    const personEl = document.getElementById("personName");
    const confirmEl= document.getElementById("confirmStartTimeButton");
    const listEl   = document.getElementById("schedulesList");
    const closeEl  = document.getElementById("previewClose");
    const modal0   = document.getElementById("previewModal");
    const toggleEl = document.getElementById("toggleListButton");

    if (!file0) {
      console.warn("upload.js: missing #imageInput");
      return;
    }

    // Dedupe file input (safe)
    const fileEl = rebindOnce(file0);

    const addEl   = document.getElementById("addScheduleButton") || null;
    const clearEl = document.getElementById("clearAllButton") || null;

    // ✅ Show/Hide Saved list (UI-only; must NOT depend on session readiness)
    if (toggleEl && !toggleEl.dataset.boundClick) {
      toggleEl.dataset.boundClick = "1";
      toggleEl.disabled = false;

      const apply = (collapsed) => {
        if (listEl) listEl.style.display = collapsed ? "none" : "block";
        toggleEl.textContent = collapsed ? "Show" : "Hide";
        try { localStorage.setItem("SAD_UPLOAD_LIST_COLLAPSED", collapsed ? "1" : "0"); } catch {}
      };

      let collapsed = false;
      try { collapsed = localStorage.getItem("SAD_UPLOAD_LIST_COLLAPSED") === "1"; } catch {}
      apply(collapsed);

      toggleEl.addEventListener("click", () => {
        collapsed = !collapsed;
        apply(collapsed);
      });
    }

    // ✅ Clear All click (wiring-only) — NO double-clear
    if (clearEl && !clearEl.dataset.boundClick) {
      clearEl.dataset.boundClick = "1";
      clearEl.addEventListener("click", async () => {
        // Prefer Layer M wrapper if present
        if (typeof window.M_onClearAllClick === "function") {
          try {
            await Promise.resolve(window.M_onClearAllClick());
            // ensure UI refresh even if Layer M only updates count
            if (typeof window.M_renderSchedulesList === "function") {
              try { window.M_renderSchedulesList(); } catch {}
            }
            showStatus("idle", "Cleared.", "All saved schedules removed.");
          } catch (e) {
            console.error("M_onClearAllClick failed:", e);
            showStatus("idle", "Clear All failed.", e?.message || String(e));
          }
          return;
        }

        // Fallback: core clear + rerender
        if (typeof window.clearAllSchedules !== "function") {
          showStatus("idle", "Clear All failed.", "Missing clearAllSchedules() (or M_onClearAllClick).");
          return;
        }

        try {
          showStatus("working", "Clearing…", "Removing all saved schedules");
          await Promise.resolve(window.clearAllSchedules());

          if (typeof window.M_renderSchedulesList === "function") {
            await Promise.resolve(window.M_renderSchedulesList());
          }

          showStatus("idle", "Cleared.", "All saved schedules removed.");
        } catch (e) {
          console.error("clearAllSchedules failed:", e);
          showStatus("idle", "Clear All failed.", e?.message || String(e));
        }
      });
    }

    // ✅ Start time dropdown MUST include 6:00 AM (upload page)
    if (startEl && typeof window.populateTimes === "function") {
      const needPopulate = (!startEl.options || startEl.options.length === 0);
      if (needPopulate) {
        window.populateTimes(startEl, { startMin: 6 * 60, endMin: 22 * 60, stepMin: 30 });
        startEl.value = "6:00 AM";
      }
    }

    // ✅ File input handler (deduped by rebindOnce on file input)
    fileEl.addEventListener("change", async () => {
      const file = fileEl.files && fileEl.files[0];
      if (!file) return;

      try {
        await runPhase1FromFile(file);
      } catch (e) {
        console.error("Upload Phase 1 failed:", e);
        showStatus("idle", "Processing failed.", e?.message || String(e));
      }
    });

    // ✅ Confirm button (dedupe via dataset flag; NO cloning)
    if (confirmEl && !confirmEl.dataset.boundClick) {
      confirmEl.dataset.boundClick = "1";
      confirmEl.addEventListener("click", () => {
        if (!__PHASE1__) return;
        runPhase2Finalize();
      });
    }

    // ✅ Start time change (dedupe via dataset flag; NO cloning)
    if (startEl && !startEl.dataset.boundChange) {
      startEl.dataset.boundChange = "1";
      startEl.addEventListener("change", () => {
        if (!__PHASE1__) return;
        runPhase2Finalize();
      });
    }

    // ✅ Sidebar actions: Preview / Delete — robust delegation (dedupe once on document)
    if (!document.body.dataset.boundSidebarDelegation) {
      document.body.dataset.boundSidebarDelegation = "1";

      document.addEventListener("click", async (e) => {
        const btn = e.target?.closest?.("#schedulesList button[data-action]");
        if (!btn) return;

        const action = btn.getAttribute("data-action");
        const id = btn.getAttribute("data-id");
        if (!action || !id) return;

        if (action === "preview") {
          if (typeof window.M_onPreviewClick === "function") {
            try { await window.M_onPreviewClick(id); }
            catch (err) {
              console.error("M_onPreviewClick failed:", err);
              showStatus("idle", "Preview failed.", err?.message || String(err));
            }
            return;
          }

          if (typeof window.SAD_getPreviewBlob === "function" && modal0) {
            try {
              const r = await window.SAD_getPreviewBlob(id);

              // Normalize: allow Blob OR {ok, blob} OR direct url string
              let blob = null;
              let directUrl = null;

              if (r instanceof Blob) {
                blob = r;
              } else if (r && typeof r === "object") {
                if (r.blob instanceof Blob) blob = r.blob;
                if (typeof r.url === "string") directUrl = r.url;
              } else if (typeof r === "string") {
                directUrl = r;
              }

              if (!blob && !directUrl) {
                console.log("DEBUG preview return:", r);

                // Quiet fallback for legacy schedules (saved before previews were stored)
                showStatus(
                  "idle",
                  "No saved preview for this schedule.",
                  "This is normal for older saves — re-add the schedule to generate a stored preview."
                );
                return;
              }

              const img = document.getElementById("previewImg");
              if (!img) {
                showStatus("idle", "Preview unavailable.", "Missing #previewImg in DOM.");
                return;
              }
              const title = document.getElementById("previewTitle");

              // Clean old objectURL if we created one last time
              if (img && img.dataset.objectUrl === "1" && img.src) {
                try { URL.revokeObjectURL(img.src); } catch {}
                img.dataset.objectUrl = "0";
              }

              if (img) {
                if (directUrl) {
                  img.src = directUrl;
                  img.dataset.objectUrl = "0";
                } else {
                  const url = URL.createObjectURL(blob);
                  img.src = url;
                  img.dataset.objectUrl = "1";
                }
              }

              if (title) title.textContent = "Preview";

              modal0.style.display = "flex";
              document.body.classList.add("modal-open");
            } catch (err) {
              console.error("Preview failed:", err);
              showStatus("idle", "Preview failed.", err?.message || String(err));
            }
          }
        }

        if (action === "delete") {
          if (typeof window.M_onDeleteScheduleClick === "function") {
            try { await window.M_onDeleteScheduleClick(id); }
            catch (err) {
              console.error("M_onDeleteScheduleClick failed:", err);
              showStatus("idle", "Delete failed.", err?.message || String(err));
            }
            return;
          }

          const del = window.deleteSchedule || window.deleteScheduleById;
          if (typeof del !== "function") {
            showStatus("idle", "Delete failed.", "Missing deleteSchedule()/deleteScheduleById() (or M_onDeleteScheduleClick).");
            return;
          }

          try {
            const r = del(id);
            const rr = (r && typeof r.then === "function") ? await r : r;

            if (rr && rr.ok === false) {
              showStatus("idle", "Delete failed.", rr.reason || "unknown");
              return;
            }

            if (typeof window.M_renderSchedulesList === "function") {
              try { window.M_renderSchedulesList(); } catch {}
            }
            showStatus("idle", "Deleted.", "");
          } catch (err) {
            console.error("Delete failed:", err);
            showStatus("idle", "Delete failed.", err?.message || String(err));
          }
          return;
        }
      }, { capture: true });
    }

    // ✅ Modal close (dedupe via dataset flag; NO cloning)
    if (closeEl && modal0 && !closeEl.dataset.boundClick) {
      closeEl.dataset.boundClick = "1";
      closeEl.addEventListener("click", () => {
        modal0.style.display = "none";
        document.body.classList.remove("modal-open");

        const img = document.getElementById("previewImg");
        if (img && img.src) {
          try { URL.revokeObjectURL(img.src); } catch {}
          img.src = "";
        }
      });
    }

    // ✅ Initial UI sync on load (wiring-only)
    if (typeof window.M_renderSchedulesList === "function") {
      try { window.M_renderSchedulesList(); } catch (e) {
        console.warn("Initial render list failed:", e);
      }
    }

    if (typeof window.M_onSessionGateChanged === "function") {
      try { window.M_onSessionGateChanged(); } catch (e) {
        console.warn("Initial gate sync failed:", e);
      }
    }
  }
  // init after DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
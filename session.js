/*************************
 * SESSION.JS — page DOM refs, page detection, session state
 * Depends on: nothing
 * Loaded on: every page (index/upload/query)
 *************************/

/*************************
 * LAYER A — DOM REFERENCES (+ HARD GUARD)
 *
 * Contract:
 * - Never throws if an element is missing
 * - Warns missing IDs once (so console doesn’t spam)
 * - Defines all DOM refs used by later layers
 *
 * IMPORTANT:
 * - app.js is shared across pages (upload + query)
 * - Only warn for upload-only IDs when on upload.html
 *************************/
const __MISSING_DOM__ = new Set();

// Page detection (robust: pathname + DOM hints)
const __PATH__ = (location?.pathname || "").toLowerCase();
const IS_UPLOAD_PAGE =
  __PATH__.endsWith("/upload.html") ||
  __PATH__.endsWith("upload.html") ||
  !!document.getElementById("imageInput") ||
  !!document.getElementById("canvas");

const IS_QUERY_PAGE =
  __PATH__.endsWith("/query.html") ||
  __PATH__.endsWith("query.html") ||
  !!document.getElementById("queryButton") ||
  !!document.getElementById("queryDay");

function $(id, opts = {}) {
  const { warn = true } = opts;
  const el = document.getElementById(id);

  if (!el && warn && !__MISSING_DOM__.has(id)) {
    __MISSING_DOM__.add(id);
    console.warn(`DOM missing #${id}`);
  }
  return el;
}

// ---- Upload-page DOM (warn only on upload page) ----
const personNameInput    = $("personName",        { warn: IS_UPLOAD_PAGE });
const addScheduleButton  = $("addScheduleButton", { warn: IS_UPLOAD_PAGE });
const imageInput         = $("imageInput",        { warn: IS_UPLOAD_PAGE });
const startTimeSelect    = $("startTime",         { warn: IS_UPLOAD_PAGE });
const clearAllButton     = $("clearAllButton",    { warn: IS_UPLOAD_PAGE });

const canvas = $("canvas", { warn: IS_UPLOAD_PAGE });
const ctx = canvas ? canvas.getContext("2d") : null;

// ---- Query-page DOM (warn only on query page) ----
const queryDay          = $("queryDay",          { warn: IS_QUERY_PAGE });
const queryStart        = $("queryStart",        { warn: IS_QUERY_PAGE });
const queryEnd          = $("queryEnd",          { warn: IS_QUERY_PAGE });
const resultsContainer  = $("resultsContainer",  { warn: IS_QUERY_PAGE });

let PIPELINE_OK = false;

/*************************
 * Hard guard:
 * - Upload page needs imageInput/canvas/ctx for compute
 * - Query page does NOT, so never treat missing upload DOM as a problem there
 *************************/
if (IS_UPLOAD_PAGE) {
  if (!imageInput || !canvas || !ctx) {
    console.warn("STACK A0: DOM skeleton mode (missing required imageInput/canvas/ctx)", {
      hasImageInput: !!imageInput,
      hasCanvas: !!canvas,
      hasCtx: !!ctx
    });
  } else {
    console.log("STACK A0: DOM ready", { hasCanvas: true, hasCtx: true });

    // PIPELINE_OK: single global gate for upload-time precompute
    PIPELINE_OK = true;
    window.__HAS_CORE_CANVAS__ = true;
    console.log("STACK A0+: PIPELINE_OK", { PIPELINE_OK });
  }
} else {
  // Non-upload pages (query/home): stay silent and do NOT advertise canvas availability
  PIPELINE_OK = false;
  window.__HAS_CORE_CANVAS__ = false;
}

/*************************
 * SESSION CORE — SINGLE SOURCE OF TRUTH
 * Layer M MUST rely only on window.__SAD_SESSION__.ready
 *************************/

function resetSession(reason = "reset") {
  window.__SAD_SESSION__ = {
    ok: false,
    ready: false,
    reason: reason || "reset",

    personName: "",
    fileName: "",
    thumb: null,
    nav: null,     // snapshotNavState output (lightweight)
    avail: null,   // precomputed availability (Mon–Fri slots)
    meta: {
      ts: Date.now()
    }
  };

  console.log("SESSION RESET", { reason });
}

/*************************
 * LIVE IMAGE REGISTRY (IN-MEMORY ONLY)
 * - scheduleId -> objectURL (crisp JPG for this session)
 * - NOT persisted
 *************************/
window.__SAD_LIVE_SRC__ = window.__SAD_LIVE_SRC__ || Object.create(null);

window.SAD_registerLiveSrc = function (scheduleId, src) {
  if (!scheduleId || !src) return;
  window.__SAD_LIVE_SRC__[String(scheduleId)] = String(src);
};

window.SAD_getLiveSrc = function (scheduleId) {
  if (!scheduleId) return null;
  return window.__SAD_LIVE_SRC__[String(scheduleId)] || null;
};

/*************************
 * snapshotNavState() — Phase 1 NAV collector (NO compute)
 *
 * Contract:
 * - Does NOT compute nav
 * - Does NOT touch UI
 * - Does NOT publish READY
 * - Only returns the nav object your upload-time pipeline already produced
 *************************/
(function attachSnapshotNavState() {
  function hasNavShape(nav) {
    return !!nav && typeof nav === "object";
  }

  function missingNavKeys(nav) {
    const missing = [];
    if (!nav) return ["nav"];
    if (!nav.dayRegions) missing.push("dayRegions");
    if (!nav.slotBands) missing.push("slotBands");
    if (!nav.ticksForMap) missing.push("ticksForMap");
    if (!nav.bgWhite && !nav.bg) missing.push("bg/bgWhite");
    return missing;
  }

  function pickNavCandidate() {
    // Prefer canonical session object first
    const sess = window.__SAD_SESSION__ || null;
    if (sess?.nav) return sess.nav;
    if (sess?.navCore) return sess.navCore;

    // Common global “last” holders (upload-time freeze outputs)
    if (window.LAST_NAV) return window.LAST_NAV;
    if (window.__LAST_NAV__) return window.__LAST_NAV__;

    // If you have any legacy frozen holders, include them read-only here.
    // (This does NOT violate single-writer; it just allows snapshot to find it.)
    if (window.__FROZEN_NAV__) return window.__FROZEN_NAV__;
    if (window.NAV_FROZEN) return window.NAV_FROZEN;

    return null;
  }

  function snapshotNavState() {
    const nav = pickNavCandidate();
    const miss = missingNavKeys(nav);

    if (!nav) {
      return {
        ok: false,
        reason:
          "No nav candidate found (nav was never produced). " +
          "Expected some upload-time layer to create a nav object with dayRegions, slotBands, ticksForMap, and bg/bgWhite."
      };
    }

    if (miss.length) {
      return {
        ok: false,
        reason: `Nav candidate exists but is missing: ${miss.join(", ")}`
      };
    }

    // Return a shallow copy so callers can’t mutate the frozen nav by accident.
    // (No deep clone—keeps it lightweight/surgical.)
    return { ok: true, nav: { ...nav } };
  }

  window.snapshotNavState = snapshotNavState;
})();

// Call once on boot if not present
if (!window.__SAD_SESSION__) resetSession("boot");

function publishSession({ personName, fileName, thumb, nav, avail, meta }) {
  const missing = [];
  if (!nav) missing.push("nav");
  if (!avail) missing.push("avail");

  if (nav) {
    if (!nav.dayRegions) missing.push("dayRegions");
    if (!nav.slotBands) missing.push("slotBands");
    if (!nav.ticksForMap) missing.push("ticksForMap");
    if (!nav.bgWhite && !nav.bg) missing.push("bg/bgWhite");
  }

  const ok = missing.length === 0;

  const now = Date.now();
  const metaIn = (meta && typeof meta === "object") ? meta : {};

  const session = {
    ok,
    ready: ok,
    reason: ok ? "" : `missing: ${missing.join(", ")}`,

    personName: personName || "",
    fileName: fileName || "",

    nav: ok ? nav : null,
    avail: ok ? avail : null,
    thumb: thumb || null,

    // ✅ Always ensure ts exists (preserve caller meta, but enforce ts)
    meta: {
      ...metaIn,
      ts: typeof metaIn.ts === "number" ? metaIn.ts : now
    }
  };

  window.__SAD_SESSION__ = session;

  console.log("STACK SESSION: PUBLISH", {
    ok: session.ok,
    missing: ok? [] : missing,
    hasNav: !!session.nav,
    hasAvail: !!session.avail,
    hasThumb: !!session.thumb,
    ts: session.meta?.ts
  });

  return session;
}

/*************************
 * LAYER B — DATA + SETTINGS (AUTHORITATIVE)
 *
 * Rules:
 * - Pure constants + in-memory session containers only
 * - NO storage writes here
 * - NO UI logic here
 * - Keep names stable: later layers depend on these symbols
 *************************/

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TIME_STEP_MIN = 30;

// In-memory list for rendering only (storage is Layer B+)
const uploadedSchedules = [];

// Pixel thresholds (navigation + diagnostics)
const NEAR_WHITE_THRESH = 240;

// Default fallback only — real value is picked per-image in Layer E3
const DARK_LUMA_THRESH = 215;

// Busy detection (legacy / secondary)
const NONWHITE_BUSY_SLICE = 0.095;

// Friday background calibration defaults
const CAL_SAMPLES_TRY = 6;
const CAL_PICK_TOP = 3;
const BG_TOL_BASE = 34;
const BG_TOL_MAX = 60;

// Probe placement (semantics)
const PROBE_POS_L = 0.35;
const PROBE_POS_R = 0.65;

// Debug toggles (read-only unless a debug UI flips them)
let DEBUG_DRAW = false;

// Debug target is optional; MUST be safe if name/day/time don’t exist
const DEBUG_TARGET = { name: "Luis", day: "Wednesday", time: "3:00 PM" };

console.log("STACK B0: DATA+SETTINGS loaded", {
  WEEKDAYS,
  TIME_STEP_MIN,
  hasCoreCanvas: !!window.__HAS_CORE_CANVAS__
});

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

/*************************
 * ✅ Layer B+ — localStorage backend (+ schema sanitize)  [UPDATED]
 *
 * GOAL:
 * - One authoritative record shape in storage
 * - Aggressive sanitize so UI + query never see “half records”
 * - Backward-compatible migration for older saves
 *
 * STORAGE SHAPE (one record):
 *   {
 *     id: string,
 *     person: string,
 *     savedAtISO: string,
 *     nav: { anchorStartTime, ticksForMap, slotBands, dayRegions, bgWhite, preMeta? } | null,
 *     avail: { version, anchorStartTime, slots, days? } | null,
 *     thumb: { mime, w, h, dataURL } | null,
 *     flags: {
  navReady: boolean,
  availReady: boolean,
  queryable: boolean,
  hasThumb: boolean
}

 *
 * NOTE:
 * - thumb is UI-only. nav/avail are the “frozen computation” outputs.
 * - If nav/avail missing → record stays in list but becomes queryable=false.
 *************************/

const LS_KEY_SCHEDULES = "SAD_SCHEDULES_V1";
const MAX_SCHEDULES_SOFT = 60; // we’ll still show; you can clamp later if you want
const MAX_THUMB_DATAURL_CHARS = 350_000; // ~0.35 MB string (safe-ish); tune later

function safeJSONParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function safeJSONStringify(obj, fallbackStr = "[]") {
  try { return JSON.stringify(obj); } catch { return fallbackStr; }
}

function nowISO() {
  return new Date().toISOString();
}

function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

function clampInt(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function makeId() {
  // stable-enough uniqueness without crypto dependency
  const r = Math.random().toString(16).slice(2);
  return `sch_${Date.now()}_${r}`;
}

function pickPersonName(x) {
  if (!isNonEmptyString(x)) return "Unnamed";
  return x.trim().slice(0, 60);
}

/*** NAV + AVAIL validators (tightened) ***/
/*** THUMB normalizer (UI-only, SAFE) ***/
function normalizeThumb(raw) {
  if (!raw) return null;

  // Already normalized
  if (
    raw &&
    typeof raw === "object" &&
    isNonEmptyString(raw.mime) &&
    Number.isFinite(raw.w) &&
    Number.isFinite(raw.h) &&
    isNonEmptyString(raw.dataURL)
  ) {
    return raw;
  }

  // dataURL string (legacy)
  if (typeof raw === "string" && raw.startsWith("data:image")) {
    if (raw.length > MAX_THUMB_DATAURL_CHARS) return null;
    return {
      mime: "image/jpeg",
      w: 0,
      h: 0,
      dataURL: raw
    };
  }

  return null;
}

function minutesToTimeStr(totalMinutes) {
  if (!Number.isFinite(totalMinutes)) return "";
  totalMinutes = Math.max(0, Math.floor(totalMinutes));

  let hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;

  const ampm = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;

  return `${displayHour}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/*************************
 * CORE EXPORT — populateTimes
 * Used by upload + query pages
 *************************/
function populateTimes(selectEl, opts = {}) {
  if (!selectEl) return;

  const {
    startMin = 6 * 60,   // 8:00 AM
    endMin   = 18 * 60,  // 6:00 PM
    stepMin  = 30
  } = opts;

  selectEl.innerHTML = "";

  for (let m = startMin; m <= endMin; m += stepMin) {
    const label = minutesToTimeStr(m);
    const opt = document.createElement("option");
    opt.value = label;
    opt.textContent = label;
    selectEl.appendChild(opt);
  }
}

function timeStrToMinutes(str) {
  const s = String(str || "").trim();
  // expects like "9:00 AM", "12:30 PM"
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return NaN;

  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();

  if (hh < 1 || hh > 12) return NaN;
  if (mm < 0 || mm > 59) return NaN;

  // convert to 24h
  if (ap === "AM") {
    if (hh === 12) hh = 0;
  } else { // PM
    if (hh !== 12) hh += 12;
  }

  return hh * 60 + mm;
}

window.timeStrToMinutes = timeStrToMinutes;

// ✅ export unconditionally
window.populateTimes = populateTimes;

/*************************
 * ✅ Step 2 — Full-res preview storage in IndexedDB (Blob), keyed by schedule id
 *
 * Drop this into app.js (Layer B+ area is fine).
 * No recompute. No base64 full images in localStorage.
 *
 * Public API:
 *   window.SAD_putPreviewBlob(id, blob)
 *   window.SAD_getPreviewBlob(id)
 *   window.SAD_deletePreviewBlob(id)
 *   window.SAD_clearPreviewBlobs()
 *   window.SAD_buildPreviewBlobFromCanvas(canvas, { mime, quality })
 *   window.SAD_getPreviewObjectURL(id)  // returns { ok, url, revoke() }
 *************************/

const SAD_IDB_NAME = "SAD_DB_V1";
const SAD_IDB_STORE = "previews"; // key = schedule id (string)

function SAD_openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAD_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAD_IDB_STORE)) {
        db.createObjectStore(SAD_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function SAD_putPreviewBlob(id, blob) {
  if (!id || !blob) return { ok: false, reason: "missing id/blob" };
  const db = await SAD_openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SAD_IDB_STORE, "readwrite");
      const store = tx.objectStore(SAD_IDB_STORE);
      const req = store.put(blob, id);
      req.onsuccess = () => resolve({ ok: true });
      req.onerror = () => reject(req.error || new Error("put failed"));
    });
  } finally {
    try { db.close(); } catch {}
  }
}

async function SAD_getPreviewBlob(id) {
  if (!id) return { ok: false, reason: "missing id" };
  const db = await SAD_openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SAD_IDB_STORE, "readonly");
      const store = tx.objectStore(SAD_IDB_STORE);
      const req = store.get(id);
      req.onsuccess = () => resolve({ ok: true, blob: req.result || null });
      req.onerror = () => reject(req.error || new Error("get failed"));
    });
  } finally {
    try { db.close(); } catch {}
  }
}

async function SAD_deletePreviewBlob(id) {
  if (!id) return { ok: false, reason: "missing id" };
  const db = await SAD_openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SAD_IDB_STORE, "readwrite");
      const store = tx.objectStore(SAD_IDB_STORE);
      const req = store.delete(id);
      req.onsuccess = () => resolve({ ok: true });
      req.onerror = () => reject(req.error || new Error("delete failed"));
    });
  } finally {
    try { db.close(); } catch {}
  }
}

async function SAD_clearPreviewBlobs() {
  const db = await SAD_openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SAD_IDB_STORE, "readwrite");
      const store = tx.objectStore(SAD_IDB_STORE);
      const req = store.clear();
      req.onsuccess = () => resolve({ ok: true });
      req.onerror = () => reject(req.error || new Error("clear failed"));
    });
  } finally {
    try { db.close(); } catch {}
  }
}

// Full-res modal preview Blob from the *current canvas* (no recompute).
function SAD_buildPreviewBlobFromCanvas(canvasEl, opts = {}) {
  const canvas = canvasEl || document.getElementById("canvas");
  if (!canvas || typeof canvas.toBlob !== "function") {
    return Promise.resolve({ ok: false, reason: "canvas.toBlob missing" });
  }

  const mime = opts.mime || "image/jpeg";
  const quality = Number.isFinite(opts.quality) ? opts.quality : 0.88; // sane default

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve({ ok: false, reason: "toBlob returned null" });
      resolve({ ok: true, blob });
    }, mime, quality);
  });
}

// Convenience: objectURL wrapper + revoke
async function SAD_getPreviewObjectURL(id) {
  const r = await window.SAD_getPreviewBlob(id);
  const blob = r?.blob || null;

  if (!(blob instanceof Blob)) {
    console.log("DEBUG preview get returned:", r);
    throw new Error("No preview Blob found for id=" + id);
  }

  const url = URL.createObjectURL(blob);
  return {
    ok: true,
    url,
    revoke: () => { try { URL.revokeObjectURL(url); } catch {} }
  };
}

window.SAD_putPreviewBlob = SAD_putPreviewBlob;
window.SAD_getPreviewBlob = SAD_getPreviewBlob;
window.SAD_deletePreviewBlob = SAD_deletePreviewBlob;
window.SAD_clearPreviewBlobs = SAD_clearPreviewBlobs;
window.SAD_buildPreviewBlobFromCanvas = SAD_buildPreviewBlobFromCanvas;
window.SAD_getPreviewObjectURL = SAD_getPreviewObjectURL;

function _boolAt(arr, i) {
  return Array.isArray(arr) ? !!arr[i] : false;
}

// Option A: FREE = available AND NOT work
function _isFreeSlot(daysArr, workArr, i) {
  return _boolAt(daysArr, i) && !_boolAt(workArr, i);
}

// WORK = workDays
function _isWorkSlot(workArr, i) {
  return _boolAt(workArr, i);
}

/*************************
 * CORE EXPORT — queryAllSavedSchedulesDayRange
 * Snapshot-only, storage-only query
 *************************/
function queryAllSavedSchedulesDayRange(day, startStr, endStr) {
  try {
    const startMin = timeStrToMinutes(startStr);
    const endMin   = timeStrToMinutes(endStr);

    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || startMin >= endMin) {
      return { ok: false, reason: "Invalid time range" };
    }

    const saved = (typeof loadSchedulesList === "function")
      ? loadSchedulesList()
      : (typeof window.loadSchedulesList === "function" ? window.loadSchedulesList() : []);

    const available = [];
    const skipped = [];

    // Build merged ranges from a boolean mask over slot indices [i0, i1)
    function buildRangesFromMask(maskArr, i0, i1, anchorMin, step, clampStartMin, clampEndMin) {
      const ranges = [];
      let runStartIdx = null;

      for (let i = i0; i < i1; i++) {
        const on = maskArr[i] === true;

        if (on) {
          if (runStartIdx === null) runStartIdx = i;
        } else {
          if (runStartIdx !== null) {
            const runStartMin = Math.max(clampStartMin, anchorMin + runStartIdx * step);
            const runEndMin   = Math.min(clampEndMin,   anchorMin + i * step);
            if (runEndMin > runStartMin) {
              ranges.push({
                start: minutesToTimeStr(runStartMin),
                end:   minutesToTimeStr(runEndMin)
              });
            }
            runStartIdx = null;
          }
        }
      }

      // Close trailing run
      if (runStartIdx !== null) {
        const runStartMin = Math.max(clampStartMin, anchorMin + runStartIdx * step);
        const runEndMin   = clampEndMin;
        if (runEndMin > runStartMin) {
          ranges.push({
            start: minutesToTimeStr(runStartMin),
            end:   minutesToTimeStr(runEndMin)
          });
        }
      }

      return ranges;
    }

    for (const rec of (Array.isArray(saved) ? saved : [])) {
      const person = (rec?.person || rec?.personName || rec?.name || "(unnamed)").toString();

      const avail = rec?.avail;
      const nav   = rec?.nav;

      const dayArr = avail?.days?.[day];

      // ✅ accept either schema: avail.slots OR avail.meta.slots
      const slotsRaw =
        (avail && Number.isFinite(Number(avail.slots))) ? avail.slots :
        (avail?.meta && Number.isFinite(Number(avail.meta.slots))) ? avail.meta.slots :
        null;

      const slots = Number(slotsRaw);

      // Optional last-resort: infer from the day array if present
      const slotsFinal = (Number.isFinite(slots) && Number.isInteger(slots) && slots > 0)
        ? slots
        : (Array.isArray(dayArr) ? dayArr.length : NaN);

      if (!Array.isArray(dayArr) || !Number.isFinite(slotsFinal) || dayArr.length !== slotsFinal) {
        skipped.push({ person, reason: "No availability grid for this day" });
        continue;
      }

      // Anchor: prefer avail.anchorStartTime, else nav.anchorStartTime, else default
      const anchor = (avail?.anchorStartTime || nav?.anchorStartTime || "8:00 AM").toString();
      const anchorMin = timeStrToMinutes(anchor);
      if (!Number.isFinite(anchorMin)) {
        skipped.push({ person, reason: "Bad anchorStartTime" });
        continue;
      }

      const step = TIME_STEP_MIN; // 30

      // Absolute schedule coverage from anchor + slots
      const schedStart = anchorMin;
      const schedEnd   = anchorMin + slotsFinal * step;

      // Overlap of query window with schedule coverage
      const clampStart = Math.max(startMin, schedStart);
      const clampEnd   = Math.min(endMin,   schedEnd);

      if (clampEnd <= clampStart) {
        skipped.push({
          person,
          reason: `Query window outside schedule range (${minutesToTimeStr(schedStart)}–${minutesToTimeStr(schedEnd)})`
        });
        continue;
      }

      // Convert CLAMPED window to slot indices relative to anchor
      const i0 = Math.max(0, Math.floor((clampStart - anchorMin) / step));
      const i1 = Math.min(slotsFinal, Math.ceil((clampEnd - anchorMin) / step));

      const workArr = avail?.workDays?.[day];

      // -------------------------
      // FREE ranges (FIXED: exclude work slots)
      // FREE = available AND NOT work
      // -------------------------
      let freeMask = dayArr;

      if (Array.isArray(workArr) && workArr.length === slotsFinal) {
        // build a derived mask where purple/work slots are forced OFF for "free"
        freeMask = new Array(slotsFinal);
        for (let i = 0; i < slotsFinal; i++) {
          freeMask[i] = (dayArr[i] === true) && (workArr[i] !== true);
        }
      }

      const freeRanges = buildRangesFromMask(
        freeMask,
        i0, i1,
        anchorMin, step,
        startMin, endMin
      );

      // -------------------------
      // WORK ranges (new, optional)
      // Expectation: avail.workDays[day] is boolean[] same length as slots
      // true => "work busy" in that slot
      // -------------------------
      let workRanges = [];
      
      if (Array.isArray(workArr) && workArr.length === slotsFinal) {
        workRanges = buildRangesFromMask(
          workArr,
          i0, i1,
          anchorMin, step,
          startMin, endMin
        );
      }
      // ✅ list if FREE or PLACEMENT exists
      if (freeRanges.length || workRanges.length) {
        available.push({ person, freeRanges, workRanges });
      } else {
        skipped.push({ person, reason: "No free or placement time in range" });
      }
    }
    return { ok: true, day, startStr, endStr, available, skipped };
    } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

window.queryAllSavedSchedulesDayRange = queryAllSavedSchedulesDayRange;

/*************************
 * ✅ Patch: addScheduleFromCurrentSession() stores full preview Blob in IndexedDB
 * NOTE: this becomes async (caller must await).
 *
 * Drop-in replacement for your existing function.
 *************************/
async function addScheduleFromCurrentSession() {
  const S = window.__SAD_SESSION__;
  if (!S?.ready) return { ok: false, reason: "session not ready" };
  if (!S?.avail) return { ok: false, reason: "session missing avail" };
  if (!S?.nav) return { ok: false, reason: "session missing nav" };

  const id = makeId();

  // person name (prefer session, fallback input)
  const person =
    (S.personName || "").trim() ||
    (document.getElementById("personName")?.value || "").trim() ||
    "Unnamed";

  // 1) Store full-res preview blob in IndexedDB
  const liveSrc = S?.meta?.liveSrc || null;

  try {
    if (liveSrc) {
      const resp = await fetch(liveSrc);
      const blob = await resp.blob();
      await window.SAD_putPreviewBlob(id, blob);
    } else {
      const br = await window.SAD_buildPreviewBlobFromCanvas(
        document.getElementById("canvas"),
        { mime: "image/jpeg", quality: 0.88 }
      );
      if (br?.ok && br.blob) await window.SAD_putPreviewBlob(id, br.blob);
    }
  } catch (e) {
    console.warn("Preview blob save failed (non-fatal):", e);
  }

  const sess = window.__SAD_SESSION__ || {};
  const navToStore   = sess.nav   || null;
  const availToStore = sess.avail || null;
  const thumbToStore = sess.thumb || null;

  // Hard guard: don’t save junk
  if (!navToStore) return { ok:false, reason:"No nav in __SAD_SESSION__ (not ready)" };
  if (!availToStore) return { ok:false, reason:"No avail in __SAD_SESSION__ (not finalized)" };

  // Ensure workDays exists (even if empty) so query code can rely on it
  if (!availToStore.workDays || typeof availToStore.workDays !== "object") {
    availToStore.workDays = { Monday:[], Tuesday:[], Wednesday:[], Thursday:[], Friday:[] };
  }

  // IMPORTANT: store the FULL avail object (includes anchorStartTime + workDays)
  const record = {
    id,
    person,
    savedAtISO: new Date().toISOString(),
    thumb: thumbToStore,
    nav: navToStore,
    avail: availToStore
  };

  // Optional: keep liveSrc in-memory only
  if (liveSrc && typeof window.SAD_registerLiveSrc === "function") {
    window.SAD_registerLiveSrc(id, liveSrc);
  }

  // 3) Persist via B+ (authoritative)
  const fn = window.upsertSchedule || window.upsertScheduleRecord;
  if (typeof fn !== "function") {
    return { ok: false, reason: "upsertSchedule() not found" };
  }

  const up = fn(record);
  if (!up?.ok) return { ok: false, reason: up?.reason || "save failed" };

  const list = (typeof window.loadSchedulesList === "function") ? window.loadSchedulesList() : [];
  return { ok: true, id, count: Array.isArray(list) ? list.length : 0, list };
}

window.addScheduleFromCurrentSession = addScheduleFromCurrentSession;

function isValidBgWhite(bg) {
  if (!bg || typeof bg !== "object") return false;

  const r = Number(bg.r), g = Number(bg.g), b = Number(bg.b);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return false;

  // tol is optional but if present must be sane
  if (bg.tol !== undefined) {
    const tol = Number(bg.tol);
    if (!Number.isFinite(tol)) return false;
    if (tol < 0 || tol > BG_TOL_MAX) return false;
  }

  return true;
}

function isValidNav(nav) {
  if (!nav || typeof nav !== "object") return false;

  // required
  if (!isNonEmptyString(nav.anchorStartTime)) return false;

  if (!Array.isArray(nav.ticksForMap) || nav.ticksForMap.length < 2) return false;
  if (!nav.ticksForMap.every(t => Number.isFinite(Number(t)))) return false;

  if (!Array.isArray(nav.slotBands) || nav.slotBands.length < 1) return false;
  // slot bands must have numeric yStart/yEnd
  for (const s of nav.slotBands) {
    if (!s || typeof s !== "object") return false;
    if (!Number.isFinite(Number(s.yStart)) || !Number.isFinite(Number(s.yEnd))) return false;
    if (Number(s.yEnd) <= Number(s.yStart)) return false;
  }

  // dayRegions must include all weekdays with numeric x0/x1
  const dr = nav.dayRegions;
  if (!dr || typeof dr !== "object") return false;
  for (const d of WEEKDAYS) {
    const r = dr[d];
    if (!r || typeof r !== "object") return false;
    if (!Number.isFinite(Number(r.x0)) || !Number.isFinite(Number(r.x1))) return false;
    if (Number(r.x1) <= Number(r.x0)) return false;
  }

  // bgWhite required for semantics + availability compute
  if (!isValidBgWhite(nav.bgWhite)) return false;

  // optional (but if present should be sane)
  if (nav.preMeta && typeof nav.preMeta === "object") {
    const w = Number(nav.preMeta.w), h = Number(nav.preMeta.h);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  }

  return true;
}

function isValidAvail(avail) {
  if (!avail || typeof avail !== "object") return false;

  const hasAnchor = isNonEmptyString(avail.anchorStartTime);

  // ✅ accept either legacy or current schema
  const slotsRaw =
    (avail.slots !== undefined ? avail.slots : undefined) ??
    (avail.meta && avail.meta.slots !== undefined ? avail.meta.slots : undefined);

  const slots = Number(slotsRaw);
  const hasSlots =
    Number.isFinite(slots) &&
    Number.isInteger(slots) &&
    slots > 0;

  // GROUP availability REQUIRES per-day boolean grids
  const days = avail.days;
  const hasDays =
    days &&
    typeof days === "object" &&
    WEEKDAYS.every(d =>
      Array.isArray(days[d]) &&
      days[d].length === slots &&
      days[d].every(v => typeof v === "boolean")
    );

  if (avail.version !== undefined && !isNonEmptyString(String(avail.version))) return false;

  return !!(hasAnchor && hasSlots && hasDays);
}

/*** Record normalizer / migrator (keeps backward compat) ***/
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = isNonEmptyString(raw.id) ? raw.id : makeId();

  // person key migration
  const person = pickPersonName(raw.person || raw.personName || raw.name);

  // timestamps migration
  const savedAtISO =
    isNonEmptyString(raw.savedAtISO) ? raw.savedAtISO :
    isNonEmptyString(raw.savedAt)    ? raw.savedAt :
    nowISO();

  // nav migration
  const nav =
    raw.nav && typeof raw.nav === "object" ? raw.nav :
    raw.navState && typeof raw.navState === "object" ? raw.navState :
    null;

  // avail migration
  const avail =
    raw.avail && typeof raw.avail === "object" ? raw.avail :
    raw.availability && typeof raw.availability === "object" ? raw.availability :
    null;

  // thumb migration
  const thumb = normalizeThumb(raw.thumb || raw.imageDataURL || raw.thumbDataURL);

  const navOK = isValidNav(nav);
  const availOK = isValidAvail(avail);

  const flags = {
    navReady: !!navOK,
    availReady: !!availOK,
    queryable: !!(navOK && availOK),
    hasThumb: !!thumb
  };

  return {
    id,
    person,
    savedAtISO,
    nav: navOK ? nav : null,
    avail: availOK ? avail : null,
    thumb: thumb || null,
    flags
  };
}

/*** Upsert / delete helpers (used by Add Schedule + UI) ***/
function upsertScheduleRecord(partial) {
  const list = loadSchedulesList();
  const p = (partial && typeof partial === "object") ? partial : {};

  // If caller provided an id that exists, MERGE first to avoid wiping fields.
  const id = isNonEmptyString(p.id) ? p.id : null;
  const existing = id ? list.find(r => r.id === id) : null;

  // Merge order: existing first, then partial overrides.
  const merged = existing ? { ...existing, ...p } : p;

  const normalized = normalizeRecord(merged);
  if (!normalized) return list;

  const idx = list.findIndex(r => r.id === normalized.id);
  if (idx >= 0) list[idx] = normalized;
  else list.unshift(normalized);

  return saveSchedulesList(list);
}

function upsertSchedule(partial) {
  try {
    const list = upsertScheduleRecord(partial); // returns sanitized list
    const id = partial?.id || null;

    return {
      ok: true,
      id,
      count: Array.isArray(list) ? list.length : 0,
      list,
      stats: {
        queryable: Array.isArray(list) ? list.filter(r => r?.flags?.queryable).length : 0,
        hasThumb: Array.isArray(list) ? list.filter(r => r?.flags?.hasThumb).length : 0
      }
    };
  } catch (e) {
    console.warn("B+ upsertSchedule failed", e);
    return { ok: false, reason: "upsertSchedule exception" };
  }
}

/*** Top-level list sanitize ***/
function sanitizeSchedulesList(list) {
  const arr = Array.isArray(list) ? list : [];

  const out = [];
  const seen = new Set();

  for (const raw of arr) {
    const rec = normalizeRecord(raw);
    if (!rec) continue;

    // De-dupe by id (keep first)
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);

    out.push(rec);
  }

  // Sort newest first (stable)
  out.sort((a, b) => String(b.savedAtISO).localeCompare(String(a.savedAtISO)));

  // Soft cap (optional). We keep newest if too many.
  if (out.length > MAX_SCHEDULES_SOFT) {
    return out.slice(0, MAX_SCHEDULES_SOFT);
  }

  return out;
}

/*** Storage API ***/
function loadSchedulesList() {
  const raw = localStorage.getItem(LS_KEY_SCHEDULES);
  const parsed = safeJSONParse(raw, []);
  const clean = sanitizeSchedulesList(parsed);

  // Write-back if we migrated / fixed anything (keeps storage consistent)
  const reparsed = safeJSONParse(raw, []);
  const changed = safeJSONStringify(reparsed, "[]") !== safeJSONStringify(clean, "[]");
  if (changed) {
    localStorage.setItem(LS_KEY_SCHEDULES, safeJSONStringify(clean, "[]"));
  }

  return clean;
}

function saveSchedulesList(list) {
  const clean = sanitizeSchedulesList(list);
  localStorage.setItem(LS_KEY_SCHEDULES, safeJSONStringify(clean, "[]"));
  return clean;
}

function deleteScheduleRecord(id) {
  if (!isNonEmptyString(id)) return loadSchedulesList();
  const list = loadSchedulesList().filter(r => r.id !== id);
  return saveSchedulesList(list);
}

// ------------------------------
// B+ public API wrappers (UI calls these)
// ------------------------------
function deleteScheduleById(id) {
  try {
    const list = deleteScheduleRecord(id);
    window.SAD_deletePreviewBlob?.(id);
    return {
      ok: true,
      count: Array.isArray(list) ? list.length : 0,
      list
    };
  } catch (e) {
    console.warn("B+ deleteScheduleById failed", e);
    return { ok: false, reason: "deleteScheduleById exception" };
  }
}

function clearAllSchedules() {
  try {
    localStorage.removeItem(LS_KEY_SCHEDULES);
    window.SAD_clearPreviewBlobs?.();

    return { ok: true, count: 0, list: [] };
  } catch (e) {
    console.warn("B+ clearAllSchedules failed", e);
    return { ok: false, reason: "clearAllSchedules exception" };
  }
}

function getScheduleStorageStats() {
  const list = loadSchedulesList();

  // localStorage thumb footprint (string chars)
  let thumbChars = 0;
  for (const r of list) {
    if (r?.thumb?.dataURL) thumbChars += r.thumb.dataURL.length;
  }

  // IndexedDB preview blob stats (optional)
  let blobCount = null;
  let blobBytes = null;
  try {
    const s = window.SAD_getPreviewBlobStats?.();
    // allow either sync or promise return
    if (s && typeof s.then === "function") {
      // keep non-async API: best-effort fire-and-forget update in console
      s.then(v => console.log("SAD blob stats:", v)).catch(() => {});
    } else if (s && typeof s === "object") {
      blobCount = Number.isFinite(s.count) ? s.count : null;
      blobBytes = Number.isFinite(s.bytes) ? s.bytes : null;
    }
  } catch {}

  return {
    count: list.length,
    queryable: list.filter(r => r.flags?.queryable).length,
    withThumb: list.filter(r => r.flags?.hasThumb).length,
    thumbChars,

    // new (optional)
    blobCount,
    blobBytes
  };
}

function resetAfterAddScheduleUI() {
  // 1) Clear basic inputs (safe)
  const pn = document.getElementById("personName");
  const ii = document.getElementById("imageInput");
  if (pn) pn.value = "";
  if (ii) ii.value = "";

  // 2) Close modal once (safe)
  if (typeof window.M_closeModal === "function") {
    window.M_closeModal();
  } else if (typeof M_closeModal === "function") {
    M_closeModal();
  }

  // 3) Clear preview canvas once (safe)
  try {
    if (typeof canvas !== "undefined" && canvas && typeof ctx !== "undefined" && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  } catch {}

  // 4) If Layer M exists, clear its cached refs (safe)
  try {
    if (typeof M !== "undefined" && M) {
      if (M.personNameInput) M.personNameInput.value = "";
      if (M.imageInput) M.imageInput.value = "";
    }
  } catch {}

  // 5) Clear upload-time globals ONLY if they exist (prevents ReferenceError)
  try {
    if (typeof LAST_PRE !== "undefined") LAST_PRE = null;
    if (typeof LAST_VTICKS !== "undefined") LAST_VTICKS = null;
    if (typeof LAST_DY !== "undefined") LAST_DY = NaN;
    if (typeof LAST_LANE !== "undefined") LAST_LANE = null;
    if (typeof LAST_GTICKS !== "undefined") LAST_GTICKS = null;
    if (typeof LAST_SLOT_BANDS !== "undefined") LAST_SLOT_BANDS = null;
    if (typeof LAST_BG !== "undefined") LAST_BG = null;
    if (typeof LAST_DAYREGIONS !== "undefined") LAST_DAYREGIONS = null;

    if (typeof window.__TIME_INDEX__ !== "undefined") window.__TIME_INDEX__ = null;
    if (typeof window.__TICK_LANE__ !== "undefined") window.__TICK_LANE__ = null;
    if (typeof window.__DIV_XS__ !== "undefined") window.__DIV_XS__ = null;
  } catch {}

  console.log("LAYER M: resetAfterAddScheduleUI");
}

window.resetAfterAddScheduleUI = resetAfterAddScheduleUI;

/*************************
 * LAYER F.5 — LANE HEALTH DEBUG (SAFE)
 *************************/
function laneHealthDebug(pre, opts = {}) {
  const {
    x0Frac = 0.015,
    x1Frac = 0.055,
    yPad = 6,
    sampleEvery = 8,
    bandH = 3,
    darkFracRow = 0.25,
  } = opts;

  if (!pre?.darkP || !Number.isFinite(pre.W)) return null;

  const w = pre.w, h = pre.h;
  const x0 = clamp(Math.floor(w * x0Frac), 0, w - 1);
  const x1 = clamp(Math.floor(w * x1Frac), x0 + 1, w);

  let rows = 0;
  let darkRows = 0;
  let bestScore = -1;
  let bestY = null;

  for (let y = yPad; y < h - yPad; y += sampleEvery) {
    const score = rectSum(pre.darkP, pre.W, x0, y, x1, y + bandH);
    const area = (x1 - x0) * bandH;
    const frac = area ? score / area : 0;

    rows++;
    if (frac >= darkFracRow) darkRows++;

    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }

  const area = (x1 - x0) * bandH;
  const bestFrac = area ? bestScore / area : 0;

  const out = {
    lane: { x0, x1, bandH, sampleEvery },
    scannedRows: rows,
    darkRows,
    darkRowPct: rows ? Math.round((darkRows / rows) * 1000) / 10 : 0,
    best: { y: bestY, score: bestScore, frac: Math.round(bestFrac * 1000) / 1000 },
    note: "If darkRowPct is huge (like >60%), dark thresholding is too permissive (background being classified as dark)."
  };

  console.log("STACK F5: lane health", out);
  return out;
}

/*************************
 * LAYER E0 — PRECOMPUTE BUILDER (MISSING PIECE)
 *
 * Purpose:
 * - Build "pre" from the CURRENT canvas pixels (image already drawn)
 * - pre provides: w,h,imgData, whiteP,darkP, W for rectSum() usage
 * - Publishes window.LAST_PRE so upload.js Phase 1 can proceed
 *
 * STRICT:
 * - Does NOT do navigation
 * - Does NOT do UI
 * - Pure pixel prep
 *************************/

// ---- safe helpers (only define if missing) ----
if (typeof clamp !== "function") {
  function clamp(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }
}

if (typeof idxOf !== "function") {
  function idxOf(x, y, w) {
    return ((y * w + x) * 4) | 0;
  }
}

// Prefix-sum rect sum: sum of mask in [x0,x1) × [y0,y1)
if (typeof rectSum !== "function") {
  function rectSum(P, W, x0, y0, x1, y1) {
    // P is (h+1)*(w+1), W is (w+1)
    const A = P[y0 * W + x0];
    const B = P[y0 * W + x1];
    const C = P[y1 * W + x0];
    const D = P[y1 * W + x1];
    return (D - B - C + A) >>> 0;
  }
}

// near-white predicate (NEAR_WHITE_THRESH already in your constants)
if (typeof isNearWhite !== "function") {
  function isNearWhite(r, g, b, thresh = NEAR_WHITE_THRESH) {
    return (r >= thresh && g >= thresh && b >= thresh);
  }
}

function buildPrefixFromMask(mask, w, h) {
  // mask: Uint8Array length w*h containing 0/1
  const W = w + 1;
  const H = h + 1;
  const P = new Uint32Array(W * H);

  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    const yMask = (y - 1) * w;
    const yP = y * W;
    const yPPrev = (y - 1) * W;

    for (let x = 1; x <= w; x++) {
      rowSum += mask[yMask + (x - 1)];
      P[yP + x] = (P[yPPrev + x] + rowSum) >>> 0;
    }
  }
  return { P, W };
}

/**
 * Build precompute from the CURRENT canvas contents.
 * Returns { ok:true, pre } or { ok:false, reason }.
 */
function buildPrecomputeFromCanvas(opts = {}) {
  if (!canvas || !ctx) return { ok: false, reason: "missing canvas/ctx" };
  const w = canvas.width | 0;
  const h = canvas.height | 0;
  if (!w || !h) return { ok: false, reason: "canvas has no pixels" };

  const nearWhiteThresh = Number.isFinite(opts.nearWhiteThresh) ? opts.nearWhiteThresh : NEAR_WHITE_THRESH;
  const darkLumaThresh  = Number.isFinite(opts.darkLumaThresh)  ? opts.darkLumaThresh  : DARK_LUMA_THRESH;

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch (e) {
    return { ok: false, reason: "getImageData failed (tainted canvas?)" };
  }

  const imgData = imageData.data;

  // Build masks
  const whiteMask = new Uint8Array(w * h);
  const darkMask  = new Uint8Array(w * h);

  // Luma: standard-ish weights
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = idxOf(x, y, w);
      const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];

      const isW = (r >= nearWhiteThresh && g >= nearWhiteThresh && b >= nearWhiteThresh);
      whiteMask[row + x] = isW ? 1 : 0;

      // darkness by luma
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b);
      darkMask[row + x] = (luma <= darkLumaThresh) ? 1 : 0;
    }
  }

  const { P: whiteP, W: Wp } = buildPrefixFromMask(whiteMask, w, h);
  const { P: darkP,  W: Wd } = buildPrefixFromMask(darkMask,  w, h);

  // sanity: Wp == Wd == (w+1)
  const W = Wp;

  const pre = {
    w, h,
    imgData,
    whiteP,
    darkP,
    W,
    meta: {
      nearWhiteThresh,
      darkLumaThresh,
      ts: Date.now()
    }
  };

  return { ok: true, pre };
}

/**
 * Public entrypoint for upload.js:
 * - builds pre
 * - publishes window.LAST_PRE
 */
function buildAndPublishPrecompute(opts = {}) {
  const res = buildPrecomputeFromCanvas(opts);
  if (!res.ok) {
    console.warn("STACK E0: PRECOMPUTE failed", res);
    window.LAST_PRE = null;
    window.__LAST_PRE__ = null;
    return res;
  }

  window.LAST_PRE = res.pre;
  window.__LAST_PRE__ = res.pre;

  console.log("STACK E0: PRECOMPUTE built", {
    w: res.pre.w,
    h: res.pre.h,
    W: res.pre.W,
    hasWhiteP: !!res.pre.whiteP,
    hasDarkP: !!res.pre.darkP,
    meta: res.pre.meta
  });

  return { ok: true, pre: res.pre };
}

window.buildPrecomputeFromCanvas = buildPrecomputeFromCanvas;
window.buildAndPublishPrecompute = buildAndPublishPrecompute;

/*************************
 * LAYER F — RAW TICK DETECTION (using a chosen lane)
 *************************/
function detectTimeTicksFromLeftLane(pre, opts = {}) {
  const {
    x0Frac = 0.015,
    x1Frac = 0.055,
    bandH = 3,
    darkFrac = 0.22,
    yPad = 6,
    dedupePx = 10,
    minRunPx = 2,
  } = opts;

  if (!pre?.darkP || !Number.isFinite(pre.W) || !Number.isFinite(pre.w) || !Number.isFinite(pre.h)) {
    console.warn("STACK F0: detectTimeTicksFromLeftLane missing pre requisites");
    return [];
  }

  const w = pre.w, h = pre.h;
  const x0 = clamp(Math.floor(w * x0Frac), 0, w - 1);
  const x1 = clamp(Math.floor(w * x1Frac), x0 + 1, w);

  const ticks = [];
  let inBlack = false;
  let runStart = 0;

  for (let y = yPad; y < h - yPad; y++) {
    const score = rectSum(pre.darkP, pre.W, x0, y, x1, y + bandH);
    const bandArea = (x1 - x0) * bandH;
    const isBlack = score > bandArea * darkFrac;

    if (isBlack && !inBlack) {
      inBlack = true;
      runStart = y;
    } else if (!isBlack && inBlack) {
      inBlack = false;
      const runLen = y - runStart;
      if (runLen >= minRunPx) ticks.push(Math.floor((runStart + y) / 2));
    }
  }
  if (inBlack) {
    const runLen = (h - yPad) - runStart;
    if (runLen >= minRunPx) ticks.push(Math.floor((runStart + (h - yPad)) / 2));
  }

  const out = [];
  for (const y of ticks) {
    if (!out.length || Math.abs(y - out[out.length - 1]) > dedupePx) out.push(y);
  }

  console.log("STACK F1: raw ticks detected", {
    rawCount: ticks.length,
    dedupedCount: out.length,
    lane: { x0, x1, bandH, darkFrac },
    sample: out.slice(0, 10),
  });

  return out;
}

/*************************
 * LAYER F0 — AUTO-PICK BEST TICK LANE (template-aware)
 *************************/
function pickBestTickLane(pre, opts = {}) {
  const {
    lanes = [
      { x0Frac: 0.015, x1Frac: 0.055 },
      { x0Frac: 0.030, x1Frac: 0.070 },
      { x0Frac: 0.045, x1Frac: 0.085 },
      { x0Frac: 0.060, x1Frac: 0.095 },
      { x0Frac: 0.075, x1Frac: 0.110 },
    ],
    bandH = 3,
    darkFrac = 0.22,
    yPad = 6,
    dedupePx = 10,
    minGood = 8,
  } = opts;

  if (!pre?.darkP || !Number.isFinite(pre.W)) {
    console.warn("STACK F0: pickBestTickLane missing pre requisites");
    return { x0Frac: 0.015, x1Frac: 0.055 };
  }

  let best = null;

  for (const lane of lanes) {
    const ticks = detectTimeTicksFromLeftLane(pre, {
      ...lane,
      bandH,
      darkFrac,
      yPad,
      dedupePx,
    });

    const score = ticks.length;
    if (!best || score > best.score) {
      best = { chosen: lane, score, ticksPreview: ticks.slice(0, 8) };
    }

    if (score >= minGood) {
      best = { chosen: lane, score, ticksPreview: ticks.slice(0, 8) };
      break;
    }
  }

  const out = best || { chosen: { x0Frac: 0.015, x1Frac: 0.055 }, score: 0, ticksPreview: [] };

  console.log("STACK F0: picked tick lane", {
    chosen: out.chosen,
    score: out.score,
    ticksPreview: out.ticksPreview,
    note: out.score >= minGood ? "Good: lane crosses real grid lines." : "Warning: weak lane; may be border-only."
  });

  return out.chosen;
}

/*************************
 * SUPPORT — snap to nearest raw tick within a window
 *************************/
function nearestTickWithin(rawTicks, expectedY, snapWin, startIdx = 0) {
  if (!Array.isArray(rawTicks) || rawTicks.length === 0) return null;
  if (!Number.isFinite(expectedY) || !Number.isFinite(snapWin)) return null;

  let bestY = null;
  let bestDist = Infinity;
  let bestIdx = -1;

  for (let i = Math.max(0, startIdx); i < rawTicks.length; i++) {
    const y = rawTicks[i];
    if (!Number.isFinite(y)) continue;

    const d = Math.abs(y - expectedY);
    if (d <= snapWin && d < bestDist) {
      bestDist = d;
      bestY = y;
      bestIdx = i;
    }
  }

  return bestY === null ? null : { y: bestY, idx: bestIdx, dist: bestDist };
}

/*************************
 * SUPPORT — median tick spacing (required by validateTicksFromFirst)
 *************************/
function computeMedianDy(ticks) {
  if (!Array.isArray(ticks) || ticks.length < 2) return NaN;

  const diffs = [];
  for (let i = 1; i < ticks.length; i++) {
    const d = ticks[i] - ticks[i - 1];
    if (Number.isFinite(d) && d > 0) diffs.push(d);
  }
  if (!diffs.length) return NaN;

  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return (diffs.length % 2 === 1)
    ? diffs[mid]
    : (diffs[mid - 1] + diffs[mid]) / 2;
}

// === SURGICAL PATCH: replace validateTicksFromFirst(...) in app.js ===
// Goal: stop anchoring on rawTicks[0]. Instead, derive dy from the most-consistent spacing
// and choose the earliest start that yields the longest consistent ladder.
// Handles mixed half-hour/hour lines by allowing occasional 2*dy jumps.

function validateTicksFromFirst(rawTicks, opts = {}) {
  const snapWin = Number.isFinite(opts.snapWin) ? opts.snapWin : 6;
  const minValidated = Number.isFinite(opts.minValidated) ? opts.minValidated : 10;

  const raw = Array.isArray(rawTicks) ? rawTicks.slice().filter(Number.isFinite) : [];
  raw.sort((a, b) => a - b);

  const out = {
    ok: false,
    reason: "",
    rawCount: raw.length,
    validatedCount: 0,
    ticks: [],
    dy: null,
    snapWin,
    startIndex: 0,
  };

  if (raw.length < 2) {
    out.reason = "too few raw ticks";
    return out;
  }

  // ----------------------------
  // 1) Pick dy from "trustworthy evidence":
  //    the dominant small diff cluster (ignore huge gaps / headers).
  // ----------------------------
  const diffs = [];
  for (let i = 1; i < raw.length; i++) {
    const d = raw[i] - raw[i - 1];
    // Keep reasonable grid spacings only (tunable but safe):
    if (d >= 12 && d <= 80) diffs.push(d);
  }

  if (diffs.length === 0) {
    out.reason = "no usable diffs";
    return out;
  }

  // Score candidate dy by how many diffs match dy or 2*dy (within tolerance).
  // We try candidates from observed diffs and also half-diffs (for hour-lines only cases).
  const candSet = new Set();
  for (const d of diffs) {
    candSet.add(Math.round(d));
    candSet.add(Math.round(d / 2));
  }

  const tol = Math.max(2, snapWin + 1); // slightly looser than snapWin for dy estimation
  let bestDy = null;
  let bestScore = -1;

  function scoreDy(dy) {
    if (!Number.isFinite(dy) || dy < 12 || dy > 60) return -1;
    let s = 0;
    for (const d of diffs) {
      if (Math.abs(d - dy) <= tol) s += 2;                 // strong
      else if (Math.abs(d - 2 * dy) <= 2 * tol) s += 1;    // weaker but useful
    }
    return s;
  }

  for (const c of candSet) {
    const s = scoreDy(c);
    if (s > bestScore) {
      bestScore = s;
      bestDy = c;
    }
  }

  if (!bestDy) {
    out.reason = "failed to estimate dy";
    return out;
  }

  out.dy = bestDy;

  // ----------------------------
  // 2) Given dy, find the best start index:
  //    walk expectedY down the page snapping to nearest raw tick within snapWin.
  //    Allow occasional 2*dy jump if one tick line is missing.
  // ----------------------------
  function nearestIdx(y, fromIdx) {
    // raw is sorted; linear scan is fine (rawLen small), but keep it simple & stable.
    let bestI = -1;
    let bestAbs = Infinity;
    for (let i = fromIdx; i < raw.length; i++) {
      const a = Math.abs(raw[i] - y);
      if (a < bestAbs) { bestAbs = a; bestI = i; }
      // small optimization: once raw[i] surpasses y and we're getting worse, stop
      if (raw[i] > y && a > bestAbs) break;
    }
    return { idx: bestI, dist: bestAbs };
  }

  function walkFrom(startIdx) {
    const ticks = [raw[startIdx]];
    let idxCursor = startIdx + 1;
    let y = raw[startIdx];

    // Hard cap so we never loop forever
    const maxSteps = 200;

    for (let step = 0; step < maxSteps; step++) {
      const y1 = y + bestDy;
      const n1 = nearestIdx(y1, idxCursor);

      if (n1.idx >= 0 && n1.dist <= snapWin) {
        ticks.push(raw[n1.idx]);
        y = raw[n1.idx];
        idxCursor = n1.idx + 1;
        continue;
      }

      // Allow skip: look for 2*dy (missing half-hour or faint line)
      const y2 = y + 2 * bestDy;
      const n2 = nearestIdx(y2, idxCursor);

      if (n2.idx >= 0 && n2.dist <= snapWin) {
        ticks.push(raw[n2.idx]);
        y = raw[n2.idx];
        idxCursor = n2.idx + 1;
        continue;
      }

      // No match: stop ladder
      break;
    }

    return ticks;
  }

  let bestTicks = [];
  let bestStart = 0;

  for (let s = 0; s < raw.length; s++) {
    const t = walkFrom(s);
    if (t.length > bestTicks.length) {
      bestTicks = t;
      bestStart = s;
    }
  }

  out.ticks = bestTicks;
  out.validatedCount = bestTicks.length;
  out.startIndex = bestStart;

  if (out.validatedCount >= minValidated) {
    out.ok = true;
    out.reason = "ok";
  } else {
    out.ok = false;
    out.reason = "too few validated ticks";
  }

  return out;
}

/*************************
 * REALIZATION (from Gizmo schedule + logs):
 *
 * Vertical divider structure (G2V) can remain “true” even when a y-row band test fails
 * IF the row-band is sampled outside the table interior.
 *
 * Therefore:
 * - Row-band sanity MUST use the table X-bounds (grid interior), not generic x0Frac/x1Frac spans.
 * - The only trustworthy X bounds come from day dividers / DayRegions freeze (Layer H1).
 *
 * Correct hierarchy for accepting an extended tick:
 * 1) Horizontal line peak near expectedY  -> accept
 * 2) Else (vertical divider structure OK AND row-band OK inside gridX0..gridX1) -> accept
 * 3) Else -> stop (no phantom rows)
 *************************/

/*************************
 * LAYER G2 — GLOBAL LADDER (NEW)
 *
 * Purpose:
 * - Extend the tick ladder beyond VTICKS when horizontal lines weaken/fade.
 * - We no longer trust any single visual cue. We trust table structure.
 *
 * Hard stop:
 * - Stop only when BOTH signals fail.
 *
 * Key fix:
 * - Row-band check must NOT use full-width whiteness (fails on colored blocks).
 * - Instead, sample divider-trimmed day interiors (Mon–Fri) and take median.
 *************************/

// Find best horizontal line peak near expectedY (wide spans)
function findBestHLinePeak(pre, expectedY, opts = {}) {
  const {
    snapWin = 10,
    bandH = 3,
    minFrac = 0.14,
    scanStep = 1,
    spans = [
      { x0Frac: 0.08, x1Frac: 0.98 },
      { x0Frac: 0.12, x1Frac: 0.96 },
      { x0Frac: 0.18, x1Frac: 0.92 },
    ],
  } = opts;

  if (!pre?.darkP || !Number.isFinite(pre.W)) return { ok: false, reason: "no pre" };
  const { w, h, darkP, W } = pre;

  // keep band fully inside image so area/fractions are consistent
  const yLo = clamp(Math.floor(expectedY - snapWin), 0, h - bandH);
  const yHi = clamp(Math.floor(expectedY + snapWin), 0, h - bandH);

  let best = { y: null, frac: -1, score: -1, span: null };

  for (let y = yLo; y <= yHi; y += scanStep) {
    const y0 = y;
    const y1 = y + bandH;

    for (const sp of spans) {
      const x0 = clamp(Math.floor(w * sp.x0Frac), 0, w - 1);
      const x1 = clamp(Math.floor(w * sp.x1Frac), x0 + 1, w);

      const score = rectSum(darkP, W, x0, y0, x1, y1);
      const area = (x1 - x0) * (y1 - y0);
      const frac = area ? (score / area) : 0;

      if (frac > best.frac) best = { y, frac, score, span: { ...sp, x0, x1 } };
    }
  }

  if (!Number.isFinite(best.y) || best.frac < minFrac) {
    return { ok: false, reason: "no strong line peak", best };
  }

  return { ok: true, y: best.y, peak: best };
}
// Vertical day-divider evidence at y using NON-WHITE structure (robust to anti-alias + conservative darkThresh)
// We also do a local ±x search so dividerXFracs can be approximate.
// Vertical day-divider evidence at y using NON-WHITE structure (robust to anti-alias + conservative darkThresh)
// We also do a local ±x search so dividerXs can be approximate.
function hasVerticalDayStructureAtY(pre, y, opts = {}) {
  const {
    dividerXs = null,
    bandH = 22,
    stripeW = 9,
    searchDx = 14,
    searchStep = 2,
    minNonWhiteFrac = 0.22,
    minDarkFrac = 0.06,
    requireCount = 2,
  } = opts;

  if (!pre?.whiteP || !Number.isFinite(pre.W)) return { ok: false, reason: "no pre" };

  const { w, h, whiteP, darkP, W } = pre;

  const y0 = clamp(Math.floor(y - bandH / 2), 0, h - 1);
  const y1 = clamp(y0 + bandH, y0 + 1, h);

  let hits = 0;
  const per = [];

  const xs = Array.isArray(dividerXs) ? dividerXs : [];
  if (!xs.length) return { ok: false, reason: "no dividerXs provided", hits: 0, requireCount, per: [], y, y0, y1 };

  // helper: compute stripe stats centered at xc
  function stripeStats(xc) {
    const x0 = clamp(Math.floor(xc - stripeW / 2), 0, w - 1);
    const x1 = clamp(x0 + stripeW, x0 + 1, w);

    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) return null;

    const whiteCount = rectSum(whiteP, W, x0, y0, x1, y1);
    const nonWhiteFrac = (area - whiteCount) / area;

    let darkFrac = null;
    if (darkP) {
      const darkCount = rectSum(darkP, W, x0, y0, x1, y1);
      darkFrac = darkCount / area;
    }

    // scoring: prioritize non-white (structure), small bump for dark (ink)
    const score =
      nonWhiteFrac +
      (Number.isFinite(darkFrac) ? 0.25 * darkFrac : 0);

    return { x0, x1, nonWhiteFrac, darkFrac, score };
  }

  for (const xc0 of xs) {
    const xcBase = clamp(Math.floor(xc0), 0, w - 1);

    // --- BEST SEARCH (this is what you were missing) ---
    // Search around the guessed divider x to snap onto the true divider stroke.
    let best = null;

    for (let dx = -searchDx; dx <= searchDx; dx += searchStep) {
      const xc = clamp(xcBase + dx, 0, w - 1);
      const s = stripeStats(xc);
      if (!s) continue;
      if (!best || s.score > best.score) best = { ...s, xc };
    }

    if (!best) {
      per.push({
        x: xcBase,
        x0: null,
        x1: null,
        nonWhiteFrac: 0,
        darkFrac: null,
        ok: false,
        note: "no stripe sample",
      });
      continue;
    }

    const okStripe =
      (best.nonWhiteFrac >= minNonWhiteFrac) ||
      (Number.isFinite(best.darkFrac) && best.darkFrac >= minDarkFrac);

    if (okStripe) hits++;

    per.push({
      x: best.xc,
      x0: best.x0,
      x1: best.x1,
      nonWhiteFrac: Math.round(best.nonWhiteFrac * 1000) / 1000,
      darkFrac: Number.isFinite(best.darkFrac) ? Math.round(best.darkFrac * 1000) / 1000 : null,
      ok: okStripe,
    });
  }

  return { ok: hits >= requireCount, hits, requireCount, per, y, y0, y1 };
}

/*************************
 * NEW: divider-safe row check (does NOT fail on colored blocks)
 *
 * Idea:
 * - A table row can be full of color (events), so full-width "whiteFrac" is not reliable.
 * - Instead we check "row plausibility" using:
 *   - divider-trimmed day interiors (Mon–Fri) if dayRegions exists
 *   - inside each trimmed day band, we look for:
 *       - low darkFrac (not a thick footer / outside table)
 *       - reasonable nonWhiteFrac (cells may be colored, so allow high)
 *
 * Returns ok + diagnostics.
 *************************/
function hasRowLikeStructure(pre, y, opts = {}) {
  const {
    dayRegions = null,
    dividerXs = null,   // ✅ NEW: use passed divider Xs, not window global

    bandH = 10,
    maxDarkFrac = 0.22,
    minNonWhiteFrac = 0.06,
    requireDaysOk = 3,

    fallbackSpans = [
      { x0Frac: 0.14, x1Frac: 0.30 },
      { x0Frac: 0.34, x1Frac: 0.50 },
      { x0Frac: 0.54, x1Frac: 0.70 },
      { x0Frac: 0.74, x1Frac: 0.90 },
    ],
  } = opts;

  if (!pre?.whiteP || !Number.isFinite(pre.W)) return { ok: false, reason: "no whiteP" };
  const { w, h, whiteP, darkP, W } = pre;

  const y0 = clamp(Math.floor(y - bandH / 2), 0, h - 1);
  const y1 = clamp(y0 + bandH, y0 + 1, h);

  function evalBand(x0, x1) {
    x0 = clamp(Math.floor(x0), 0, w - 1);
    x1 = clamp(Math.floor(x1), x0 + 1, w);
    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) return null;

    const whiteCount = rectSum(whiteP, W, x0, y0, x1, y1);
    const nonWhiteFrac = (area - whiteCount) / area;

    let darkFrac = NaN;
    if (darkP) {
      const darkCount = rectSum(darkP, W, x0, y0, x1, y1);
      darkFrac = darkCount / area;
    }

    // ✅ require finite darkFrac (pipeline should always have it)
    // Accept either:
    //  (A) "row has ink/texture" (your current rule)
    //  (B) "row interior is very blank/white" (common when cells are empty / gridline is faint)
    //      This prevents false stops when big schedule blocks hide horizontal lines elsewhere.
    const blankOk =
      nonWhiteFrac <= 0.01 &&              // basically all-white in that band
      Number.isFinite(darkFrac) &&
      darkFrac <= 0.02;                    // also basically no dark ink

    const inkOk =
      nonWhiteFrac >= minNonWhiteFrac &&
      Number.isFinite(darkFrac) &&
      darkFrac <= maxDarkFrac;

    const ok = inkOk || blankOk;

    return { ok, nonWhiteFrac, darkFrac, x0, x1 };
  }

  const samples = [];

  // Prefer divider-trimmed day interiors if available
  if (dayRegions && Array.isArray(dividerXs) && dividerXs.length) {
    let okCount = 0;

    for (const day of WEEKDAYS) {
      const r = dayRegions[day];
      if (!r) continue;

      // ✅ Trim away divider strokes using passed dividerXs (NOT global)
      const t = trimDayRegionByDivider(r, dividerXs, 6);
      if (!t) continue;

      const span = t.x1 - t.x0;
      const inset = clamp(Math.round(span * 0.10), 6, 22);

      const s = evalBand(t.x0 + inset, t.x1 - inset);
      if (!s) continue;

      s.day = day;
      samples.push(s);
      if (s.ok) okCount++;
    }

    return {
      ok: okCount >= requireDaysOk,
      mode: "dayRegions",
      okCount,
      samples,
      band: { y0, y1 }
    };
  }

  // fallback
  let okCount = 0;
  for (const sp of fallbackSpans) {
    const s = evalBand(w * sp.x0Frac, w * sp.x1Frac);
    if (!s) continue;
    samples.push(s);
    if (s.ok) okCount++;
  }

  return {
    ok: okCount >= Math.max(2, Math.ceil(samples.length * 0.5)),
    mode: "fallbackSpans",
    okCount,
    samples,
    band: { y0, y1 }
  };
}

/*************************
 * SUPPORT — find lane mark near expected Y (used by G2 terminal tick logic)
 *
 * Goal:
 * - Scan a narrow horizontal band around expectedY inside a lane (x0..x1)
 * - Return best candidate y if enough non-white evidence exists
 *************************/
/*************************
 * SUPPORT — best lane mark near expected Y (used by G2 terminal tick)
 *
 * Looks ONLY in the left tick lane for a row mark/grid line near expectedY.
 * Returns best candidate within snapWin if it meets minNonWhiteFrac.
 *************************/
function findBestLaneMarkNearY(pre, expectedY, opts = {}) {
  const {
    lane = null,          // {x0,x1} in pixels (preferred). If null, uses __TICK_LANE__
    bandH = 14,
    snapWin = 18,
    minNonWhiteFrac = 0.05,  // lane evidence threshold
    scanStep = 1,
  } = opts;

  if (!pre?.whiteP || !Number.isFinite(pre.W)) return null;

  const { w, h, whiteP, darkP, W } = pre;

  const L = lane || null;
  if (!L || !Number.isFinite(L.x0) || !Number.isFinite(L.x1)) return null;

  const x0 = clamp(Math.floor(L.x0), 0, w - 1);
  const x1 = clamp(Math.floor(L.x1), x0 + 1, w);

  const yLo = clamp(Math.floor(expectedY - snapWin), 0, h - bandH);
  const yHi = clamp(Math.floor(expectedY + snapWin), 0, h - bandH);

  let best = null;

  for (let y0 = yLo; y0 <= yHi; y0 += scanStep) {
    const y1 = y0 + bandH;
    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) continue;

    const whiteCount = rectSum(whiteP, W, x0, y0, x1, y1);
    const nonWhiteFrac = (area - whiteCount) / area;

    // optional: small bump for dark ink if darkP exists
    let darkFrac = 0;
    if (darkP) {
      const darkCount = rectSum(darkP, W, x0, y0, x1, y1);
      darkFrac = darkCount / area;
    }

    const score = nonWhiteFrac + 0.25 * darkFrac;

    if (!best || score > best.score) {
      best = {
        y: y0 + Math.floor(bandH / 2),
        y0, y1,
        x0, x1,
        nonWhiteFrac,
        darkFrac,
        score
      };
    }
  }

  if (!best) return null;
  if (best.nonWhiteFrac < minNonWhiteFrac) return null;

  return {
    y: best.y,
    nonWhiteFrac: Math.round(best.nonWhiteFrac * 1000) / 1000,
    darkFrac: Math.round(best.darkFrac * 1000) / 1000,
    score: Math.round(best.score * 1000) / 1000,
    rect: { x0: best.x0, x1: best.x1, y0: best.y0, y1: best.y1 }
  };
}

function buildGlobalTickLadder(pre, vTicks, dy, opts = {}) {
  const {
    snapFrac = 0.12,
    minSnapPx = 4,
    maxSnapPx = 18,
    maxSteps = 120,

    // vertical divider check opts
    requireCount,

    // NEW: pass dayRegions if you have it
    dayRegions = null,
  } = opts;

  const dividerXs = opts.dividerXs || null;

  if (!pre || !Array.isArray(vTicks) || vTicks.length < 2 || !Number.isFinite(dy)) {
    return {
      ok: false,
      ticks: Array.isArray(vTicks) ? vTicks.slice() : [],
      dy,
      snapWin: 0,
      stopReason: "missing inputs",
    };
  }

  const snapWin = clamp(Math.round(dy * snapFrac), minSnapPx, maxSnapPx);

  // Start from the first validated tick
  const out = [vTicks[0]];
  let prev = vTicks[0];

  let stopReason = "unknown";
  let steps = 0;

  let consecutiveVGood = 0;
  let allowedGapUsed = 0;

  while (steps < maxSteps) {
    steps++;
    const expected = prev + dy;

    if (expected >= pre.h - 2) {
      stopReason = "hit image bottom";
      break;
    }

    // (A) Horizontal peak
    const hPeak = findBestHLinePeak(pre, expected, { snapWin });

    if (hPeak.ok) {
      out.push(hPeak.y);
      prev = hPeak.y;

      // horizontal success doesn't build "vertical streak"
      consecutiveVGood = 0;
      allowedGapUsed = 0;
      continue;
    }

    // (B) Vertical structure
    const vStruct = hasVerticalDayStructureAtY(pre, expected, {
      dividerXs: opts.dividerXs,
      requireCount: Number.isFinite(requireCount) ? requireCount : 3,
    });

    console.log("STACK G2V: vertical check", {
      expected: Math.round(expected),
      vOk: vStruct.ok,
      hits: vStruct.hits,
      requireCount: vStruct.requireCount,
      best: (vStruct.per || []).map((p) => ({
        x: p.x,
        nonW: p.nonWhiteFrac,
        dark: p.darkFrac,
        ok: p.ok,
      })),
    });

    if (vStruct.ok) {
      const row = hasRowLikeStructure(pre, expected, {
        dayRegions,
        dividerXs: opts.dividerXs,   // ✅ ADD THIS
      });
      console.log("STACK G2R: row band check", { expected: Math.round(expected), ...row });

      if (!row.ok) {
        stopReason = "left table (row band failed)";
        break;
      }

      out.push(Math.round(expected));
      prev = expected;

      consecutiveVGood++;
      allowedGapUsed = 0;
      continue;
    }

    // ----- FIX: compute stableRun BEFORE you zero anything -----
    // stable run snapshot BEFORE any reset
    const stableRun = consecutiveVGood >= 5;

    // allow ONE miss after a stable run (safe)
    if (stableRun) {
      const v2 = hasVerticalDayStructureAtY(pre, expected, {
        dividerXs: opts.dividerXs,
        requireCount: 2,
      });

      console.log("STACK G2V2: retry vertical check (requireCount=2)", {
        expected: Math.round(expected),
        vOk: v2.ok,
        hits: v2.hits,
        requireCount: v2.requireCount,
      });

      if (v2.ok) {
        const row2 = hasRowLikeStructure(pre, expected, {
          dayRegions,
          dividerXs: opts.dividerXs,
        });

        console.log("STACK G2R2: row band check (retry)", { expected: Math.round(expected), ...row2 });

        if (!row2.ok) {
          stopReason = "left table (row band failed on retry)";
          break;
        }

        out.push(Math.round(expected));
        prev = expected;

        consecutiveVGood = 1;     // restart streak after successful retry accept
        allowedGapUsed = 0;
        continue;
      }

      if (allowedGapUsed === 0) {
        allowedGapUsed = 1;
        // IMPORTANT: do NOT clear consecutiveVGood yet; keep it for this one-gap allowance
        continue;
      }
    }
    // no vertical confirmation this step (and either not stable, or stable gap already used)
    consecutiveVGood = 0;

    // both signals failed => stop
    stopReason = hPeak.reason || "no strong line peak";

    // Terminal tick: trust LEFT LANE once, using NON-WHITE and scanning a WIDER window.
    // snapWin from validation is usually tiny (like 4) — too tight for Gizmo’s bottom border.
    const snapWinTerm = clamp(Math.round(dy * 0.7), 10, 28); // dy=30 => ~21px

    const laneBest = findBestLaneMarkNearY(pre, expected, {
      lane: window.__TICK_LANE__ || null,
      bandH: 14,
      minNonWhiteFrac: 0.05,   // can drop to 0.04 if needed
      snapWin: snapWinTerm
    });

    console.log("STACK G2+: laneBest", {
      expected: Math.round(expected),
      snapWin,
      snapWinTerm,
      tickLane: window.__TICK_LANE__ || null,
      laneBest
    });

    if (
      laneBest &&
      Math.abs(laneBest.y - expected) <= snapWinTerm
    ) {
      out.push(Math.round(laneBest.y));
      console.log("STACK G2+: appended terminal tick from left lane (NONWHITE)", {
        y: Math.round(laneBest.y),
        nonWhiteFrac: laneBest.nonWhiteFrac,
        rect: laneBest.rect,
        snapWinTerm
      });
    }
    break;
  }

  const ok = out.length >= 2;
  return { ok, ticks: out, dy, snapWin, stopReason };
}

/*************************
 * ✅ LAYER H0 — DAY DIVIDERS → DAYREGIONS FREEZE (Mon–Fri)
 *
 * Uses NON-WHITE + DARK evidence to find vertical divider lines.
 * Then freezes day column x-ranges between adjacent dividers.
 *
 * Contract:
 * - Inputs: pre (whiteP/darkP), vTicks (for y band selection)
 * - Output: {Monday..Friday}: {x0,x1}
 * - Fail cleanly if divider count is not stable.
 *************************/

function pickDayBandY(pre, vTicks) {
  // choose a y band that avoids header text and avoids image bottom
  const { h } = pre;
  if (!Array.isArray(vTicks) || vTicks.length < 6) {
    return clamp(Math.floor(h * 0.35), 0, h - 1);
  }
  // use around late morning-ish: between tick 6 and 10 if possible
  const i = clamp(8, 2, vTicks.length - 3);
  const y = Math.floor((vTicks[i] + vTicks[i + 1]) / 2);
  return clamp(y, 0, h - 1);
}

function scoreVLineAtX(pre, x, yCenter, opts = {}) {
  const {
    bandH = 160,      // tall vertical sample
    stripeW = 5,      // thin stripe
  } = opts;

  const { w, h, whiteP, darkP, W } = pre;
  const x0 = clamp(Math.floor(x - stripeW / 2), 0, w - 1);
  const x1 = clamp(x0 + stripeW, x0 + 1, w);

  const y0 = clamp(Math.floor(yCenter - bandH / 2), 0, h - 1);
  const y1 = clamp(y0 + bandH, y0 + 1, h);

  const area = (x1 - x0) * (y1 - y0);
  if (!area) return null;

  const whiteCount = rectSum(whiteP, W, x0, y0, x1, y1);
  const nonWhiteFrac = (area - whiteCount) / area;

  let darkFrac = 0;
  if (darkP) {
    const darkCount = rectSum(darkP, W, x0, y0, x1, y1);
    darkFrac = darkCount / area;
  }

  return { x: Math.floor(x), x0, x1, y0, y1, nonWhiteFrac, darkFrac };
}

function findBestDividerNearX(pre, yCenter, xGuess, opts = {}) {
  const {
    searchPx = 40,
    scanStep = 1,
    bandH = 160,
    stripeW = 5,
    minNonWhiteFrac = 0.18, // softer than before
  } = opts;

  let best = null;

  for (let dx = -searchPx; dx <= searchPx; dx += scanStep) {
    const x = Math.floor(xGuess + dx);
    if (x <= 0 || x >= pre.w) continue;

    const s = scoreVLineAtX(pre, x, yCenter, { bandH, stripeW });
    if (!s) continue;
    if (s.nonWhiteFrac < minNonWhiteFrac) continue;

    // score favors consistency over darkness
    const score = s.nonWhiteFrac + (s.darkFrac * 0.25);

    if (!best || score > best.score) {
      best = { ...s, score };
    }
  }

  return best;
}

function findDayDividers(pre, vTicks, opts = {}) {
  const {
    expected = 6,            // left + 4 internals + right
    xStartFrac = 0.10,
    xEndFrac   = 0.985,
    bandH = 160,
    stripeW = 5,
  } = opts;

  if (!pre?.whiteP || !pre?.darkP || !Number.isFinite(pre.w) || !Number.isFinite(pre.h)) {
    return { ok: false, reason: "missing pre requisites", xs: [], divs: [] };
  }

  const yCenter = pickDayBandY(pre, vTicks);

  const w = pre.w;
  const xStart = Math.floor(w * xStartFrac);
  const xEnd   = Math.floor(w * xEndFrac);

  // --------------------------------------------------
  // 1) FIND LEFTMOST DIVIDER (anchor)
  // --------------------------------------------------
  let left = null;
  for (let x = xStart; x <= xEnd; x += 2) {
    const s = scoreVLineAtX(pre, x, yCenter, { bandH, stripeW });
    if (!s) continue;
    if (s.nonWhiteFrac < 0.22) continue;

    left = { ...s, score: s.nonWhiteFrac + s.darkFrac * 0.25 };
    break;
  }

  if (!left) {
    return {
      ok: false,
      reason: "could not find leftmost divider",
      yCenter,
      xs: [],
      divs: []
    };
  }

  // --------------------------------------------------
  // 2) FIND RIGHTMOST DIVIDER
  // --------------------------------------------------
  let right = null;
  for (let x = xEnd; x >= xStart; x -= 2) {
    const s = scoreVLineAtX(pre, x, yCenter, { bandH, stripeW });
    if (!s) continue;
    if (s.nonWhiteFrac < 0.22) continue;

    right = { ...s, score: s.nonWhiteFrac + s.darkFrac * 0.25 };
    break;
  }

  if (!right || right.x <= left.x + 50) {
    return {
      ok: false,
      reason: "could not find rightmost divider",
      yCenter,
      xs: [],
      divs: []
    };
  }

  // --------------------------------------------------
  // 3) WALK EXPECTED POSITIONS
  // --------------------------------------------------
  const span = right.x - left.x;
  const step = span / (expected - 1);

  const divs = [];
  for (let i = 0; i < expected; i++) {
    const guess = left.x + step * i;

    const best = findBestDividerNearX(pre, yCenter, guess, {
      bandH,
      stripeW
    });

    if (!best) {
      return {
        ok: false,
        reason: `missing divider ${i}`,
        yCenter,
        xs: [],
        divs: []
      };
    }

    divs.push(best);
  }

  const xs = divs.map(d => d.x);

  return {
    ok: xs.length === expected,
    yCenter,
    xs,
    divs: divs.map(d => ({
      x: d.x,
      score: +d.score.toFixed(3),
      dark: +d.darkFrac.toFixed(3),
      nonW: +d.nonWhiteFrac.toFixed(3)
    })),
    reason: "ok"
  };
}

function freezeDayRegionsFromDividers(divResult) {
  if (!divResult?.ok) return { ok: false, reason: "no dividers" };

  const xs = Array.isArray(divResult.xs)
    ? divResult.xs.slice().sort((a, b) => a - b)
    : (divResult.divs || []).map(d => d.x).sort((a, b) => a - b);

  if (xs.length !== 6) return { ok: false, reason: "bad divider count" };

  const regions = {};
  for (let i = 0; i < 5; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    regions[WEEKDAYS[i]] = { x0, x1 };
  }
  return { ok: true, regions, xs };
}

/*************************
 * LAYER H — SLOT BANDS FROM VALIDATED TICKS (SAFE)
 * (CODE PRESENT; EXECUTION OFF)
 *************************/

// estimate thickness band of a line at yCenter, scanning rows in the chosen lane
function estimateLineBandAtTick(pre, yCenter, lane = {}) {
  const { darkP, W, w, h } = pre || {};
  if (!darkP || !Number.isFinite(W) || !Number.isFinite(w) || !Number.isFinite(h)) return null;

  const x0Frac = Number.isFinite(lane.x0Frac) ? lane.x0Frac : 0.015;
  const x1Frac = Number.isFinite(lane.x1Frac) ? lane.x1Frac : 0.055;

  const x0 = clamp(Math.floor(w * x0Frac), 0, w - 1);
  const x1 = clamp(Math.floor(w * x1Frac), x0 + 1, w);

  const rowDarkThresh = Math.max(2, Math.floor((x1 - x0) * 0.12));

  function isDarkRow(y) {
    if (y < 0 || y >= h) return false;
    const cnt = rectSum(darkP, W, x0, y, x1, y + 1);
    return cnt >= rowDarkThresh;
  }

  yCenter = clamp(Math.floor(yCenter), 0, h - 1);

  let y0 = yCenter;
  while (y0 > 0 && isDarkRow(y0 - 1)) y0--;

  let y1 = yCenter;
  while (y1 < h - 1 && isDarkRow(y1 + 1)) y1++;

  return { y0, y1: y1 + 1, cy: yCenter, lane: { x0, x1, x0Frac, x1Frac } };
}

function buildSlotBandsFromTicks(pre, ticks, lane = {}) {
  if (!pre || !Array.isArray(ticks) || ticks.length < 2) return [];

  const lineBands = ticks.map((t) => estimateLineBandAtTick(pre, t, lane)).filter(Boolean);
  if (lineBands.length < 2) return [];

  const slots = [];

  for (let i = 0; i < lineBands.length - 1; i++) {
    const top = lineBands[i];
    const bot = lineBands[i + 1];

    const yStart = clamp(top.y1, 0, pre.h - 1);
    const yEnd   = clamp(bot.y0, 1, pre.h);

    if (yEnd - yStart >= 8) {
      slots.push({ yStart, yEnd, topTick: top.cy, botTick: bot.cy });
    }
  }

  return slots;
}

/*************************
 * LAYER I.1 — FRIDAY BACKGROUND CALIBRATION (pick WHITEST slots)
 *
 * Upgrade:
 * - Instead of blindly sampling bottom N Friday slots (which may be busy),
 *   we MEASURE whiteFrac per slot using pre.whiteP (O(1) rect sums),
 *   then pick the top CAL_PICK_TOP whitest slots and sample only those.
 *
 * Produces:
 * LAST_BG = { r, g, b, tol, samples, whiteFrac }
 *************************/

// helper: compute white fraction in a rect using prefix sums
function rectWhiteFrac(pre, x0, y0, x1, y1) {
  if (!pre?.whiteP || !Number.isFinite(pre.W)) return 0;
  const { whiteP, W } = pre;

  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return 0;

  const whiteCount = rectSum(whiteP, W, x0, y0, x1, y1);
  return whiteCount / area;
}

function calibrateFridayBackground(pre, dayRegions, slotBands, opts = {}) {
  const {
    pickBottom = 8,          // examine bottom N slots (candidates)
    pickTop = CAL_PICK_TOP,  // choose K whitest slots from candidates
    samplesPerSlot = 60,     // sample density
    tolBase = BG_TOL_BASE,
    tolMax = BG_TOL_MAX,

    // inset away from dividers / borders
    insetX = 8,
    insetY = 2,

    // optional: require some minimum whiteness to accept calibration
    minAcceptWhiteFrac = 0.70,
  } = opts;

  if (!pre || !dayRegions?.Friday || !Array.isArray(slotBands) || slotBands.length < 4) {
    return { ok: false, reason: "missing inputs" };
  }

  const { w, h, imgData } = pre;
  const { x0: fx0, x1: fx1 } = dayRegions.Friday;

  // --- 1) Build candidate slots (bottom few), measure whiteness per slot using prefix sums ---
  const candidates = slotBands.slice(-pickBottom).map((s, idxFromBottom) => {
    const x0 = clamp(fx0 + insetX, 0, w - 1);
    const x1 = clamp(fx1 - insetX, x0 + 1, w);

    const yStart = (s.yStart ?? s.topTick) + insetY;
    const yEnd   = (s.yEnd   ?? s.botTick) - insetY;


    const y0 = clamp(yStart, 0, h - 1);
    const y1 = clamp(yEnd, y0 + 1, h);

    const wf = rectWhiteFrac(pre, x0, y0, x1, y1);

    return {
      slotIndexFromBottom: (pickBottom - 1) - idxFromBottom,
      x0, x1, y0, y1,
      whiteFrac: wf
    };
  });

  // sort by measured whiteness
  candidates.sort((a, b) => b.whiteFrac - a.whiteFrac);

  const chosen = candidates.slice(0, Math.max(1, pickTop));

  const chosenWhiteFracMean =
    chosen.reduce((acc, c) => acc + c.whiteFrac, 0) / chosen.length;

  console.log("STACK I1: slot whiteness ranking (Friday)", {
    fridayX: { x0: fx0, x1: fx1, insetX },
    candidates: candidates.map(c => ({
      whiteFrac: Math.round(c.whiteFrac * 1000) / 1000,
      y: [c.y0, c.y1]
    })),
    chosen: chosen.map(c => ({
      whiteFrac: Math.round(c.whiteFrac * 1000) / 1000,
      y: [c.y0, c.y1]
    })),
    chosenWhiteFracMean: Math.round(chosenWhiteFracMean * 1000) / 1000,
    note:
      "We pick the whitest Friday slots (by whiteP) before sampling RGB. " +
      "If chosenWhiteFracMean is low, Friday is busy/colored and we should fallback later."
  });

  if (chosenWhiteFracMean < minAcceptWhiteFrac) {
    return {
      ok: false,
      reason: "friday too busy/colored (low whiteness)",
      meta: {
        chosenWhiteFracMean: Math.round(chosenWhiteFracMean * 1000) / 1000,
        minAcceptWhiteFrac
      }
    };
  }

  // --- 2) Sample RGB only from chosen whitest slots ---
  const rs = [], gs = [], bs = [];
  let whiteCount = 0;
  let total = 0;

  for (const c of chosen) {
    for (let i = 0; i < samplesPerSlot; i++) {
      const x = clamp(c.x0 + Math.random() * (c.x1 - c.x0), 0, w - 1) | 0;
      const y = clamp(c.y0 + Math.random() * (c.y1 - c.y0), 0, h - 1) | 0;
      const p = idxOf(x, y, w);

      const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];
      rs.push(r); gs.push(g); bs.push(b);
      if (isNearWhite(r, g, b)) whiteCount++;
      total++;
    }
  }

  if (rs.length < 80) {
    return { ok: false, reason: "too few samples" };
  }

  // robust center: median
  rs.sort((a,b)=>a-b); gs.sort((a,b)=>a-b); bs.sort((a,b)=>a-b);
  const mid = rs.length >> 1;
  const rMed = rs[mid], gMed = gs[mid], bMed = bs[mid];

  // estimate spread (MAD-like)
  function mad(arr, m) {
    const d = arr.map(v => Math.abs(v - m)).sort((a,b)=>a-b);
    return d[d.length >> 1];
  }
  const rMad = mad(rs, rMed), gMad = mad(gs, gMed), bMad = mad(bs, bMed);
  const spread = Math.max(rMad, gMad, bMad);

  const tol = clamp(Math.round(tolBase + spread * 2.5), tolBase, tolMax);
  const whiteFrac = total ? (whiteCount / total) : 0;

  const bg = {
    r: rMed,
    g: gMed,
    b: bMed,
    tol,
    samples: rs.length,
    whiteFrac: Math.round(whiteFrac * 1000) / 1000
  };

  console.log("STACK I0: Friday BG frozen (I.1 pick-whitest)", {
    medianRGB: { r: rMed, g: gMed, b: bMed },
    madRGB: { r: rMad, g: gMad, b: bMad },
    tol,
    samples: bg.samples,
    whiteFrac: bg.whiteFrac,
    chosenWhiteFracMean: Math.round(chosenWhiteFracMean * 1000) / 1000
  });
  return { ok: true, bg };
}

// NOTE:
// These thresholds are PREFIX-SUM specific.
// They are NOT comparable to J1 sampled thresholds.
// Do NOT tune them to "match" J1 behavior.

function detectGridSpillPrefix_DIAGNOSTIC(pre, slotBand, dayRegion, opts = {}) {
  const {
    insetX = 8,
    insetY = 2,

    edgeStripeW = 8,
    hStripeH = 4,

    // thresholds in NON-WHITE space (prefix based)
    centerNonWhiteMax = 0.10,
    edgeNonWhiteMin = 0.25,
    hStripeNonWhiteMin = 0.22,

    minW = 40,
    minH = 10,
  } = opts;

  if (!pre?.whiteP || !Number.isFinite(pre.W)) {
    return { ok: false, spill: false, reason: "no prefix sums" };
  }
  if (!slotBand || !dayRegion) {
    return { ok: false, spill: false, reason: "missing slotBand/dayRegion" };
  }

  const { w, h } = pre;
  let { x0, x1 } = dayRegion;
  let { yStart, yEnd } = slotBand;

  // Clamp rect
  x0 = clamp(Math.floor(x0), 0, w - 1);
  x1 = clamp(Math.floor(x1), x0 + 1, w);
  yStart = clamp(Math.floor(yStart), 0, h - 1);
  yEnd = clamp(Math.floor(yEnd), yStart + 1, h);

  const cellW = x1 - x0;
  const cellH = yEnd - yStart;
  if (cellW < minW || cellH < minH) {
    return { ok: false, spill: false, reason: "tiny cell", meta: { cellW, cellH } };
  }

  // Inset interior region (the “true” sampling area)
  const ix0 = clamp(x0 + insetX, 0, w - 1);
  const ix1 = clamp(x1 - insetX, ix0 + 1, w);
  const iy0 = clamp(yStart + insetY, 0, h - 1);
  const iy1 = clamp(yEnd - insetY, iy0 + 1, h);

  // Center window (avoid edges by more inset)
  const cxPad = Math.max(10, Math.floor((ix1 - ix0) * 0.18));
  const cyPad = Math.max(4, Math.floor((iy1 - iy0) * 0.18));

  const cx0 = clamp(ix0 + cxPad, 0, w - 1);
  const cx1 = clamp(ix1 - cxPad, cx0 + 1, w);
  const cy0 = clamp(iy0 + cyPad, 0, h - 1);
  const cy1 = clamp(iy1 - cyPad, cy0 + 1, h);

  // Left/right edge stripes inside the day column
  const lx0 = ix0;
  const lx1 = clamp(ix0 + edgeStripeW, lx0 + 1, ix1);

  const rx1 = ix1;
  const rx0 = clamp(ix1 - edgeStripeW, ix0, rx1 - 1);

  // Horizontal stripes near top/bottom of slot interior
  const ty0 = iy0;
  const ty1 = clamp(iy0 + hStripeH, ty0 + 1, iy1);

  const by1 = iy1;
  const by0 = clamp(iy1 - hStripeH, iy0, by1 - 1);

  // Compute non-white fractions (prefix)
  const centerNW = rectNonWhiteFrac(pre, cx0, cy0, cx1, cy1);

  const leftNW  = rectNonWhiteFrac(pre, lx0, iy0, lx1, iy1);
  const rightNW = rectNonWhiteFrac(pre, rx0, iy0, rx1, iy1);

  const topNW = rectNonWhiteFrac(pre, ix0, ty0, ix1, ty1);
  const botNW = rectNonWhiteFrac(pre, ix0, by0, ix1, by1);

  // Optional: dark fractions (prefix; diagnostic)
  const leftD  = rectDarkFracPrefix(pre, lx0, iy0, lx1, iy1);
  const rightD = rectDarkFracPrefix(pre, rx0, iy0, rx1, iy1);
  const topD   = rectDarkFracPrefix(pre, ix0, ty0, ix1, ty1);
  const botD   = rectDarkFracPrefix(pre, ix0, by0, ix1, by1);

  const edgeSpill =
    (centerNW <= centerNonWhiteMax) &&
    (Math.max(leftNW, rightNW) >= edgeNonWhiteMin);

  const hSpill =
    (centerNW <= centerNonWhiteMax) &&
    (Math.max(topNW, botNW) >= hStripeNonWhiteMin);

  const spill = edgeSpill || hSpill;

  return {
    ok: true,
    spill,
    meta: {
      centerNW: +centerNW.toFixed(3),
      leftNW: +leftNW.toFixed(3),
      rightNW: +rightNW.toFixed(3),
      topNW: +topNW.toFixed(3),
      botNW: +botNW.toFixed(3),

      leftD: +leftD.toFixed(3),
      rightD: +rightD.toFixed(3),
      topD: +topD.toFixed(3),
      botD: +botD.toFixed(3),

      edgeSpill,
      hSpill,
      rect: { x0, x1, yStart, yEnd },
      interior: { ix0, ix1, iy0, iy1 },
      center: { cx0, cx1, cy0, cy1 },
    }
  };
}

function buildThumbFromCanvas(opts = {}) {
  const maxW = opts.maxW ?? 320;
  const jpegQuality = opts.jpegQuality ?? 0.72;

  if (!canvas || !canvas.width || !canvas.height) return null;

  // scale down from preview canvas to tiny thumb
  const scale = Math.min(1, maxW / canvas.width);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;

  const cctx = c.getContext("2d");
  if (!cctx) return null;

  cctx.drawImage(canvas, 0, 0, w, h);

  let dataURL = null;
  try { dataURL = c.toDataURL("image/jpeg", jpegQuality); } catch {}

  if (!dataURL) return null;

  return { mime: "image/jpeg", w, h, dataURL };
}

/*************************
 * LAYER I.2 — GLOBAL BACKGROUND FALLBACK
 *
 * Used ONLY if Friday calibration fails.
 * Strategy:
 * - Scan ALL day regions (Mon–Fri)
 * - Measure whiteFrac per slot using prefix sums
 * - Pick top K whitest slots overall
 *************************/
function calibrateGlobalBackground(pre, dayRegions, slotBands, opts = {}) {
  const {
    pickTop = CAL_PICK_TOP,
    samplesPerSlot = 60,
    insetX = 8,
    insetY = 2,
    minAcceptWhiteFrac = 0.70,
    tolBase = BG_TOL_BASE,
    tolMax = BG_TOL_MAX,
  } = opts;

  if (!pre || !dayRegions || !Array.isArray(slotBands)) {
    return { ok: false, reason: "missing inputs" };
  }

  const { w, h, imgData } = pre;

  const candidates = [];

  for (const day of Object.values(dayRegions)) {
    const { x0, x1 } = day;

    for (const s of slotBands) {
      const y0 = clamp((s.yStart ?? s.topTick) + insetY, 0, h - 1);
      const y1 = clamp((s.yEnd   ?? s.botTick) - insetY, y0 + 1, h);

      const rx0 = clamp(x0 + insetX, 0, w - 1);
      const rx1 = clamp(x1 - insetX, rx0 + 1, w);

      const wf = rectWhiteFrac(pre, rx0, y0, rx1, y1);
      candidates.push({ rx0, rx1, y0, y1, whiteFrac: wf });
    }
  }

  candidates.sort((a, b) => b.whiteFrac - a.whiteFrac);
  const chosen = candidates.slice(0, Math.max(1, pickTop));

  const meanWhite =
    chosen.reduce((a, c) => a + c.whiteFrac, 0) / chosen.length;

  if (meanWhite < minAcceptWhiteFrac) {
    return {
      ok: false,
      reason: "global fallback too colored",
      meta: { meanWhite: +meanWhite.toFixed(3) }
    };
  }

  const rs = [], gs = [], bs = [];
  let whiteCount = 0, total = 0;

  for (const c of chosen) {
    for (let i = 0; i < samplesPerSlot; i++) {
      const x = (c.rx0 + Math.random() * (c.rx1 - c.rx0)) | 0;
      const y = (c.y0  + Math.random() * (c.y1  - c.y0))  | 0;
      const p = idxOf(x, y, w);

      const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];
      rs.push(r); gs.push(g); bs.push(b);
      if (isNearWhite(r, g, b)) whiteCount++;
      total++;
    }
  }

  rs.sort((a,b)=>a-b); gs.sort((a,b)=>a-b); bs.sort((a,b)=>a-b);
  const mid = rs.length >> 1;

  const bg = {
    r: rs[mid],
    g: gs[mid],
    b: bs[mid],
    tol: clamp(Math.round(tolBase + 10), tolBase, tolMax),
    samples: rs.length,
    whiteFrac: +(whiteCount / total).toFixed(3)
  };

  console.log("STACK I2: GLOBAL BG fallback frozen", bg);
  return { ok: true, bg };
}

function setUploadStatus(mode, msg, sub = "") {
  const el = document.getElementById("uploadStatus");
  if (!el) return;

  if (!mode || mode === "hide") {
    el.style.display = "none";
    el.className = "status-bubble status-idle";
    el.innerHTML = "";
    return;
  }

  el.style.display = "block";
  el.className = `status-bubble ${mode === "working" ? "status-working" : "status-idle"}`;
  el.innerHTML = `
    <div>${String(msg ?? "")}</div>
    ${sub ? `<div class="status-sub">${String(sub ?? "")}</div>` : ""}
  `;
}

/*************************
 * WORK COLOR MODEL (Purple) — tolerance + percentage
 *************************/
const PURPLE_TOL_BASE = 44;       // start a bit forgiving (purple varies)
const PURPLE_TOL_MAX  = 90;
const PURPLE_MIN_FRAC_DEFAULT = 0.18; // percent of samples in a cell that must be purple

function isValidWorkColor(c) {
  if (!c || typeof c !== "object") return false;
  const r = Number(c.r), g = Number(c.g), b = Number(c.b);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return false;

  if (c.tol !== undefined) {
    const tol = Number(c.tol);
    if (!Number.isFinite(tol) || tol < 0 || tol > PURPLE_TOL_MAX) return false;
  }
  if (c.minFrac !== undefined) {
    const mf = Number(c.minFrac);
    if (!Number.isFinite(mf) || mf < 0 || mf > 1) return false;
  }
  return true;
}

function isWorkMatch(r, g, b, work) {
  if (!work) return false;
  const tol = Number.isFinite(work.tol) ? work.tol : PURPLE_TOL_BASE;
  return (
    Math.abs(r - work.r) <= tol &&
    Math.abs(g - work.g) <= tol &&
    Math.abs(b - work.b) <= tol
  );
}

// Sample purple fraction inside a (day,slot) rect (same sampling style as classifySlotSample)
function sampleWorkFrac(pre, slotBand, dayRegion, work, opts = {}) {
  const {
    samples = 140,
    insetX = 8,
    insetY = 2,
  } = opts;

  if (!pre?.imgData || !Number.isFinite(pre.w) || !Number.isFinite(pre.h)) {
    return { ok: false, reason: "bad pre" };
  }
  if (!slotBand || !dayRegion || !work) {
    return { ok: false, reason: "missing slot/day/work" };
  }

  const { w, h, imgData } = pre;

  let x0 = Math.floor(dayRegion.x0 ?? NaN);
  let x1 = Math.floor(dayRegion.x1 ?? NaN);
  let y0 = Math.floor(slotBand.yStart ?? NaN);
  let y1 = Math.floor(slotBand.yEnd ?? NaN);

  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return { ok: false, reason: "bad dayRegion" };
  if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) return { ok: false, reason: "bad slotBand" };

  x0 = clamp(x0 + insetX, 0, w - 1);
  x1 = clamp(x1 - insetX, x0 + 1, w);
  y0 = clamp(y0 + insetY, 0, h - 1);
  y1 = clamp(y1 - insetY, y0 + 1, h);

  let workCount = 0;

  for (let i = 0; i < samples; i++) {
    const x = (x0 + Math.random() * (x1 - x0)) | 0;
    const y = (y0 + Math.random() * (y1 - y0)) | 0;
    const p = idxOf(x, y, w);

    const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];
    if (isWorkMatch(r, g, b, work)) workCount++;
  }

  const workFrac = workCount / samples;
  return { ok: true, workFrac: Math.round(workFrac * 1000) / 1000, samples };
}

// -------------------------
// NAV helper: trimDayRegionByDivider
// Used by nav row-structure checks to avoid sampling right on divider lines.
// -------------------------
function trimDayRegionByDivider(region, dividerXs, insetPx = 6) {
  if (!region) return region;

  let { x0, x1 } = region;
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return region;

  // Always do a small inset away from day edges
  x0 = Math.round(x0 + insetPx);
  x1 = Math.round(x1 - insetPx);

  // If we have divider Xs, avoid probing too near them
  if (Array.isArray(dividerXs) && dividerXs.length) {
    // nearest divider to left edge (within 40px window)
    const leftNear = dividerXs.reduce((best, dx) => {
      if (!Number.isFinite(dx)) return best;
      if (dx <= x0 + 40 && dx > best) return dx;
      return best;
    }, -Infinity);

    // nearest divider to right edge (within 40px window)
    const rightNear = dividerXs.reduce((best, dx) => {
      if (!Number.isFinite(dx)) return best;
      if (dx >= x1 - 40 && dx < best) return dx;
      return best;
    }, +Infinity);

    if (Number.isFinite(leftNear) && leftNear !== -Infinity) {
      x0 = Math.max(x0, Math.round(leftNear + insetPx));
    }
    if (Number.isFinite(rightNear) && rightNear !== +Infinity) {
      x1 = Math.min(x1, Math.round(rightNear - insetPx));
    }
  }

  // Safety clamp
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return region;

  return { ...region, x0, x1 };
}

/*************************
 * LAYER H/I GLUE — computeFrozenNavFromPre(pre)
 *
 * Purpose:
 * - Given pre (prefix sums + imgData), compute a complete NAV snapshot:
 *   dayRegions, slotBands, ticksForMap, bgWhite
 *
 * STRICT:
 * - NO UI
 * - NO storage
 * - NO publish
 *************************/
function computeFrozenNavFromPre(pre) {

  if (!pre) {
    console.warn("NAV: bail @pre (missing pre)");
    return null;
  }

  // 1) pick tick lane
  const lane = pickBestTickLane(pre);

  // Store pixel lane for terminal tick fallback helper (in-memory only)
  window.__TICK_LANE__ = {
    x0: Math.floor(pre.w * lane.x0Frac),
    x1: Math.floor(pre.w * lane.x1Frac),
    x0Frac: lane.x0Frac,
    x1Frac: lane.x1Frac
  };

  // 2) raw ticks
  const rawTicks = detectTimeTicksFromLeftLane(pre, lane);
  if (!Array.isArray(rawTicks) || rawTicks.length < 2) {
    console.warn("NAV: bail @rawTicks", { rawLen: rawTicks?.length, lane });
    return null;
  }

  // 3) validate ticks (walk down; no phantom rows)
  const v = validateTicksFromFirst(rawTicks);
  if (!v?.ok || !Array.isArray(v.ticks) || v.ticks.length < 2) {
    console.warn("NAV: bail @validateTicksFromFirst", { rawLen: rawTicks.length, v });
    return null;
  }
  const vTicks = v.ticks;
  const dy = v.dy;

  // 4) day dividers -> freeze dayRegions
  const divRes = findDayDividers(pre, vTicks);
  if (!divRes?.ok || !Array.isArray(divRes.xs) || divRes.xs.length < 6) {
    console.warn("NAV: bail @findDayDividers", divRes);
    return null;
  }
  // Normalize to 6 day boundaries:
  // keep the 5 internal separators + right edge
  const xs = divRes.xs;

  // If we got more than 6 (e.g., outer frame included), trim extremes
  const normXs =
    xs.length === 6
      ? xs
      : xs.slice(1, 7); // drop left outer border, keep Mon–Fri grid

  divRes.xs = normXs;

  const fr = freezeDayRegionsFromDividers(divRes);
  if (!fr?.ok || !fr.regions || !Array.isArray(fr.xs) || fr.xs.length !== 6) return null;

  const dayRegions = fr.regions;
  const dividerXs = fr.xs;

  // 5) global ladder (extend tick ladder)
  const g = buildGlobalTickLadder(pre, vTicks, dy, {
    dividerXs,
    dayRegions
  });
  if (!g?.ok || !Array.isArray(g.ticks) || g.ticks.length < 2) return null;

  const ticksForMap = g.ticks;

  // 6) slot bands from ticks
  const slotBands = buildSlotBandsFromTicks(pre, ticksForMap, lane);
  if (!Array.isArray(slotBands) || slotBands.length < 1) {
    console.warn("NAV: bail @buildSlotBandsFromTicks", { slots: slotBands?.length, ticks: ticksForMap?.length });
    return null;
  }
  // 7) background calibration (Friday first, then global fallback)
  let bgWhite = null;

  const calF = calibrateFridayBackground(pre, dayRegions, slotBands);
  if (calF?.ok && calF.bg) bgWhite = calF.bg;

  if (!bgWhite) {
    const calG = calibrateGlobalBackground(pre, dayRegions, slotBands);
    if (calG?.ok && calG.bg) bgWhite = calG.bg;
    else console.warn("NAV: global BG fallback failed", calG);
  }

  if (!bgWhite) {
    console.warn("NAV: bail @bgWhite (both Friday + global failed)");
    return null;
  }

  // 8) return lightweight NAV snapshot
  return {
    dayRegions,
    slotBands,
    ticksForMap,
    bgWhite,

    // Phase 2 will finalize based on dropdown selection
    anchorStartTime: "8:00 AM",

    preMeta: { w: pre.w, h: pre.h, ts: pre.meta?.ts || Date.now() },
    laneMeta: lane,
    dividerXs
  };
}

// expose for buildAndPublishNav
window.computeFrozenNavFromPre = computeFrozenNavFromPre;

function buildAndPublishNav(pre) {
  try {
    console.log("NAV: buildAndPublishNav ENTER", {
      hasPre: !!pre,
      w: pre?.w,
      h: pre?.h,
      ts: pre?.meta?.ts,
      hasCompute: typeof window.computeFrozenNavFromPre === "function"
    });

    if (!pre) {
      return { ok: false, reason: "Nav build failed: pre is null/undefined (LAST_PRE never published?)" };
    }

    if (typeof window.computeFrozenNavFromPre !== "function") {
      return { ok: false, reason: "Nav build failed: computeFrozenNavFromPre is not a function (load/order issue)" };
    }

    const nav = window.computeFrozenNavFromPre(pre);

    if (!nav) {
      console.warn("NAV: builder returned null (see earlier NAV: bail @... logs above)");
      return { ok: false, reason: "Nav builder returned null/undefined" };
    }

    // Minimal validation (matches snapshotNavState expectations)
    if (!nav.dayRegions) return { ok: false, reason: "nav missing dayRegions" };
    if (!nav.slotBands) return { ok: false, reason: "nav missing slotBands" };
    if (!nav.ticksForMap) return { ok: false, reason: "nav missing ticksForMap" };
    if (!nav.bgWhite && !nav.bg) return { ok: false, reason: "nav missing bg/bgWhite" };

    window.LAST_NAV = nav;
    window.__LAST_NAV__ = nav;

    console.log("NAV: buildAndPublishNav OK", {
      days: nav.dayRegions?.length,
      slots: nav.slotBands?.length,
      ticks: nav.ticksForMap?.length,
      hasBgWhite: !!nav.bgWhite
    });

    return { ok: true, nav };
  } catch (e) {
    console.warn("NAV: buildAndPublishNav EXCEPTION", e);
    return { ok: false, reason: e?.message || String(e) };
  }
}
window.buildAndPublishNav = buildAndPublishNav;

/************************************************************
 * LAYER J (CURRENT BUILD) — AVAILABILITY FROM FROZEN NAV
 *
 * Purpose:
 * - Given a frozen nav (dayRegions, slotBands, bg/bgWhite, anchorStartTime),
 *   classify each (day,slot) as FREE/BUSY.
 * - This is what upload.js Phase 2 expects.
 ************************************************************/

(function () {
  // ---- small safe helpers (use existing if present) ----
  const _clamp = (typeof window.clamp === "function")
    ? window.clamp
    : (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const _idxOf = (typeof window.idxOf === "function")
    ? window.idxOf
    : (x, y, w) => (y * w + x) * 4;

  const _isNearWhite = (typeof window.isNearWhite === "function")
    ? window.isNearWhite
    : (r, g, b, thresh = 240) => (r >= thresh && g >= thresh && b >= thresh);

  // If you already have rectSum(), we’ll use it. Otherwise we’ll inline a prefix-rect sum.
  const _rectSum = (typeof window.rectSum === "function")
    ? window.rectSum
    : (prefix, W, x0, y0, x1, y1) => {
        const A = y0 * W + x0;
        const B = y0 * W + x1;
        const C = y1 * W + x0;
        const D = y1 * W + x1;
        return prefix[D] - prefix[B] - prefix[C] + prefix[A];
      };

  function rectWhiteFrac(pre, x0, y0, x1, y1) {
    if (!pre?.whiteP || !Number.isFinite(pre.W)) return 0;
    const { whiteP, W } = pre;
    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) return 0;
    const whiteCount = _rectSum(whiteP, W, x0, y0, x1, y1);
    return whiteCount / area;
  }

  function rectNonWhiteFrac(pre, x0, y0, x1, y1) {
    return 1 - rectWhiteFrac(pre, x0, y0, x1, y1);
  }

  function rectDarkFrac(pre, x0, y0, x1, y1) {
    if (!pre?.darkP || !Number.isFinite(pre.W)) return 0;
    const { darkP, W } = pre;
    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) return 0;
    const darkCount = _rectSum(darkP, W, x0, y0, x1, y1);
    return darkCount / area;
  }

  function isBgMatch(r, g, b, bg) {
    if (!bg) return false;
    const tol = Number.isFinite(bg.tol) ? bg.tol : 34;
    return (
      Math.abs(r - bg.r) <= tol &&
      Math.abs(g - bg.g) <= tol &&
      Math.abs(b - bg.b) <= tol
    );
  }

  // --- Purple "work" detection (center + tol + fraction threshold) ---
  const PURPLE_WORK = { r: 213, g: 43, b: 255, tol: 55 };  // tol is adjustable

  function isPurpleMatch(r, g, b, p = PURPLE_WORK) {
    const tol = Number.isFinite(p?.tol) ? p.tol : 55;
    return (
      Math.abs(r - p.r) <= tol &&
      Math.abs(g - p.g) <= tol &&
      Math.abs(b - p.b) <= tol
    );
  }

  function measurePurpleFrac(pre, slotBand, dayRegion, opts = {}) {
    const {
      samples = 160,
      insetX = 8,
      insetY = 2,
      purple = PURPLE_WORK
    } = opts;

    const { w, h, imgData } = pre;

    let x0 = Math.floor(dayRegion.x0), x1 = Math.floor(dayRegion.x1);
    let y0 = Math.floor(slotBand.yStart), y1 = Math.floor(slotBand.yEnd);

    x0 = _clamp(x0 + insetX, 0, w - 1);
    x1 = _clamp(x1 - insetX, x0 + 1, w);
    y0 = _clamp(y0 + insetY, 0, h - 1);
    y1 = _clamp(y1 - insetY, y0 + 1, h);

    let purpleCount = 0;

    for (let i = 0; i < samples; i++) {
      const x = (x0 + Math.random() * (x1 - x0)) | 0;
      const y = (y0 + Math.random() * (y1 - y0)) | 0;
      const p = _idxOf(x, y, w);

      const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];
      if (isPurpleMatch(r, g, b, purple)) purpleCount++;
    }

    return purpleCount / samples;
  }

  // Sample-based classifier (bgFrac primary) + "occupiedFrac" hybrid rule
  // occupiedFrac counts NON-white pixels that are ALSO NOT purple (i.e., actual busy ink)
  function classifySlotSample(pre, slotBand, dayRegion, bg, opts = {}) {
    const {
      samples = 140,
      bgFracMin = 0.82,
      inkFracMax = 0.12,
      insetX = 8,
      insetY = 2,

      // ✅ Hybrid: only call it busy if >= 50% of the cell is occupied by non-bg, non-purple ink
      busyFracMin = 0.50,
      purple = PURPLE_WORK
    } = opts;

    if (!pre?.imgData || !Number.isFinite(pre.w) || !Number.isFinite(pre.h)) {
      return { ok: false, reason: "bad pre" };
    }
    if (!slotBand || !dayRegion || !bg) {
      return { ok: false, reason: "missing slot/day/bg" };
    }

    const { w, h, imgData } = pre;

    let x0 = Math.floor(dayRegion.x0 ?? NaN);
    let x1 = Math.floor(dayRegion.x1 ?? NaN);
    let y0 = Math.floor(slotBand.yStart ?? NaN);
    let y1 = Math.floor(slotBand.yEnd ?? NaN);

    if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return { ok: false, reason: "bad dayRegion" };
    if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) return { ok: false, reason: "bad slotBand" };

    // inset away from dividers/grid edges
    x0 = _clamp(x0 + insetX, 0, w - 1);
    x1 = _clamp(x1 - insetX, x0 + 1, w);
    y0 = _clamp(y0 + insetY, 0, h - 1);
    y1 = _clamp(y1 - insetY, y0 + 1, h);

    let bgCount = 0;
    let nonWhiteCount = 0;
    let purpleCount = 0;
    let occupiedCount = 0; // non-white AND NOT purple (your "true busy ink")

    for (let i = 0; i < samples; i++) {
      const x = (x0 + Math.random() * (x1 - x0)) | 0;
      const y = (y0 + Math.random() * (y1 - y0)) | 0;
      const p = _idxOf(x, y, w);

      const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];

      const isBg = isBgMatch(r, g, b, bg);
      const isPurple = isPurpleMatch(r, g, b, purple);
      const isNonWhite = !_isNearWhite(r, g, b);

      if (isBg) bgCount++;
      if (isNonWhite) nonWhiteCount++;
      if (isPurple) purpleCount++;

      // occupied = ink that isn't purple (i.e. class/typing/real busy)
      if (isNonWhite && !isPurple && !isBg) occupiedCount++;
    }

    const bgFrac = bgCount / samples;
    const inkFrac = nonWhiteCount / samples;
    const purpleFrac = purpleCount / samples;
    const occupiedFrac = occupiedCount / samples;

    // ✅ Hybrid rule: if >=50% occupied (non-purple), call it busy
    if (occupiedFrac >= busyFracMin) {
      return {
        ok: true,
        free: false,
        bgFrac: Math.round(bgFrac * 1000) / 1000,
        inkFrac: Math.round(inkFrac * 1000) / 1000,
        purpleFrac: Math.round(purpleFrac * 1000) / 1000,
        occupiedFrac: Math.round(occupiedFrac * 1000) / 1000,
        samples
      };
    }

    // Otherwise fall back to your bgFrac-first logic
    const free =
      (bgFrac >= bgFracMin) ||
      (bgFrac >= 0.55 && inkFrac <= inkFracMax);

    return {
      ok: true,
      free,
      bgFrac: Math.round(bgFrac * 1000) / 1000,
      inkFrac: Math.round(inkFrac * 1000) / 1000,
      purpleFrac: Math.round(purpleFrac * 1000) / 1000,
      occupiedFrac: Math.round(occupiedFrac * 1000) / 1000,
      samples
    };
  }

  // Optional “spill” check (deterministic, prefix-based)
  function detectGridSpill(pre, slotBand, dayRegion, opts = {}) {
    const {
      insetX = 8,
      insetY = 2,
      edgeStripeW = 8,
      hStripeH = 4,
      centerNonWhiteMax = 0.10,
      edgeNonWhiteMin = 0.25,
      hStripeNonWhiteMin = 0.22,
    } = opts;

    if (!pre?.whiteP || !Number.isFinite(pre.W)) return { ok: false, spill: false, reason: "no prefix" };
    const { w, h } = pre;

    let x0 = _clamp(Math.floor(dayRegion.x0), 0, w - 1);
    let x1 = _clamp(Math.floor(dayRegion.x1), x0 + 1, w);
    let y0 = _clamp(Math.floor(slotBand.yStart), 0, h - 1);
    let y1 = _clamp(Math.floor(slotBand.yEnd), y0 + 1, h);

    const ix0 = _clamp(x0 + insetX, 0, w - 1);
    const ix1 = _clamp(x1 - insetX, ix0 + 1, w);
    const iy0 = _clamp(y0 + insetY, 0, h - 1);
    const iy1 = _clamp(y1 - insetY, iy0 + 1, h);

    const cxPad = Math.max(10, Math.floor((ix1 - ix0) * 0.18));
    const cyPad = Math.max(4, Math.floor((iy1 - iy0) * 0.18));

    const cx0 = _clamp(ix0 + cxPad, 0, w - 1);
    const cx1 = _clamp(ix1 - cxPad, cx0 + 1, w);
    const cy0 = _clamp(iy0 + cyPad, 0, h - 1);
    const cy1 = _clamp(iy1 - cyPad, cy0 + 1, h);

    const lx0 = ix0;
    const lx1 = _clamp(ix0 + edgeStripeW, lx0 + 1, ix1);
    const rx1 = ix1;
    const rx0 = _clamp(ix1 - edgeStripeW, ix0, rx1 - 1);

    const ty0 = iy0;
    const ty1 = _clamp(iy0 + hStripeH, ty0 + 1, iy1);
    const by1 = iy1;
    const by0 = _clamp(iy1 - hStripeH, iy0, by1 - 1);

    const centerNW = rectNonWhiteFrac(pre, cx0, cy0, cx1, cy1);
    const leftNW   = rectNonWhiteFrac(pre, lx0, iy0, lx1, iy1);
    const rightNW  = rectNonWhiteFrac(pre, rx0, iy0, rx1, iy1);
    const topNW    = rectNonWhiteFrac(pre, ix0, ty0, ix1, ty1);
    const botNW    = rectNonWhiteFrac(pre, ix0, by0, ix1, by1);

    const edgeSpill = (centerNW <= centerNonWhiteMax) && (Math.max(leftNW, rightNW) >= edgeNonWhiteMin);
    const hSpill    = (centerNW <= centerNonWhiteMax) && (Math.max(topNW, botNW) >= hStripeNonWhiteMin);

    return { ok: true, spill: !!(edgeSpill || hSpill), meta: { centerNW, leftNW, rightNW, topNW, botNW } };
  }

  // If you already have trimDayRegionByDivider(), we’ll use it; else fallback inset-only.
  function safeTrimDayRegion(region, dividerXs, insetPx = 6) {
    if (typeof window.trimDayRegionByDivider === "function") {
      try { return window.trimDayRegionByDivider(region, dividerXs, insetPx); } catch {}
    }
    if (!region) return region;
    const x0 = Math.round((region.x0 ?? 0) + insetPx);
    const x1 = Math.round((region.x1 ?? 0) - insetPx);
    if (x1 <= x0 + 4) return region;
    return { ...region, x0, x1 };
  }
  
  /**
   * ✅ THE MISSING FUNCTION
   * Returns:
   *   { ok:true, avail:{ days:{Monday:[bool...]...}, meta:{...} } }
   */
  function computeAvailFromFrozenNav(pre, nav, opts = {}) {
    const spillPolicy = opts.spillPolicy || "none"; // "softFree" supported

    // You can override thresholds here if needed
    const classifyOpts = {
      ...(opts.classify || {}),
      // default hybrid rule if not provided
      busyFracMin: (opts.classify?.busyFracMin ?? 0.50),
    };

    const dayRegions = nav?.dayRegions;
    const slotBands  = nav?.slotBands;
    const bg         = nav?.bgWhite || nav?.bg; // naming drift safe
    const dividerXs  = nav?.dividerXs || window.__DIV_XS__ || null;

    if (!pre?.imgData || !Number.isFinite(pre.w) || !Number.isFinite(pre.h)) {
      return { ok: false, reason: "bad pre (missing imgData/w/h)" };
    }
    if (!dayRegions || !slotBands || !Array.isArray(slotBands) || slotBands.length < 1) {
      return { ok: false, reason: "bad nav (missing dayRegions/slotBands)" };
    }
    if (!bg || !Number.isFinite(bg.r) || !Number.isFinite(bg.g) || !Number.isFinite(bg.b)) {
      return { ok: false, reason: "missing bg/bgWhite in nav" };
    }

    const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const daysOut = {};
    const workDaysOut = {}; // ✅ will be filled now

    for (const day of WEEKDAYS) {
      const rawRegion = dayRegions[day];
      if (!rawRegion) {
        daysOut[day] = [];
        workDaysOut[day] = []; // keep shape consistent
        continue;
      }

      // divider-safe trim
      const region = safeTrimDayRegion(rawRegion, dividerXs, 6);

      const arr = new Array(slotBands.length);
      const workArr = new Array(slotBands.length);

      for (let i = 0; i < slotBands.length; i++) {
        const slot = slotBands[i];

        // --- purple work detection ---
        const purpleFrac = measurePurpleFrac(pre, slot, region, {
          samples: 160,
          insetX: 8,
          insetY: 2
        });

        // threshold: if >= 0.18, treat as PLACEMENT
        const isWork = purpleFrac >= 0.18;
        workArr[i] = isWork;

        // ✅ Spec: PLACEMENT counts as available (but labeled separately in workDays)
        if (isWork) {
          arr[i] = true;   // available
          continue;
        }

        const base = classifySlotSample(pre, slot, region, bg, classifyOpts);

        let free = false;
        if (!base.ok) {
          // conservative: if we can’t classify, mark busy
          free = false;
        } else {
          free = !!base.free;

          // spillPolicy: if “busy” but looks like grid/divider spill, treat as free
          if (!free && spillPolicy === "softFree") {
            const spill = detectGridSpill(pre, slot, region, { insetX: 8, insetY: 2 });
            if (spill.ok && spill.spill) free = true;
          }
        }

        arr[i] = free;
      }

      daysOut[day] = arr;

      // ✅ THIS WAS YOUR MISSING LINE:
      workDaysOut[day] = workArr;
    }

    const slotCount = Array.isArray(slotBands) ? slotBands.length : 0;

    return {
      ok: true,
      avail: {
        version: 1,
        anchorStartTime: nav.anchorStartTime || "8:00 AM",
        slots: slotCount,
        days: daysOut,
        workDays: workDaysOut, // ✅ now populated
        meta: {
          spillPolicy,
          slots: slotCount,
          // helpful to remember the hybrid rule used
          busyFracMin: classifyOpts.busyFracMin
        }
      }
    };
  }

  // Export for upload.js
  window.computeAvailFromFrozenNav = computeAvailFromFrozenNav;

  console.log("STACK J_EXPORT: computeAvailFromFrozenNav installed", {
    hasFn: typeof window.computeAvailFromFrozenNav === "function"
  });
})();

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
    M_setDisabled(
      M.addScheduleButton,
      true,
      `Add Schedule blocked — missing: ${g.missing.join(", ")}`
    );
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
    // keep your existing error bubble path if you have one
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
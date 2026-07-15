/*************************
 * STORAGE.JS — localStorage schedule records, IndexedDB preview
 * blobs, and the cross-schedule query engine
 * Depends on: time.js (uses populateTimes indirectly via callers),
 *             session.js (window.SAD_registerLiveSrc / __SAD_SESSION__)
 * Loaded on: upload.html, query.html
 *************************/

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

    // ✅ Three-tier result buckets (replaces old single "available" list)
    // Tier 1: available        — free time only, no placement overlap in window
    // Tier 2: availablePlacement — has BOTH free time and placement overlap (mixed)
    // Tier 3: placement        — placement overlap only, zero free time in window
    const available = [];
    const availablePlacement = [];
    const placement = [];
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
      // ✅ Route into the correct tier
      const hasFree = freeRanges.length > 0;
      const hasWork = workRanges.length > 0;

      if (hasFree && !hasWork) {
        available.push({ person, freeRanges, workRanges });
      } else if (hasFree && hasWork) {
        availablePlacement.push({ person, freeRanges, workRanges });
      } else if (!hasFree && hasWork) {
        placement.push({ person, freeRanges, workRanges });
      } else {
        skipped.push({ person, reason: "No free or placement time in range" });
      }
    }

    // Alphabetical sort within each tier (Q1b default)
    function byPersonAsc(a, b) {
      return String(a.person).localeCompare(String(b.person), undefined, { sensitivity: "base" });
    }
    available.sort(byPersonAsc);
    availablePlacement.sort(byPersonAsc);
    placement.sort(byPersonAsc);

    return {
      ok: true,
      day, startStr, endStr,
      available,            // tier 1
      availablePlacement,   // tier 2
      placement,            // tier 3
      skipped
    };
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
  //TODO: clear everything when uploaded, including the snapshot that   // is left over from the previous person
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
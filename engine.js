/*************************
 * ENGINE.JS — image-parsing pipeline: tick detection, day-divider
 * detection, slot bands, background/purple calibration, frozen nav
 * + availability builder
 * Depends on: session.js (WEEKDAYS), storage.js (setUploadStatus
 *             uses no storage fns directly, but is called by upload.js
 *             after storage ops)
 * Loaded on: upload.html ONLY
 *************************/

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
    const ok =
      nonWhiteFrac >= minNonWhiteFrac &&
      Number.isFinite(darkFrac) &&
      darkFrac <= maxDarkFrac;

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
    // But do NOT accept a candidate too close to the image bottom; that is often the frame/border.
    const snapWinTerm = clamp(Math.round(dy * 0.7), 10, 28);
    const bottomMarginPx = clamp(Math.round(dy * 0.7), 12, 24);

    const laneBest = findBestLaneMarkNearY(pre, expected, {
      lane: window.__TICK_LANE__ || null,
      bandH: 14,
      minNonWhiteFrac: 0.05,
      snapWin: snapWinTerm
    });

    const tooCloseToBottom =
      !!laneBest && 
      Number.isFinite(laneBest.y) && 
      laneBest.rect.y1 >= (pre.h - bottomMarginPx);

    console.log("STACK G2+: laneBest", {
      expected: Math.round(expected),
      snapWin,
      snapWinTerm,
      bottomMarginPx,
      tickLane: window.__TICK_LANE__ || null,
      laneBest,
      tooCloseToBottom
    });

    if (
      laneBest &&
      Math.abs(laneBest.y - expected) <= snapWinTerm &&
      !tooCloseToBottom
    ) {
      out.push(Math.round(laneBest.y));
      console.log("STACK G2+: appended terminal tick from left lane (NONWHITE)", {
        y: Math.round(laneBest.y),
        nonWhiteFrac: laneBest.nonWhiteFrac,
        rect: laneBest.rect,
        snapWinTerm,
        bottomMarginPx
      });
    } else if (laneBest && tooCloseToBottom) {
      console.log("STACK G2+: rejected terminal tick near bottom border", {
        y: Math.round(laneBest.y),
        preH: pre.h,
        bottomMarginPx,
        cutoff: pre.h - bottomMarginPx
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

    // NEW: retry nearby horizontal bands only if baseline fails
    retryOffsets = [0, -60, 60],
  } = opts;

  if (!pre?.whiteP || !pre?.darkP || !Number.isFinite(pre.w) || !Number.isFinite(pre.h)) {
    return { ok: false, reason: "missing pre requisites", xs: [], divs: [] };
  }

  const baseYCenter = pickDayBandY(pre, vTicks);

  const w = pre.w;
  const xStart = Math.floor(w * xStartFrac);
  const xEnd   = Math.floor(w * xEndFrac);

  function attemptAtY(yCenter) {
    yCenter = clamp(Math.floor(yCenter), 0, pre.h - 1);

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

  let lastFail = null;

  for (const off of retryOffsets) {
    const yTry = baseYCenter + off;
    const r = attemptAtY(yTry);

    console.log("STACK H_RETRY: divider band attempt", {
      baseYCenter,
      offset: off,
      yTry: clamp(Math.floor(yTry), 0, pre.h - 1),
      ok: !!r?.ok,
      reason: r?.reason || "",
      xs: r?.xs || []
    });

    if (r?.ok) {
      if (off !== 0) {
        console.log("STACK H_RETRY: recovered divider band", {
          baseYCenter,
          recoveredOffset: off,
          recoveredYCenter: r.yCenter,
          xs: r.xs
        });
      }
      return r;
    }

    lastFail = r;
  }

  return lastFail || {
    ok: false,
    reason: "divider band retry failed",
    yCenter: baseYCenter,
    xs: [],
    divs: []
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

  // 1) pick tick lane (base guess only)
  const baseLane = pickBestTickLane(pre);

  // Retry only on weak first attempt (Option B)
  const laneShiftFracs = [0.010, 0.020, 0.030];

  function scoreValidatedAttempt(rawTicks, v, lane) {
    const validatedCount = Array.isArray(v?.ticks) ? v.ticks.length : 0;

    let giantGapCount = 0;
    let maxGap = 0;
    if (Array.isArray(v?.ticks) && Number.isFinite(v?.dy) && v.ticks.length >= 2) {
      for (let i = 1; i < v.ticks.length; i++) {
        const d = v.ticks[i] - v.ticks[i - 1];
        if (Number.isFinite(d)) {
          if (d > maxGap) maxGap = d;
          if (d > 6 * v.dy) giantGapCount++;
        }
      }
    }

    const lastTick = validatedCount ? v.ticks[validatedCount - 1] : -Infinity;

    const score =
      (v?.ok ? 100000 : 0) +
      validatedCount * 1000 +
      (Array.isArray(rawTicks) ? rawTicks.length : 0) * 10 +
      Math.max(0, Math.floor(lastTick)) -
      giantGapCount * 5000 -
      Math.max(0, maxGap);

    return {
      score,
      validatedCount,
      giantGapCount,
      maxGap,
      lastTick
    };
  }

  function runLaneAttempt(trialLane, shiftLabel = 0) {
    const rawTicksTrial = detectTimeTicksFromLeftLane(pre, trialLane);
    const vTrial = validateTicksFromFirst(rawTicksTrial);
    const quality = scoreValidatedAttempt(rawTicksTrial, vTrial, trialLane);

    return {
      shift: shiftLabel,
      lane: trialLane,
      rawTicks: rawTicksTrial,
      v: vTrial,
      quality
    };
  }

  function isWeakAttempt(attempt) {
    if (!attempt?.v?.ok) return true;
    if ((attempt?.quality?.validatedCount || 0) < 10) return true;
    return false;
  }

  // ----------------------------
  // BASELINE ATTEMPT (always run)
  // ----------------------------
  let bestAttempt = runLaneAttempt(baseLane, 0);

  console.log("STACK F_RETRY: baseline attempt", {
    shift: 0,
    lane: bestAttempt.lane,
    rawCount: bestAttempt.rawTicks?.length || 0,
    vOk: !!bestAttempt.v?.ok,
    dy: bestAttempt.v?.dy,
    validatedCount: bestAttempt.quality.validatedCount,
    giantGapCount: bestAttempt.quality.giantGapCount,
    maxGap: bestAttempt.quality.maxGap,
    lastTick: bestAttempt.quality.lastTick,
    score: bestAttempt.quality.score,
    weak: isWeakAttempt(bestAttempt)
  });

  // ----------------------------
  // CONDITIONAL RETRY (Option B)
  // Only if baseline looks weak
  // ----------------------------
  if (isWeakAttempt(bestAttempt)) {
    console.log("STACK F_RETRY: entering recovery mode", {
      reason: !bestAttempt.v?.ok
        ? "validator not ok"
        : `validatedCount=${bestAttempt.quality.validatedCount} < 10`
    });

    for (const shift of laneShiftFracs) {
      const trialLane = {
        x0Frac: clamp(baseLane.x0Frac + shift, 0, 0.95),
        x1Frac: clamp(baseLane.x1Frac + shift, 0.01, 0.99),
      };

      if (trialLane.x1Frac <= trialLane.x0Frac) continue;

      const attempt = runLaneAttempt(trialLane, shift);

      console.log("STACK F_RETRY: recovery lane attempt", {
        shift,
        lane: trialLane,
        rawCount: attempt.rawTicks?.length || 0,
        vOk: !!attempt.v?.ok,
        dy: attempt.v?.dy,
        validatedCount: attempt.quality.validatedCount,
        giantGapCount: attempt.quality.giantGapCount,
        maxGap: attempt.quality.maxGap,
        lastTick: attempt.quality.lastTick,
        score: attempt.quality.score
      });

      if (attempt.quality.score > bestAttempt.quality.score) {
        bestAttempt = attempt;
      }

      // early stop if recovery finds a clearly healthy ladder
      if (attempt.v?.ok && attempt.quality.validatedCount >= 14 && attempt.quality.giantGapCount === 0) {
        bestAttempt = attempt;
        break;
      }
    }
  }

  if (!bestAttempt) {
    console.warn("NAV: bail @laneAttempts (no attempt produced output)");
    return null;
  }

  const lane = bestAttempt.lane;
  const rawTicks = bestAttempt.rawTicks;
  const v = bestAttempt.v;

  console.log("STACK F_RETRY: chosen attempt", {
    shift: bestAttempt.shift,
    lane,
    rawCount: rawTicks?.length || 0,
    vOk: !!v?.ok,
    dy: v?.dy,
    validatedCount: v?.ticks?.length || 0,
    giantGapCount: bestAttempt.quality.giantGapCount,
    maxGap: bestAttempt.quality.maxGap,
    lastTick: bestAttempt.quality.lastTick,
    score: bestAttempt.quality.score
  });

  // Store pixel lane for terminal tick fallback helper (in-memory only)
  window.__TICK_LANE__ = {
    x0: Math.floor(pre.w * lane.x0Frac),
    x1: Math.floor(pre.w * lane.x1Frac),
    x0Frac: lane.x0Frac,
    x1Frac: lane.x1Frac
  };

  if (!Array.isArray(rawTicks) || rawTicks.length < 2) {
    console.warn("NAV: bail @rawTicks", { rawLen: rawTicks?.length, lane });
    return null;
  }

  // 3) validate ticks (walk down; no phantom rows)
  if (!v?.ok || !Array.isArray(v.ticks) || v.ticks.length < 2) {
    console.warn("NAV: bail @validateTicksFromFirst", { rawLen: rawTicks.length, v, lane });
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

  const xs = divRes.xs;

  const normXs =
    xs.length === 6
      ? xs
      : xs.slice(1, 7);

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
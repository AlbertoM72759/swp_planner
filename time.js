/*************************
 * TIME.JS — time string <-> minutes helpers, <select> populator
 * Depends on: nothing
 * Loaded on: upload.html, query.html
 *************************/

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
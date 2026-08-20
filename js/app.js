"use strict";

/* ---------------------------------------------------------------------- *
 *  Time helpers — everything is computed in Europe/Athens local time,
 *  regardless of the visitor's own timezone.
 * ---------------------------------------------------------------------- */

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAMES_EL = ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"];

const athensFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Athens",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  weekday: "short", hour12: false,
});

function athensParts(date = new Date()) {
  const parts = {};
  for (const p of athensFormatter.formatToParts(date)) parts[p.type] = p.value;
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    weekdayNum: WEEKDAY_MAP[parts.weekday],
  };
}

function cmpDateParts(a, b) {
  const ka = [a.year, a.month, a.day, a.hour, a.minute];
  const kb = [b.year, b.month, b.day, b.hour, b.minute];
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

function isExtensionActive(parts) {
  return cmpDateParts(parts, EXTENSION_OPENING) >= 0;
}

function daysUntilExtension(parts) {
  const now = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const open = new Date(Date.UTC(EXTENSION_OPENING.year, EXTENSION_OPENING.month - 1, EXTENSION_OPENING.day));
  return Math.round((open - now) / 86400000);
}

function decHour(t) { return t.hour + t.minute / 60; }
function closeDecHour(dow) { return decHour(SCHEDULE.closeTimeByWeekday[dow]); }
const OPEN_DEC = decHour(SCHEDULE.openTime);

function fmtHM(dec) {
  let h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  let mm = m;
  let hh = h;
  if (mm === 60) { mm = 0; hh += 1; }
  const overflowDay = hh >= 24;
  hh = hh % 24;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}${overflowDay ? " (+1)" : ""}`;
}

/* ---------------------------------------------------------------------- *
 *  Line topology — a Y: shared trunk, then branch A (Νέα Ελβετία, live) or
 *  branch B (Kalamaria extension, opens 27/08/2026), forking at "25ης Μαρτίου".
 * ---------------------------------------------------------------------- */

const TRUNK = STATIONS.filter((s) => s.branch === "trunk");
const BRANCH_A = STATIONS.filter((s) => s.branch === "A");
const BRANCH_B = STATIONS.filter((s) => s.branch === "B");
const JUNCTION = TRUNK[TRUNK.length - 1];
const PATH_A = [JUNCTION, ...BRANCH_A];
const PATH_B = [JUNCTION, ...BRANCH_B];
const WEST_TERMINUS = TRUNK[0];
const TERMINUS_A = BRANCH_A[BRANCH_A.length - 1];
const TERMINUS_B = BRANCH_B[BRANCH_B.length - 1];

const TRUNK_H = SCHEDULE.trunkTimeMin / 60;
const BRANCH_H = { A: SCHEDULE.branchTimeMin.A / 60, B: SCHEDULE.branchTimeMin.B / 60 };
const TURN_H = SCHEDULE.turnaroundMin / 60;

function branchArray(b) { return b === "A" ? PATH_A : PATH_B; }
function branchTerminus(b) { return b === "A" ? TERMINUS_A : TERMINUS_B; }

/* ---------------------------------------------------------------------- *
 *  Service-day resolution & headway model
 * ---------------------------------------------------------------------- */

function resolveServiceWindow(parts) {
  const nowDec = parts.hour + parts.minute / 60 + parts.second / 3600;
  const dow = parts.weekdayNum;

  if (nowDec < OPEN_DEC) {
    const prevDow = (dow + 6) % 7;
    const prevClose = closeDecHour(prevDow);
    if (prevClose > 24 && nowDec + 24 < prevClose) {
      return { open: true, dow: prevDow, dateKey: `${parts.year}-${parts.month}-${parts.day}-prev`, openDec: OPEN_DEC, closeDec: prevClose, nowDecAdj: nowDec + 24 };
    }
    return { open: false, opensAtDec: OPEN_DEC };
  }

  const close = closeDecHour(dow);
  if (nowDec > close) {
    return { open: false, opensAtDec: OPEN_DEC };
  }
  return { open: true, dow, dateKey: `${parts.year}-${parts.month}-${parts.day}`, openDec: OPEN_DEC, closeDec: close, nowDecAdj: nowDec };
}

function headwayMinutesAt(hourDec, dow) {
  const isWeekday = dow >= 1 && dow <= 5;
  if (isWeekday) {
    for (const [s, e] of SCHEDULE.peakWindowsWeekday) {
      const sh = decHour(s), eh = decHour(e);
      if (hourDec >= sh && hourDec < eh) return SCHEDULE.peakHeadwayMin;
    }
  }
  return SCHEDULE.offPeakHeadwayMin;
}

function buildDepartures(openDec, closeDec, dow) {
  const list = [];
  let t = openDec;
  let guard = 0;
  while (t <= closeDec && guard < 2000) {
    list.push(t);
    t += headwayMinutesAt(t % 24, dow) / 60;
    guard++;
  }
  return list;
}

// Departures alternate branch destination once the extension is live; before
// that every train runs the only branch that exists (A, to Νέα Ελβετία).
function branchForDeparture(index, ext) {
  if (!ext) return "A";
  return index % 2 === 0 ? "A" : "B";
}

// Full round-trip timeline for one physical train, keyed off its westbound
// (Ν. Σιδηροδρομικός Σταθμός) departure time `d`.
function journeyFor(d, branch) {
  const brH = BRANCH_H[branch];
  const eastTrunkStart = d;
  const eastTrunkEnd = d + TRUNK_H;
  const eastBranchStart = eastTrunkEnd;
  const eastBranchEnd = eastBranchStart + brH;
  const westBranchStart = eastBranchEnd + TURN_H;
  const westBranchEnd = westBranchStart + brH;
  const westTrunkStart = westBranchEnd;
  const westTrunkEnd = westTrunkStart + TRUNK_H;
  return { eastTrunkStart, eastTrunkEnd, eastBranchStart, eastBranchEnd, westBranchStart, westBranchEnd, westTrunkStart, westTrunkEnd };
}

/* ---------------------------------------------------------------------- *
 *  Map geometry
 * ---------------------------------------------------------------------- */

function catmullRomPath(points) {
  if (points.length < 2) return "";
  let d = `M ${points[0].x},${points[0].y} `;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C ${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y} `;
  }
  return d.trim();
}

function lerp(a, b, t) { return a + (b - a) * t; }

function positionAlong(points, frac) {
  const idx = Math.min(Math.max(frac, 0), 1) * (points.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(i0 + 1, points.length - 1);
  const t = idx - i0;
  return {
    x: lerp(points[i0].x, points[i1].x, t),
    y: lerp(points[i0].y, points[i1].y, t),
  };
}

/* ---------------------------------------------------------------------- *
 *  App state & rendering
 * ---------------------------------------------------------------------- */

const svgNS = "http://www.w3.org/2000/svg";
let departureCache = { key: null, list: [] };
let markerPool = [];
let selectedStationId = null;

function buildStaticMap() {
  document.getElementById("line-path-trunk").setAttribute("d", catmullRomPath(TRUNK));
  document.getElementById("line-path-a").setAttribute("d", catmullRomPath(PATH_A));
  document.getElementById("line-path-ext").setAttribute("d", catmullRomPath(PATH_B));

  const stationsLayer = document.getElementById("stations-layer");
  stationsLayer.innerHTML = "";
  STATIONS.forEach((s) => {
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "station" + (s.extension ? " station--ext" : "") + (s.junction ? " station--junction" : ""));
    g.setAttribute("data-id", s.id);
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", s.name + (s.junction ? " (διακλάδωση)" : ""));

    const hitArea = document.createElementNS(svgNS, "circle");
    hitArea.setAttribute("cx", s.x);
    hitArea.setAttribute("cy", s.y);
    hitArea.setAttribute("r", 20);
    hitArea.setAttribute("fill", "transparent");
    g.appendChild(hitArea);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", s.x);
    dot.setAttribute("cy", s.y);
    dot.setAttribute("r", s.terminus ? 9 : s.junction ? 7.5 : 6.5);
    dot.setAttribute("class", "station-dot");
    g.appendChild(dot);

    if (s.terminus || s.junction) {
      const ring = document.createElementNS(svgNS, "circle");
      ring.setAttribute("cx", s.x);
      ring.setAttribute("cy", s.y);
      ring.setAttribute("r", 14);
      ring.setAttribute("class", "station-ring" + (s.junction ? " station-ring--junction" : ""));
      g.appendChild(ring);
    }

    const labelPos = s.labelPos || (s.x > 600 ? "left" : "right");
    const label = document.createElementNS(svgNS, "text");
    const offsets = {
      right: { x: 12, y: 4, anchor: "" },
      left: { x: -12, y: 4, anchor: " station-label--left" },
      above: { x: 0, y: -14, anchor: " station-label--center" },
      below: { x: 0, y: 22, anchor: " station-label--center" },
    }[labelPos];
    label.setAttribute("x", s.x + offsets.x);
    label.setAttribute("y", s.y + offsets.y);
    label.setAttribute("class", "station-label" + offsets.anchor);
    label.textContent = s.short;
    g.appendChild(label);

    g.addEventListener("click", () => selectStation(s.id));
    g.addEventListener("keypress", (e) => { if (e.key === "Enter") selectStation(s.id); });

    stationsLayer.appendChild(g);
  });

  // Pre-create a pool of train markers reused every tick.
  const trainsLayer = document.getElementById("trains-layer");
  trainsLayer.innerHTML = "";
  markerPool = [];
  for (let i = 0; i < 40; i++) {
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "train-marker");
    g.style.opacity = "0";
    const glow = document.createElementNS(svgNS, "circle");
    glow.setAttribute("r", 11);
    glow.setAttribute("class", "train-glow");
    const core = document.createElementNS(svgNS, "circle");
    core.setAttribute("r", 5.5);
    core.setAttribute("class", "train-core");
    g.appendChild(glow);
    g.appendChild(core);
    trainsLayer.appendChild(g);
    markerPool.push(g);
  }
}

function tick() {
  const parts = athensParts();
  const sw = resolveServiceWindow(parts);
  const ext = isExtensionActive(parts);

  renderStatusBar(parts, sw);
  renderExtensionBanner(parts, ext);
  document.getElementById("metro-map").classList.toggle("map--extended", ext);

  if (!sw.open) {
    hideAllTrains();
    renderHeadwayPill(null);
    if (selectedStationId) renderStationPanel(selectedStationId, null, ext);
    requestAnimationFrame(scheduleNextTick);
    return;
  }

  if (departureCache.key !== sw.dateKey) {
    departureCache = { key: sw.dateKey, list: buildDepartures(sw.openDec, sw.closeDec, sw.dow) };
  }

  const now = sw.nowDecAdj;
  renderHeadwayPill(headwayMinutesAt(now % 24, sw.dow));
  renderTrains(departureCache.list, now, ext);

  if (selectedStationId) {
    renderStationPanel(selectedStationId, { departures: departureCache.list, now, ext }, ext);
  }

  requestAnimationFrame(scheduleNextTick);
}

let lastTickSecond = -1;
function scheduleNextTick() {
  const s = new Date().getSeconds();
  if (s !== lastTickSecond) {
    lastTickSecond = s;
    tick();
  } else {
    requestAnimationFrame(scheduleNextTick);
  }
}

function hideAllTrains() {
  for (const m of markerPool) m.style.opacity = "0";
}

// Where is a single train (departure d, branch b) right now? Returns a
// {x,y,direction} or null if it isn't running at `now`.
function trainStateAt(d, branch, now) {
  const j = journeyFor(d, branch);
  const brPoints = branchArray(branch);
  const brH = BRANCH_H[branch];

  if (now >= j.eastTrunkStart && now <= j.eastTrunkEnd) {
    const frac = (now - j.eastTrunkStart) / TRUNK_H;
    return { ...positionAlong(TRUNK, frac), direction: "east" };
  }
  if (now > j.eastTrunkEnd && now <= j.eastBranchEnd) {
    const frac = (now - j.eastBranchStart) / brH;
    return { ...positionAlong(brPoints, frac), direction: "east" };
  }
  if (now > j.eastBranchEnd && now < j.westBranchStart) {
    // Laid over at the branch terminus.
    return { ...positionAlong(brPoints, 1), direction: "east" };
  }
  if (now >= j.westBranchStart && now <= j.westBranchEnd) {
    const frac = 1 - (now - j.westBranchStart) / brH;
    return { ...positionAlong(brPoints, frac), direction: "west" };
  }
  if (now > j.westBranchEnd && now <= j.westTrunkEnd) {
    const frac = 1 - (now - j.westTrunkStart) / TRUNK_H;
    return { ...positionAlong(TRUNK, frac), direction: "west" };
  }
  return null;
}

function renderTrains(departures, now, ext) {
  let used = 0;
  for (let i = 0; i < departures.length; i++) {
    const d = departures[i];
    if (d > now) break;
    const branch = branchForDeparture(i, ext);
    const state = trainStateAt(d, branch, now);
    if (!state) continue;
    if (used >= markerPool.length) break;
    const marker = markerPool[used++];
    marker.style.transform = `translate(${state.x}px, ${state.y}px)`;
    marker.style.opacity = "1";
    marker.classList.toggle("train-marker--west", state.direction === "west");
  }
  for (let i = used; i < markerPool.length; i++) markerPool[i].style.opacity = "0";
}

function renderStatusBar(parts, sw) {
  const clockEl = document.getElementById("clock");
  clockEl.textContent = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
  document.getElementById("day-name").textContent = `${DAY_NAMES_EL[parts.weekdayNum]} · ${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;

  const statusPill = document.getElementById("status-pill");
  if (sw.open) {
    statusPill.textContent = "Ανοιχτό";
    statusPill.className = "pill pill--open";
  } else {
    statusPill.textContent = `Κλειστό · ανοίγει ${fmtHM(sw.opensAtDec)}`;
    statusPill.className = "pill pill--closed";
  }
}

function renderHeadwayPill(minutes) {
  const el = document.getElementById("headway-pill");
  if (minutes == null) {
    el.textContent = "—";
    el.className = "pill pill--muted";
    return;
  }
  const isPeak = minutes === SCHEDULE.peakHeadwayMin;
  el.textContent = `${isPeak ? "Ώρα αιχμής" : "Κανονικό ωράριο"} · ανά ${minutes}′`;
  el.className = "pill " + (isPeak ? "pill--peak" : "pill--offpeak");
}

function renderExtensionBanner(parts, ext) {
  const banner = document.getElementById("extension-banner");
  if (ext) {
    banner.textContent = "Η επέκταση προς Καλαμαριά (5 νέοι σταθμοί από 25ης Μαρτίου) είναι σε λειτουργία.";
    banner.className = "extension-banner extension-banner--live";
  } else {
    const days = daysUntilExtension(parts);
    banner.textContent = days > 0
      ? `Επέκταση Καλαμαριάς: ανοίγει σε ${days} ${days === 1 ? "ημέρα" : "ημέρες"} (27/08/2026), από τη διακλάδωση στον σταθμό 25ης Μαρτίου.`
      : "Επέκταση Καλαμαριάς: ανοίγει σήμερα.";
    banner.className = "extension-banner";
  }
}

/* ---------------------------------------------------------------------- *
 *  Station detail panel
 * ---------------------------------------------------------------------- */

function selectStation(id) {
  selectedStationId = selectedStationId === id ? null : id;
  document.querySelectorAll(".station").forEach((el) => {
    el.classList.toggle("station--selected", el.getAttribute("data-id") === selectedStationId);
  });
  document.getElementById("station-panel-empty").hidden = !!selectedStationId;
  document.getElementById("station-panel-content").hidden = !selectedStationId;
  if (selectedStationId) tick();
}

// Next `n` arrival times at `station`, split by direction. Eastbound trunk
// stations can be served by trains ultimately bound for either branch
// terminus, so eastbound is grouped by final destination.
function nextArrivals(station, n, ctx) {
  const { departures, now, ext } = ctx;
  const west = [];
  const eastByBranch = { A: [], B: [] };

  const trunkIdx = station.branch === "trunk" ? TRUNK.findIndex((s) => s.id === station.id) : -1;
  const trunkLen = TRUNK.length - 1;

  for (let i = 0; i < departures.length; i++) {
    const d = departures[i];
    const branch = branchForDeparture(i, ext);
    const brH = BRANCH_H[branch];

    if (station.branch === "trunk") {
      const eastArr = d + (trunkIdx / trunkLen) * TRUNK_H;
      const j = journeyFor(d, branch);
      const westArr = j.westBranchEnd + ((trunkLen - trunkIdx) / trunkLen) * TRUNK_H;
      if (eastArr >= now) eastByBranch[branch].push(eastArr);
      if (westArr >= now) west.push(westArr);
    } else if (station.branch === branch) {
      const pts = branchArray(branch);
      const localIdx = pts.findIndex((s) => s.id === station.id);
      const branchLen = pts.length - 1;
      const eastArr = d + TRUNK_H + (localIdx / branchLen) * brH;
      const j = journeyFor(d, branch);
      const westArr = j.westBranchStart + ((branchLen - localIdx) / branchLen) * brH;
      if (eastArr >= now) eastByBranch[branch].push(eastArr);
      if (westArr >= now) west.push(westArr);
    }
  }

  west.sort((a, b) => a - b);
  eastByBranch.A.sort((a, b) => a - b);
  eastByBranch.B.sort((a, b) => a - b);

  const eastGroups = [];
  if (eastByBranch.A.length) eastGroups.push({ label: TERMINUS_A.short, times: eastByBranch.A.slice(0, n) });
  if (ext && eastByBranch.B.length) eastGroups.push({ label: TERMINUS_B.short, times: eastByBranch.B.slice(0, n) });

  return { west: west.slice(0, n), eastGroups };
}

function renderStationPanel(id, ctx, ext) {
  const station = STATIONS.find((s) => s.id === id);
  document.getElementById("station-panel-title").textContent = station.name + (station.junction ? " · διακλάδωση" : "");

  const listsEl = document.getElementById("station-panel-lists");

  if (!ctx) {
    listsEl.innerHTML = `<p class="muted">Το δίκτυο είναι κλειστό αυτή τη στιγμή. Πρώτο δρομολόγιο στις ${fmtHM(OPEN_DEC)}.</p>`;
    return;
  }

  if (station.branch === "B" && !ext) {
    const daysNote = daysUntilExtension(athensParts());
    listsEl.innerHTML = `<p class="muted">Ο σταθμός ανήκει στην επέκταση Καλαμαριάς, που ανοίγει σε ${Math.max(daysNote, 0)} ${daysNote === 1 ? "ημέρα" : "ημέρες"} (27/08/2026).</p>`;
    return;
  }

  const fmtList = (arr, now) => arr.length
    ? arr.map((t) => `<li><span class="eta-time">${fmtHM(t % 24)}</span><span class="eta-rel">σε ${Math.max(0, Math.round((t - now) * 60))}′</span></li>`).join("")
    : `<li class="muted">Δεν υπάρχουν άλλα δρομολόγια σήμερα</li>`;

  const { west, eastGroups } = nextArrivals(station, 3, ctx);

  const eastBlocksHtml = eastGroups.length
    ? eastGroups.map((g) => `
        <div class="direction-block">
          <h4>→ προς ${g.label}</h4>
          <ul>${fmtList(g.times, ctx.now)}</ul>
        </div>
      `).join("")
    : `<div class="direction-block"><h4>→ ανατολικά</h4><ul><li class="muted">Δεν υπάρχουν άλλα δρομολόγια σήμερα</li></ul></div>`;

  listsEl.innerHTML = `
    ${eastBlocksHtml}
    <div class="direction-block">
      <h4>→ προς ${WEST_TERMINUS.short}</h4>
      <ul>${fmtList(west, ctx.now)}</ul>
    </div>
  `;
}

/* ---------------------------------------------------------------------- *
 *  Boot
 * ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  buildStaticMap();
  document.getElementById("close-panel").addEventListener("click", () => selectStation(selectedStationId));
  requestAnimationFrame(scheduleNextTick);
});

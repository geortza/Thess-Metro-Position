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

function positionAlong(stations, frac) {
  const idx = Math.min(Math.max(frac, 0), 1) * (stations.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(i0 + 1, stations.length - 1);
  const t = idx - i0;
  return {
    x: lerp(stations[i0].x, stations[i1].x, t),
    y: lerp(stations[i0].y, stations[i1].y, t),
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
  const svg = document.getElementById("metro-map");
  const baseStations = STATIONS.filter((s) => !s.extension);
  const allStations = STATIONS;

  const linePath = document.getElementById("line-path-base");
  linePath.setAttribute("d", catmullRomPath(baseStations));

  const extPoints = STATIONS.slice(baseStations.length - 1); // include junction point
  const extPath = document.getElementById("line-path-ext");
  extPath.setAttribute("d", catmullRomPath(extPoints));

  const stationsLayer = document.getElementById("stations-layer");
  stationsLayer.innerHTML = "";
  allStations.forEach((s, idx) => {
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "station" + (s.extension ? " station--ext" : ""));
    g.setAttribute("data-id", s.id);
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", s.name);

    const hitArea = document.createElementNS(svgNS, "circle");
    hitArea.setAttribute("cx", s.x);
    hitArea.setAttribute("cy", s.y);
    hitArea.setAttribute("r", 20);
    hitArea.setAttribute("fill", "transparent");
    hitArea.setAttribute("class", "station-hit");
    g.appendChild(hitArea);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", s.x);
    dot.setAttribute("cy", s.y);
    dot.setAttribute("r", s.terminus ? 9 : 6.5);
    dot.setAttribute("class", "station-dot");
    g.appendChild(dot);

    if (s.terminus) {
      const ring = document.createElementNS(svgNS, "circle");
      ring.setAttribute("cx", s.x);
      ring.setAttribute("cy", s.y);
      ring.setAttribute("r", 14);
      ring.setAttribute("class", "station-ring");
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

function currentActiveStations(ext) {
  return ext ? STATIONS : STATIONS.filter((s) => !s.extension);
}

function tick() {
  const parts = athensParts();
  const sw = resolveServiceWindow(parts);
  const ext = isExtensionActive(parts);

  renderStatusBar(parts, sw, ext);
  renderExtensionBanner(parts, ext);

  const activeStations = currentActiveStations(ext);
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

  const travelDec = (ext ? SCHEDULE.travelTimeMinExtended : SCHEDULE.travelTimeMinBase) / 60;
  const now = sw.nowDecAdj;
  const currentHeadway = headwayMinutesAt(now % 24, sw.dow);
  renderHeadwayPill(currentHeadway);

  const activeTrains = [];
  for (const d of departureCache.list) {
    if (d > now) break;
    if (now > d + travelDec) continue;
    const frac = (now - d) / travelDec;
    activeTrains.push({ direction: "east", frac });
    activeTrains.push({ direction: "west", frac });
  }
  renderTrains(activeTrains, activeStations);

  if (selectedStationId) renderStationPanel(selectedStationId, { departures: departureCache.list, now, travelDec, activeStations }, ext);

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

function renderTrains(trains, activeStations) {
  trains.forEach((tr, i) => {
    if (i >= markerPool.length) return;
    const marker = markerPool[i];
    const eastFrac = tr.direction === "east" ? tr.frac : 1 - tr.frac;
    const pos = positionAlong(activeStations, eastFrac);
    marker.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    marker.style.opacity = "1";
    marker.setAttribute("data-dir", tr.direction);
    marker.classList.toggle("train-marker--west", tr.direction === "west");
  });
  for (let i = trains.length; i < markerPool.length; i++) {
    markerPool[i].style.opacity = "0";
  }
}

function renderStatusBar(parts, sw, ext) {
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
    banner.textContent = "Η επέκταση προς Καλαμαριά (5 νέοι σταθμοί) είναι σε λειτουργία.";
    banner.className = "extension-banner extension-banner--live";
  } else {
    const days = daysUntilExtension(parts);
    banner.textContent = days > 0
      ? `Επέκταση Καλαμαριάς: ανοίγει σε ${days} ${days === 1 ? "ημέρα" : "ημέρες"} (27/08/2026).`
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

function nextArrivals(stationIndex, n, ctx) {
  const { departures, now, travelDec, activeStations } = ctx;
  const N = activeStations.length;
  const east = [], west = [];
  for (const d of departures) {
    const eastArrival = d + (stationIndex / (N - 1)) * travelDec;
    const westArrival = d + ((N - 1 - stationIndex) / (N - 1)) * travelDec;
    if (eastArrival >= now) east.push(eastArrival);
    if (westArrival >= now) west.push(westArrival);
  }
  east.sort((a, b) => a - b);
  west.sort((a, b) => a - b);
  return { east: east.slice(0, n), west: west.slice(0, n) };
}

function renderStationPanel(id, ctx, ext) {
  const station = STATIONS.find((s) => s.id === id);
  const panel = document.getElementById("station-panel");
  const activeStations = ctx ? ctx.activeStations : currentActiveStations(ext);
  const idx = activeStations.findIndex((s) => s.id === id);

  document.getElementById("station-panel-title").textContent = station.name;

  const eastTerm = activeStations[activeStations.length - 1];
  const westTerm = activeStations[0];

  const listsEl = document.getElementById("station-panel-lists");
  if (!ctx || idx === -1) {
    listsEl.innerHTML = `<p class="muted">Το δίκτυο είναι κλειστό αυτή τη στιγμή. Πρώτο δρομολόγιο στις ${fmtHM(OPEN_DEC)}.</p>`;
    return;
  }

  const { east, west } = nextArrivals(idx, 3, ctx);
  const fmtList = (arr, now) => arr.length
    ? arr.map((t) => `<li><span class="eta-time">${fmtHM(t % 24)}</span><span class="eta-rel">σε ${Math.max(0, Math.round((t - now) * 60))}′</span></li>`).join("")
    : `<li class="muted">Δεν υπάρχουν άλλα δρομολόγια σήμερα</li>`;

  listsEl.innerHTML = `
    <div class="direction-block">
      <h4>→ προς ${eastTerm.short}</h4>
      <ul>${fmtList(east, ctx.now)}</ul>
    </div>
    <div class="direction-block">
      <h4>→ προς ${westTerm.short}</h4>
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

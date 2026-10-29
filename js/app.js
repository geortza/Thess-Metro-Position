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

const NE_TO_NSS_H = BRANCH_H.A + TRUNK_H; // Νέα Ελβετία -> Ν.Σ.Σ. travel time

function branchArray(b) { return b === "A" ? PATH_A : PATH_B; }

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

// Which day-type headway profile applies: Κυριακή has its own, Σάββατο has
// its own, Δευτέρα-Παρασκευή share one (closing time still differs Fri).
function headwayProfileFor(dow) {
  if (dow === 0) return SCHEDULE.headwayBands.sunday;
  if (dow === 6) return SCHEDULE.headwayBands.saturday;
  return SCHEDULE.headwayBands.weekday;
}

// Official THEMA timetable: trunk headway (minutes) for the given moment,
// plus whether it's the early (05:15-07:30) or main (07:30-close) band.
function headwayMinutesAt(hourDec, dow) {
  const profile = headwayProfileFor(dow);
  const early = hourDec < SCHEDULE.bandBoundaryHour;
  return { minutes: early ? profile.early : profile.main, early };
}

// Trains inserted from the Νέα Ελβετία depot in the minutes before the
// 07:30 step-up from the early to the main timetable band: each entry is
// { leaveNE, arriveNSS }. They travel branch A + trunk west to
// Ν. Σιδηροδρομικός Σταθμός and from `arriveNSS` on are indistinguishable
// from a regular departure — buildDepartures merges that arrival time
// straight into the main list, so all downstream logic (journeyFor, branch
// assignment, station arrivals) treats them identically from then on.
function buildRampInsertions(openDec, closeDec, dow) {
  const inserts = [];
  const profile = headwayProfileFor(dow);
  const rampH = SCHEDULE.rampMinutes / 60;
  const boundary = SCHEDULE.bandBoundaryHour;
  const rampStart = boundary - rampH;
  let t = Math.max(rampStart, openDec);
  let guard = 0;
  while (t < boundary && t <= closeDec && guard < 200) {
    const frac = Math.min(Math.max((t - rampStart) / rampH, 0), 1);
    const headway = lerp(profile.early, profile.main, frac);
    inserts.push({ leaveNE: t, arriveNSS: t + NE_TO_NSS_H });
    t += headway / 60;
    guard++;
  }
  return inserts;
}

function buildDepartures(openDec, closeDec, dow) {
  const list = [];
  let t = openDec;
  let guard = 0;
  while (t <= closeDec && guard < 4000) {
    list.push(t);
    t += headwayMinutesAt(t % 24, dow).minutes / 60;
    guard++;
  }
  const ramp = buildRampInsertions(openDec, closeDec, dow);
  for (const r of ramp) list.push(r.arriveNSS);
  list.sort((a, b) => a - b);
  return { list, ramp };
}

// Confirmed real-world split once the extension is live: of every 3 trains
// heading east, 2 go to the Kalamaria extension (branch B) and 1 to Νέα
// Ελβετία (branch A). Before that, every train runs the only branch that
// exists (A, to Νέα Ελβετία).
function branchForDeparture(index, ext) {
  if (!ext) return "A";
  return index % 3 === 0 ? "A" : "B";
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
 *  Real-map geometry helpers (interpolate along consecutive stations'
 *  actual lat/lng — a straight-line approximation between real stops).
 * ---------------------------------------------------------------------- */

function lerp(a, b, t) { return a + (b - a) * t; }

function positionAlong(points, frac) {
  const idx = Math.min(Math.max(frac, 0), 1) * (points.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(i0 + 1, points.length - 1);
  const t = idx - i0;
  return {
    lat: lerp(points[i0].lat, points[i1].lat, t),
    lng: lerp(points[i0].lng, points[i1].lng, t),
  };
}

// Compass bearing (0=N, 90=E, clockwise) between two lat/lng points.
function bearingDeg(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lng2 - lng1) * rad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// Bearing of the station-to-station segment a train at `frac` along `points`
// is currently riding — picks the same segment as positionAlong, so the two
// always agree on where the train is pointed.
function bearingAlong(points, frac) {
  const idx = Math.min(Math.max(frac, 0), 1) * (points.length - 1);
  let i0 = Math.floor(idx);
  let i1 = Math.min(i0 + 1, points.length - 1);
  if (i0 === i1) i0 = Math.max(i0 - 1, 0); // at the very end: reuse the final segment
  return bearingDeg(points[i0].lat, points[i0].lng, points[i1].lat, points[i1].lng);
}

/* ---------------------------------------------------------------------- *
 *  Map (Leaflet, real OpenStreetMap-based tiles)
 * ---------------------------------------------------------------------- */

let map;
const stationMarkers = {};
let markerPool = [];
let selectedStationId = null;
let panelOpenerEl = null;
const linePolylines = {};

const TOOLTIP_OFFSET = {
  right: [12, 0], left: [-12, 0], top: [0, -10], bottom: [0, 12],
};

function buildMap() {
  map = L.map("metro-map", { zoomControl: false, scrollWheelZoom: true, minZoom: 11, maxZoom: 18 });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // CARTO's basemap now requires a (free) API key and stamps a watermark on
  // keyless requests, so use Esri's World Light Gray Canvas instead — no key
  // needed. It ships as two stacked raster layers: solid base colors, then
  // roads/labels on top.
  L.tileLayer("https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: 'Basemap &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS',
    maxNativeZoom: 16,
    maxZoom: 19,
  }).addTo(map);
  L.tileLayer("https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: 16,
    maxZoom: 19,
  }).addTo(map);

  const bounds = L.latLngBounds(STATIONS.map((s) => [s.lat, s.lng]));
  map.fitBounds(bounds, { padding: [36, 36] });

  linePolylines.trunk = L.polyline(TRUNK.map((s) => [s.lat, s.lng]), {
    color: "#0ea99b", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round",
    className: "line-glow",
  }).addTo(map);
  linePolylines.a = L.polyline(PATH_A.map((s) => [s.lat, s.lng]), {
    color: "#2f6fe0", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round",
    className: "line-glow",
  }).addTo(map);
  linePolylines.ext = L.polyline(PATH_B.map((s) => [s.lat, s.lng]), {
    color: "#c97a12", weight: 4, opacity: 0.6, dashArray: "2 10", lineCap: "round", lineJoin: "round",
    className: "line-glow",
  }).addTo(map);
  setGlowColor(linePolylines.trunk, "rgba(14,169,155,0.6)");
  setGlowColor(linePolylines.a, "rgba(47,111,224,0.6)");
  setGlowColor(linePolylines.ext, "rgba(201,122,18,0.5)");

  STATIONS.forEach((s) => {
    const big = s.terminus || s.junction;
    const icon = L.divIcon({
      className: "station-marker" + (s.extension ? " station-marker--ext" : "") + (s.junction ? " station-marker--junction" : ""),
      html: `<span class="station-dot${big ? " station-dot--big" : ""}"></span>${big ? '<span class="station-ring"></span>' : ""}`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    const marker = L.marker([s.lat, s.lng], { icon, keyboard: true, alt: s.name, riseOnHover: true });
    marker.addTo(map);
    const el = marker.getElement();
    if (el) {
      // L.divIcon's element is a plain <div>, so Leaflet's `alt` option (meant
      // for <img>-based icons) has no effect here — set an explicit
      // accessible name instead.
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", s.name + (s.junction ? " (διακλάδωση)" : ""));
    }
    const dir = s.labelPos || "right";
    marker.bindTooltip(s.short, {
      permanent: false, direction: dir, className: "station-tooltip", offset: TOOLTIP_OFFSET[dir] || [12, 0],
    });
    marker.on("click", () => selectStation(s.id, el));
    marker.on("keypress", (e) => { if (e.originalEvent.key === "Enter") selectStation(s.id, el); });
    stationMarkers[s.id] = marker;
  });

  // Real station spacing is a few hundred metres, so permanent labels only
  // make sense once zoomed in far enough to not overlap; below that, names
  // still show on hover/tap.
  const LABEL_ZOOM_THRESHOLD = 14;
  const updateTooltipVisibility = () => {
    const show = map.getZoom() >= LABEL_ZOOM_THRESHOLD;
    Object.values(stationMarkers).forEach((m) => (show ? m.openTooltip() : m.closeTooltip()));
  };
  map.on("zoomend", updateTooltipVisibility);
  updateTooltipVisibility();

  markerPool = [];
  const trainSvg = `<div class="train-body"><svg class="train-svg" viewBox="0 0 32 16" width="28" height="14" aria-hidden="true" focusable="false">
      <ellipse class="train-shadow" cx="16" cy="13.3" rx="11" ry="1.6"></ellipse>
      <rect class="train-hull" x="2" y="2" width="26" height="10" rx="5"></rect>
      <rect class="train-window" x="6" y="4.6" width="4.6" height="4.6" rx="1.2"></rect>
      <rect class="train-window" x="12.2" y="4.6" width="4.6" height="4.6" rx="1.2"></rect>
      <rect class="train-window" x="18.4" y="4.6" width="4.6" height="4.6" rx="1.2"></rect>
      <circle class="train-light" cx="27.3" cy="7" r="1.3"></circle>
    </svg></div>`;
  for (let i = 0; i < 40; i++) {
    const icon = L.divIcon({
      className: "train-marker",
      html: trainSvg,
      iconSize: [30, 16],
      iconAnchor: [15, 8],
    });
    const m = L.marker([WEST_TERMINUS.lat, WEST_TERMINUS.lng], { icon, interactive: false, keyboard: false });
    m.addTo(map);
    m.setOpacity(0);
    markerPool.push(m);
  }

  window.addEventListener("resize", () => map.invalidateSize());
}

// Leaflet's polyline options have no inline-style hook, so the glow color
// (a CSS custom property read by the .line-glow filter in style.css) is set
// directly on the rendered <path> element.
function setGlowColor(polyline, color) {
  const el = polyline.getElement();
  if (el) el.style.setProperty("--glow-color", color);
}

function updateExtensionLineStyle(ext) {
  linePolylines.ext.setStyle(ext ? { dashArray: null, opacity: 0.95, color: "#0ea99b" } : { dashArray: "2 10", opacity: 0.6, color: "#c97a12" });
  setGlowColor(linePolylines.ext, ext ? "rgba(14,169,155,0.6)" : "rgba(201,122,18,0.5)");
  Object.entries(stationMarkers).forEach(([id, marker]) => {
    const s = STATIONS.find((st) => st.id === id);
    if (!s.extension) return;
    const el = marker.getElement();
    if (el) el.classList.toggle("station-marker--live", ext);
  });
}

/* ---------------------------------------------------------------------- *
 *  Ticking / rendering
 * ---------------------------------------------------------------------- */

let departureCache = { key: null, list: [], ramp: [] };
let lastExt = null;
let lastOpenState = null;

// Posts a short message to the hidden aria-live region — used only for
// meaningful, infrequent state changes (network open/closed, extension going
// live), never for the per-second clock/ETA updates, which would otherwise
// spam screen reader users.
function announce(msg) {
  const el = document.getElementById("a11y-announcer");
  if (el) el.textContent = msg;
}

function tick() {
  const parts = athensParts();
  const sw = resolveServiceWindow(parts);
  const ext = isExtensionActive(parts);

  renderStatusBar(parts, sw);
  renderExtensionBanner(parts, ext);
  if (ext !== lastExt) {
    updateExtensionLineStyle(ext);
    if (lastExt !== null) announce("Η επέκταση προς Καλαμαριά τέθηκε σε λειτουργία.");
    lastExt = ext;
  }
  if (sw.open !== lastOpenState) {
    if (lastOpenState !== null) announce(sw.open ? "Το δίκτυο άνοιξε." : "Το δίκτυο έκλεισε.");
    lastOpenState = sw.open;
  }

  if (!sw.open) {
    hideAllTrains();
    renderHeadwayPill(null);
    renderFleetPill(0, ext);
    if (selectedStationId) renderStationPanel(selectedStationId, null, ext);
    requestAnimationFrame(scheduleNextTick);
    return;
  }

  if (departureCache.key !== sw.dateKey) {
    const built = buildDepartures(sw.openDec, sw.closeDec, sw.dow);
    departureCache = { key: sw.dateKey, list: built.list, ramp: built.ramp };
  }

  const now = sw.nowDecAdj;
  renderHeadwayPill(headwayMinutesAt(now % 24, sw.dow));
  const activeCount = renderTrains(departureCache.list, departureCache.ramp, now, ext);
  renderFleetPill(activeCount, ext);

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
  for (const m of markerPool) m.setOpacity(0);
}

// Where is a single train (departure d, branch b) right now? Returns
// {lat,lng,direction} or null if it isn't running at `now`.
function trainStateAt(d, branch, now) {
  const j = journeyFor(d, branch);
  const brPoints = branchArray(branch);
  const brH = BRANCH_H[branch];

  if (now >= j.eastTrunkStart && now <= j.eastTrunkEnd) {
    const frac = (now - j.eastTrunkStart) / TRUNK_H;
    return { ...positionAlong(TRUNK, frac), direction: "east", dirDeg: bearingAlong(TRUNK, frac) };
  }
  if (now > j.eastTrunkEnd && now <= j.eastBranchEnd) {
    const frac = (now - j.eastBranchStart) / brH;
    return { ...positionAlong(brPoints, frac), direction: "east", dirDeg: bearingAlong(brPoints, frac) };
  }
  if (now > j.eastBranchEnd && now < j.westBranchStart) {
    // Laid over at the branch terminus.
    return { ...positionAlong(brPoints, 1), direction: "east", dirDeg: bearingAlong(brPoints, 1) };
  }
  if (now >= j.westBranchStart && now <= j.westBranchEnd) {
    const frac = 1 - (now - j.westBranchStart) / brH;
    return { ...positionAlong(brPoints, frac), direction: "west", dirDeg: (bearingAlong(brPoints, frac) + 180) % 360 };
  }
  if (now > j.westBranchEnd && now <= j.westTrunkEnd) {
    const frac = 1 - (now - j.westTrunkStart) / TRUNK_H;
    return { ...positionAlong(TRUNK, frac), direction: "west", dirDeg: (bearingAlong(TRUNK, frac) + 180) % 360 };
  }
  return null;
}

// Position of a train still on its pre-service leg from the Νέα Ελβετία
// depot to Ν.Σ.Σ. (branch A, then trunk, both westbound) — null once it's
// arrived, at which point it's just a normal entry in the departures list.
function rampTrainStateAt(insert, now) {
  if (now < insert.leaveNE || now >= insert.arriveNSS) return null;
  const branchEnd = insert.leaveNE + BRANCH_H.A;
  if (now <= branchEnd) {
    const frac = 1 - (now - insert.leaveNE) / BRANCH_H.A;
    return { ...positionAlong(PATH_A, frac), dirDeg: (bearingAlong(PATH_A, frac) + 180) % 360 };
  }
  const frac = 1 - (now - branchEnd) / TRUNK_H;
  return { ...positionAlong(TRUNK, frac), dirDeg: (bearingAlong(TRUNK, frac) + 180) % 360 };
}

function renderTrains(departures, ramp, now, ext) {
  // The headway/branch-split math can imply more trains "in the system" than
  // the real fleet has (tight peak headways leave little spare margin) — cap
  // rendering at the known fleet size rather than show more trains than exist.
  const fleetCap = Math.min(markerPool.length, FLEET.base + (ext ? FLEET.extensionExtra : 0));
  let used = 0;

  for (const insert of ramp) {
    if (used >= fleetCap) break;
    const pos = rampTrainStateAt(insert, now);
    if (!pos) continue;
    const marker = markerPool[used++];
    marker.setLatLng([pos.lat, pos.lng]);
    marker.setOpacity(1);
    const el = marker.getElement();
    if (el) {
      setTrainDirectionClass(el, "west"); // pre-service leg: westbound toward Ν.Σ.Σ.
      setTrainRotation(el, pos.dirDeg);
    }
  }

  for (let i = 0; i < departures.length; i++) {
    const d = departures[i];
    if (d > now) break;
    const branch = branchForDeparture(i, ext);
    const state = trainStateAt(d, branch, now);
    if (!state) continue;
    if (used >= fleetCap) break;
    const marker = markerPool[used++];
    marker.setLatLng([state.lat, state.lng]);
    marker.setOpacity(1);
    const el = marker.getElement();
    if (el) {
      // Color by direction + destination, not by branch alone: every
      // westbound train (heading to Ν.Σ.Σ., whether it started from Νέα
      // Ελβετία or Μίκρα) shares one color; eastbound trains are colored by
      // which branch terminus they're headed to.
      const kind = state.direction === "west" ? "west" : (branch === "B" ? "east-b" : "east-a");
      setTrainDirectionClass(el, kind);
      setTrainRotation(el, state.dirDeg);
    }
  }
  for (let i = used; i < markerPool.length; i++) markerPool[i].setOpacity(0);
  return used;
}

// Rotates the train icon's inner wrapper (never the marker's own element —
// Leaflet uses that one's `transform` for positioning, and overwriting it
// would break the marker's placement on the map).
function setTrainRotation(markerEl, dirDeg) {
  const body = markerEl.querySelector(".train-body");
  if (body) body.style.transform = `rotate(${(dirDeg - 90).toFixed(1)}deg)`;
}

// kind: "west" (-> Ν.Σ.Σ., shared by both branches), "east-a" (-> Νέα
// Ελβετία), or "east-b" (-> Μίκρα / Καλαμαριά).
function setTrainDirectionClass(markerEl, kind) {
  markerEl.classList.toggle("train-marker--dir-west", kind === "west");
  markerEl.classList.toggle("train-marker--dir-east-a", kind === "east-a");
  markerEl.classList.toggle("train-marker--dir-east-b", kind === "east-b");
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

// Formats a decimal-minute headway the way THEMA's own timetable does
// (e.g. 2.9167 -> "2:55′", 5 -> "5′").
function fmtMinSec(decMin) {
  const totalSec = Math.round(decMin * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}′` : `${m}:${String(s).padStart(2, "0")}′`;
}

function renderHeadwayPill(info) {
  const el = document.getElementById("headway-pill");
  if (info == null) {
    el.textContent = "—";
    el.className = "pill pill--muted";
    return;
  }
  const { minutes, early } = info;
  el.textContent = `${early ? "Πρωινό πρόγραμμα" : "Κανονικό πρόγραμμα"} · ανά ${fmtMinSec(minutes)}`;
  el.className = "pill " + (early ? "pill--peak" : "pill--offpeak");
}

function renderFleetPill(activeCount, ext) {
  const el = document.getElementById("fleet-pill");
  const fleetTotal = FLEET.base + (ext ? FLEET.extensionExtra : 0);
  el.textContent = `Σε κίνηση ${activeCount} / ${fleetTotal} συρμοί`;
}

function renderExtensionBanner(parts, ext) {
  const banner = document.getElementById("extension-banner");
  banner.classList.toggle("extension-banner--live", ext);
  if (ext) {
    banner.textContent = "Η επέκταση προς Καλαμαριά (5 νέοι σταθμοί από 25ης Μαρτίου) είναι σε λειτουργία.";
  } else {
    const days = daysUntilExtension(parts);
    banner.textContent = days > 0
      ? `Επέκταση Καλαμαριάς: ανοίγει σε ${days} ${days === 1 ? "ημέρα" : "ημέρες"} (27/08/2026), από τη διακλάδωση στον σταθμό 25ης Μαρτίου.`
      : "Επέκταση Καλαμαριάς: ανοίγει σήμερα.";
  }
}

/* ---------------------------------------------------------------------- *
 *  Station detail panel
 * ---------------------------------------------------------------------- */

// `openerEl` is whatever triggered the selection (a station marker or a
// quick-list button) — focus returns there when the panel closes, so
// keyboard/screen-reader users land back where they started instead of at
// the top of the page.
function selectStation(id, openerEl) {
  selectedStationId = selectedStationId === id ? null : id;
  Object.entries(stationMarkers).forEach(([sid, marker]) => {
    const el = marker.getElement();
    if (el) el.classList.toggle("station-marker--selected", sid === selectedStationId);
  });
  const panel = document.getElementById("station-panel");
  panel.hidden = !selectedStationId;
  if (selectedStationId) {
    panelOpenerEl = openerEl || panelOpenerEl;
    tick();
    // Move focus into the panel so it's announced and keyboard users don't
    // have to tab all the way there.
    document.getElementById("close-panel").focus();
  } else if (panelOpenerEl) {
    panelOpenerEl.focus();
    panelOpenerEl = null;
  }
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
 *  Disclaimer overlay — shown once per browser until dismissed.
 * ---------------------------------------------------------------------- */

const DISCLAIMER_KEY = "thess-metro-disclaimer-ack";

function setupDisclaimer() {
  const overlay = document.getElementById("disclaimer-overlay");
  const okBtn = document.getElementById("disclaimer-ok");

  let alreadyAcked = false;
  try {
    alreadyAcked = localStorage.getItem(DISCLAIMER_KEY) === "1";
  } catch (e) {
    // Storage unavailable (private mode, blocked, etc.) — just show it every time.
  }

  if (alreadyAcked) {
    overlay.hidden = true;
    return;
  }

  // Keep the rest of the page out of the tab order and the accessibility
  // tree while this (non-skippable, first-visit) dialog is open, and land
  // keyboard focus on its one actionable control.
  const background = document.querySelectorAll("body > header, body > main, body > footer");
  background.forEach((el) => el.setAttribute("inert", ""));
  okBtn.focus();

  const dismiss = () => {
    overlay.hidden = true;
    background.forEach((el) => el.removeAttribute("inert"));
    try {
      localStorage.setItem(DISCLAIMER_KEY, "1");
    } catch (e) {
      // Nothing to do — it'll just show again next visit.
    }
  };

  okBtn.addEventListener("click", dismiss);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss();
  });
}

/* ---------------------------------------------------------------------- *
 *  Keyboard-reachable station list — a non-map way to reach the same
 *  per-station info, for people who can't usefully operate the map itself
 *  (screen reader users, or anyone who can't point-and-click precisely).
 * ---------------------------------------------------------------------- */

function buildStationQuicklist() {
  const list = document.getElementById("station-quicklist-list");
  STATIONS.forEach((s) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = s.name;
    btn.addEventListener("click", () => selectStation(s.id, btn));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

/* ---------------------------------------------------------------------- *
 *  Boot
 * ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  setupDisclaimer();
  buildMap();
  buildStationQuicklist();
  document.getElementById("close-panel").addEventListener("click", () => selectStation(selectedStationId));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selectedStationId) selectStation(selectedStationId);
  });
  requestAnimationFrame(scheduleNextTick);
});
